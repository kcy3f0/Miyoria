//! Module-level tests: a real supervisor with a stub `llm` module (mock
//! providers) and a fake `scheduler` that records actions.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::{FutureExt, StreamExt};
use miyoria_commands::{ArgValue, CommandRegistry, CommandsModule, Invocation};
use miyoria_kernel::{
    EventBus, Module, ModuleContext, ModuleManifest, ServiceRegistry, Subscription, Supervisor,
    TopicFilter,
};
use miyoria_llm::{
    ChatProvider, ChatRequest, ChatRole, ChatStream, LlmRouter, MockProvider, StreamEvent, ToolSpec,
};
use miyoria_profile::{PersonaSection, Profile, ProfileManifest};
use miyoria_store::SettingsStore;
use miyoria_types::{
    AccountRef, Action, ActionPayload, ActionSink, Author, ContextKey, ContextKind, Envelope,
    Event, IncomingMessage, MessageRef, ModuleId, PlatformId, Priority, ProfileId, TurnId,
};
use parking_lot::Mutex;

use crate::{
    Activeness, AgentHandle, AgentModule, ChannelMode, PersonaHandle, RandomSource, Tool,
    ToolContext, ToolRegistry,
};

#[derive(Default)]
struct FakeSink {
    actions: Mutex<Vec<Action>>,
    cancelled: Mutex<Vec<TurnId>>,
}

impl FakeSink {
    fn sent(&self) -> Vec<(String, Priority)> {
        self.actions
            .lock()
            .iter()
            .filter_map(|a| match &a.payload {
                ActionPayload::SendMessage { message, .. } => {
                    Some((message.text.clone(), a.priority))
                }
                _ => None,
            })
            .collect()
    }

    fn texts(&self) -> Vec<String> {
        self.sent().into_iter().map(|(t, _)| t).collect()
    }

    fn reactions(&self) -> Vec<(MessageRef, String)> {
        self.actions
            .lock()
            .iter()
            .filter_map(|a| match &a.payload {
                ActionPayload::React { message, emoji } => Some((message.clone(), emoji.clone())),
                _ => None,
            })
            .collect()
    }

    fn typing(&self) -> usize {
        self.actions
            .lock()
            .iter()
            .filter(|a| matches!(a.payload, ActionPayload::Typing { .. }))
            .count()
    }
}

#[async_trait]
impl ActionSink for FakeSink {
    async fn submit(&self, action: Action) -> anyhow::Result<()> {
        self.actions.lock().push(action);
        Ok(())
    }

    async fn cancel_turn(&self, turn: TurnId) -> anyhow::Result<()> {
        self.cancelled.lock().push(turn);
        Ok(())
    }
}

struct Stub {
    manifest: ModuleManifest,
    provide: Box<dyn Fn(&ModuleContext) + Send + Sync>,
}

#[async_trait]
impl Module for Stub {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        (self.provide)(&ctx);
        Ok(())
    }
}

/// Chat provider that waits before answering `reply {n}` (n = call number).
#[derive(Default)]
struct SlowProvider {
    delay: Duration,
    calls: AtomicUsize,
    requests: Mutex<Vec<ChatRequest>>,
}

#[async_trait]
impl ChatProvider for SlowProvider {
    fn name(&self) -> &str {
        "slow"
    }

    async fn stream(&self, request: ChatRequest) -> anyhow::Result<ChatStream> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        self.requests.lock().push(request);
        let delay = self.delay;
        let first = futures::stream::once(async move {
            tokio::time::sleep(delay).await;
            Ok(StreamEvent::TextDelta(format!("reply {n}")))
        });
        let done = futures::stream::iter([Ok(StreamEvent::Done {
            finish_reason: None,
            usage: None,
        })]);
        Ok(first.chain(done).boxed())
    }
}

/// In-memory `SettingsStore` for tests.
#[derive(Default)]
struct MemorySettings {
    values: Mutex<BTreeMap<(ProfileId, String), serde_json::Value>>,
}

impl MemorySettings {
    fn value(&self, key: &str) -> Option<serde_json::Value> {
        self.values
            .lock()
            .get(&(ProfileId("test-chan".into()), key.to_owned()))
            .cloned()
    }
}

#[async_trait]
impl SettingsStore for MemorySettings {
    async fn get(
        &self,
        profile: &ProfileId,
        key: &str,
    ) -> anyhow::Result<Option<serde_json::Value>> {
        Ok(self
            .values
            .lock()
            .get(&(profile.clone(), key.to_owned()))
            .cloned())
    }

    async fn set(
        &self,
        profile: &ProfileId,
        key: &str,
        value: Option<serde_json::Value>,
    ) -> anyhow::Result<()> {
        let k = (profile.clone(), key.to_owned());
        let mut values = self.values.lock();
        match value {
            Some(v) => values.insert(k, v),
            None => values.remove(&k),
        };
        Ok(())
    }

    async fn list(
        &self,
        profile: &ProfileId,
        prefix: &str,
    ) -> anyhow::Result<BTreeMap<String, serde_json::Value>> {
        Ok(self
            .values
            .lock()
            .iter()
            .filter(|((p, k), _)| p == profile && k.starts_with(prefix))
            .map(|((_, k), v)| (k.clone(), v.clone()))
            .collect())
    }
}

/// Test tool that records its calls and answers `"done"`.
struct Probe {
    name: &'static str,
    permission: Option<&'static str>,
    delay: Duration,
    calls: Mutex<Vec<(ToolContext, serde_json::Value)>>,
}

impl Probe {
    fn new(name: &'static str) -> Self {
        Self {
            name,
            permission: None,
            delay: Duration::ZERO,
            calls: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl Tool for Probe {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name.into(),
            description: "probe".into(),
            parameters: serde_json::json!({ "type": "object" }),
        }
    }

    fn permission(&self) -> Option<&str> {
        self.permission
    }

    async fn call(&self, ctx: &ToolContext, args: serde_json::Value) -> anyhow::Result<String> {
        self.calls.lock().push((ctx.clone(), args));
        tokio::time::sleep(self.delay).await;
        Ok("done".into())
    }
}

/// Optional extras for the harness.
#[derive(Default)]
struct Setup {
    /// Run the real `commands` module with these owners.
    owners: Option<Vec<&'static str>>,
    store: Option<Arc<MemorySettings>>,
    tools: Vec<Arc<dyn Tool>>,
}

struct Fixed(f32);

impl RandomSource for Fixed {
    fn next_f32(&self) -> f32 {
        self.0
    }
}

fn profile(mode: &str) -> Profile {
    let manifest: ProfileManifest = toml::from_str(&format!(
        r#"
        id = "test-chan"
        display_name = "DeepSeek-chan"
        nicknames = ["DeepSeek", "小鯨魚"]
        [behavior]
        default_channel_mode = "{mode}"
        "#
    ))
    .unwrap();
    Profile {
        id: ProfileId("test-chan".into()),
        dir: PathBuf::new(),
        manifest,
        sections: vec![PersonaSection {
            key: "identity".into(),
            body: "你是住在深海的鯨魚娘。".into(),
        }],
        examples: Vec::new(),
        voice: None,
        avatar: None,
    }
}

struct Harness {
    sup: Supervisor,
    sink: Arc<FakeSink>,
    events: Subscription,
}

impl Harness {
    async fn new(
        mode: &str,
        config: serde_json::Value,
        chat: Arc<dyn ChatProvider>,
        fast: Option<Arc<dyn ChatProvider>>,
    ) -> Self {
        Self::build(mode, config, chat, fast, Setup::default()).await
    }

    async fn build(
        mode: &str,
        config: serde_json::Value,
        chat: Arc<dyn ChatProvider>,
        fast: Option<Arc<dyn ChatProvider>>,
        setup: Setup,
    ) -> Self {
        let sup = Supervisor::new(EventBus::default(), Arc::new(ServiceRegistry::new()));
        if let Some(store) = setup.store {
            sup.services()
                .provide::<dyn SettingsStore>(&ModuleId::from("app"), store);
        }
        if let Some(owners) = setup.owners {
            sup.register(
                Arc::new(CommandsModule::new()),
                serde_json::json!({ "owners": owners }),
                true,
            )
            .await;
        }
        let events = sup.bus().subscribe(TopicFilter::new(["agent.*"]));

        let mut providers: HashMap<String, Arc<dyn ChatProvider>> = HashMap::new();
        let mut purposes = HashMap::new();
        providers.insert("chat".into(), chat);
        purposes.insert("chat".into(), vec!["chat:m".parse().unwrap()]);
        if let Some(fast) = fast {
            providers.insert("fast".into(), fast);
            purposes.insert("fast".into(), vec!["fast:m".parse().unwrap()]);
        }
        let router = Arc::new(LlmRouter::new(providers, purposes));
        sup.register(
            Arc::new(Stub {
                manifest: ModuleManifest::new("llm", "LLM stub"),
                provide: Box::new(move |ctx| ctx.provide(router.clone())),
            }),
            serde_json::Value::Null,
            true,
        )
        .await;

        let sink = Arc::new(FakeSink::default());
        let provided = sink.clone();
        sup.register(
            Arc::new(Stub {
                manifest: ModuleManifest::new("scheduler", "Scheduler stub"),
                provide: Box::new(move |ctx| {
                    ctx.provide::<dyn ActionSink>(provided.clone());
                }),
            }),
            serde_json::Value::Null,
            true,
        )
        .await;

        let agent = AgentModule::new(profile(mode)).with_random(Arc::new(Fixed(0.0)));
        for tool in setup.tools {
            agent.tools().register(tool).unwrap();
        }
        sup.register(Arc::new(agent), config, true).await;
        sup.start_all().await.unwrap();
        Self { sup, sink, events }
    }

    fn publish(&self, event: Event) {
        self.sup
            .bus()
            .publish(&ModuleId::from("platform.test"), event, None);
    }

    fn say(&self, msg: IncomingMessage) {
        self.publish(Event::PlatformMessageCreated(msg));
    }

    fn drain(&mut self) -> Vec<Arc<Envelope>> {
        let mut out = Vec::new();
        while let Some(Some(env)) = self.events.recv().now_or_never() {
            out.push(env);
        }
        out
    }

    fn handle(&self) -> Arc<AgentHandle> {
        self.sup.services().require::<AgentHandle>().unwrap()
    }

    /// `respond` of every decision published so far.
    fn decisions(&mut self) -> Vec<bool> {
        self.drain()
            .iter()
            .filter_map(|e| match &e.event {
                Event::AgentDecision(d) => Some(d.respond),
                _ => None,
            })
            .collect()
    }
}

fn no_check() -> serde_json::Value {
    serde_json::json!({ "attention": { "llm_check": false } })
}

fn channel(id: &str) -> ContextKey {
    ContextKey {
        platform: PlatformId::new("test"),
        scope: Some("guild".into()),
        channel: id.into(),
        kind: ContextKind::Channel,
    }
}

fn account(id: &str) -> AccountRef {
    AccountRef {
        platform: PlatformId::new("test"),
        id: id.into(),
    }
}

fn incoming(ctx: &ContextKey, who: &str, text: &str) -> IncomingMessage {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::SeqCst);
    IncomingMessage {
        id: MessageRef {
            context: ctx.clone(),
            id: n.to_string(),
        },
        author: Author {
            account: account(who),
            display_name: who.into(),
            is_bot: false,
        },
        text: text.into(),
        mentions_self: false,
        reply_to_self: false,
        attachments: Vec::new(),
        // Strictly increasing, so ordering by time never ties.
        ts: chrono::Utc::now() + chrono::Duration::microseconds(n as i64),
    }
}

fn mention(ctx: &ContextKey, who: &str, text: &str) -> IncomingMessage {
    IncomingMessage {
        mentions_self: true,
        ..incoming(ctx, who, text)
    }
}

async fn wait(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

#[tokio::test(start_paused = true)]
async fn debounce_merges_messages_into_one_turn() {
    let mock = Arc::new(MockProvider::new("chat").events(vec![
        StreamEvent::ReasoningDelta("思考中……".into()),
        StreamEvent::TextDelta("<emo:annoyed>現在都中午了".into()),
        StreamEvent::TextDelta("好嗎……<emo:ne".into()),
        StreamEvent::TextDelta("utral>早啦。".into()),
        StreamEvent::Done {
            finish_reason: None,
            usage: None,
        },
    ]));
    let mut h = Harness::new("always", no_check(), mock.clone(), None).await;
    let c = channel("c");
    h.say(incoming(&c, "Owen", "早安"));
    wait(1000).await;
    h.say(incoming(&c, "Owen", "DeepSeek 在嗎"));
    wait(1000).await;
    h.say(incoming(&c, "阿明", "安安"));
    wait(1000).await;
    assert!(mock.requests().is_empty(), "turn started too early");
    wait(5000).await;

    let requests = mock.requests();
    assert_eq!(requests.len(), 1);
    let msgs = &requests[0].messages;
    // Stable persona first, history next, per-turn situation last.
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0].role, ChatRole::System);
    assert_eq!(msgs[0].content, "你是住在深海的鯨魚娘。");
    assert_eq!(msgs[1].role, ChatRole::User);
    assert_eq!(
        msgs[1].content,
        "Owen: 早安\nOwen: DeepSeek 在嗎\n阿明: 安安"
    );
    assert_eq!(msgs[2].role, ChatRole::System);
    assert!(msgs[2].content.contains("目前情境"));
    assert!(
        msgs[2].content.contains("阿明、Owen"),
        "{}",
        msgs[2].content
    );
    assert_eq!(requests[0].tools.len(), 1);
    assert_eq!(requests[0].tools[0].name, "react");

    assert_eq!(
        h.sink.sent(),
        [("現在都中午了好嗎……早啦。".to_owned(), Priority::Direct)]
    );
    assert_eq!(h.sink.typing(), 1);
    let events = h.drain();
    let topics: Vec<&str> = events.iter().map(|e| e.topic()).collect();
    assert_eq!(
        topics,
        [
            "agent.turn.started",
            "agent.decision",
            "agent.emotion",
            "agent.emotion",
            "agent.turn.completed"
        ]
    );
    let turn = events[0].correlation.unwrap();
    assert!(events.iter().all(|e| e.correlation == Some(turn)));
    let emotions: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.event {
            Event::Custom { payload, .. } => payload["emotion"].as_str().map(str::to_owned),
            _ => None,
        })
        .collect();
    assert_eq!(emotions, ["annoyed", "neutral"]);
    match &events[4].event {
        Event::AgentTurnCompleted { text, .. } => assert_eq!(text, "現在都中午了好嗎……早啦。"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn typing_extends_debounce_up_to_the_cap() {
    let mock = Arc::new(MockProvider::new("chat").reply("嗯"));
    let h = Harness::new("always", no_check(), mock.clone(), None).await;
    let c = channel("c");
    h.say(incoming(&c, "Owen", "我跟你說"));
    for _ in 0..3 {
        wait(1000).await;
        h.publish(Event::PlatformTyping {
            context: c.clone(),
            account: account("Owen"),
        });
    }
    // Without typing the turn would have started at 1.5s.
    assert!(mock.requests().is_empty());
    wait(1100).await;
    assert_eq!(mock.requests().len(), 1, "capped at max_debounce_ms");
}

#[tokio::test(start_paused = true)]
async fn mention_only_replies_only_when_addressed() {
    let mock = Arc::new(MockProvider::new("chat").reply("幹嘛"));
    let mut h = Harness::new("mention-only", no_check(), mock.clone(), None).await;
    let c = channel("c");
    h.say(incoming(&c, "Owen", "今天好熱"));
    wait(3000).await;
    assert!(mock.requests().is_empty());
    assert_eq!(h.decisions(), [false]);

    h.say(mention(&c, "Owen", "妳覺得呢"));
    wait(3000).await;
    h.say(incoming(&c, "阿明", "小鯨魚你好"));
    wait(3000).await;
    let mut reply = incoming(&c, "阿明", "嗯?");
    reply.reply_to_self = true;
    h.say(reply);
    wait(3000).await;
    let dm = ContextKey {
        scope: None,
        kind: ContextKind::Dm,
        ..channel("dm1")
    };
    h.say(incoming(&dm, "Owen", "安安"));
    wait(3000).await;
    assert_eq!(h.decisions(), [true, true, true, true]);
    assert_eq!(h.sink.texts(), ["幹嘛"; 4]);
}

#[tokio::test(start_paused = true)]
async fn off_mode_and_channel_overrides() {
    let mock = Arc::new(MockProvider::new("chat").reply("好"));
    let config = serde_json::json!({
        "attention": { "llm_check": false },
        "channels": { "loud": "always" }
    });
    let mut h = Harness::new("off", config, mock.clone(), None).await;
    h.say(mention(&channel("quiet"), "Owen", "DeepSeek!"));
    wait(3000).await;
    assert_eq!(h.decisions(), [false]);
    h.say(incoming(&channel("loud"), "Owen", "隨便聊"));
    wait(3000).await;
    assert_eq!(h.decisions(), [true]);
    assert_eq!(h.sink.texts(), ["好"]);
}

#[tokio::test(start_paused = true)]
async fn ambient_uses_fast_check_in_gray_zone() {
    let chat = Arc::new(MockProvider::new("chat").reply("鯨魚當然比較大"));
    let fast = Arc::new(
        MockProvider::new("fast")
            .reply(r#"{"respond": false, "reason": "跟她無關"}"#)
            .reply(r#"{"respond": true, "reason": "在聊她的話題"}"#),
    );
    let config = serde_json::json!({
        "attention": { "keywords": ["鯨魚"], "llm_yes_probability": 1.0, "cooldown_ms": 0 }
    });
    let mut h = Harness::new("ambient", config, chat.clone(), Some(fast.clone())).await;
    let c = channel("c");

    // Low salience: ignored without asking anyone.
    h.say(incoming(&c, "Owen", "哈哈"));
    wait(3000).await;
    assert_eq!(h.decisions(), [false]);
    assert!(fast.requests().is_empty());

    // Gray zone, fast model says no.
    h.say(incoming(&c, "Owen", "你們看過鯨魚嗎?"));
    wait(3000).await;
    assert_eq!(h.decisions(), [false]);
    assert_eq!(fast.requests().len(), 1);
    assert!(fast.requests()[0].json_mode);
    assert!(chat.requests().is_empty());

    // Gray zone, fast model says yes.
    h.say(incoming(&c, "阿明", "鯨魚跟海豚哪個大?"));
    wait(3000).await;
    assert_eq!(fast.requests().len(), 2);
    let decisions: Vec<_> = h
        .drain()
        .iter()
        .filter_map(|e| match &e.event {
            Event::AgentDecision(d) => Some(d.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(decisions.len(), 1);
    assert!(decisions[0].respond);
    assert!(
        decisions[0]
            .reasons
            .iter()
            .any(|r| r.contains("fast model: respond")),
        "{:?}",
        decisions[0].reasons
    );
    assert_eq!(
        h.sink.sent(),
        [("鯨魚當然比較大".to_owned(), Priority::Initiative)]
    );
}

#[tokio::test(start_paused = true)]
async fn own_messages_are_history_not_input() {
    let mock = Arc::new(MockProvider::new("chat").reply("早啦").reply("又怎樣"));
    let mut h = Harness::new("always", no_check(), mock.clone(), None).await;
    let c = channel("c");
    h.publish(Event::PlatformReady {
        platform: PlatformId::new("test"),
        self_account: account("her"),
    });
    h.say(incoming(&c, "her", "我先說一句"));
    wait(3000).await;
    assert!(h.decisions().is_empty());
    assert!(mock.requests().is_empty());

    h.say(incoming(&c, "Owen", "早安"));
    wait(3000).await;
    assert_eq!(h.sink.texts(), ["早啦"]);
    // The platform echoes her reply back; it must not be duplicated.
    h.say(incoming(&c, "her", "早啦"));
    h.say(incoming(&c, "Owen", "妳在幹嘛"));
    wait(3000).await;

    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    let msgs = &requests[1].messages;
    let tail: Vec<(ChatRole, &str)> = msgs[1..msgs.len() - 1]
        .iter()
        .map(|m| (m.role, m.content.as_str()))
        .collect();
    assert_eq!(
        tail,
        [
            (ChatRole::Assistant, "我先說一句"),
            (ChatRole::User, "Owen: 早安"),
            (ChatRole::Assistant, "早啦"),
            (ChatRole::User, "Owen: 妳在幹嘛"),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn undelivered_reply_is_forgotten() {
    let mock = Arc::new(MockProvider::new("chat").reply("第一句").reply("第二句"));
    let h = Harness::new("always", no_check(), mock.clone(), None).await;
    let c = channel("c");
    h.say(incoming(&c, "Owen", "嗨"));
    wait(3000).await;
    let action = h
        .sink
        .actions
        .lock()
        .iter()
        .find(|a| matches!(a.payload, ActionPayload::SendMessage { .. }))
        .map(|a| (a.id, a.turn))
        .unwrap();
    h.publish(Event::ActionCompleted {
        action: action.0,
        turn: action.1,
        ok: false,
        error: Some("expired".into()),
        message: None,
    });
    h.say(incoming(&c, "Owen", "人呢"));
    wait(3000).await;
    let requests = mock.requests();
    assert_eq!(requests[1].messages[1].content, "Owen: 嗨\nOwen: 人呢");
    assert_eq!(requests[1].messages.len(), 3);
}

#[tokio::test(start_paused = true)]
async fn silence_and_empty_replies_send_nothing() {
    let mock = Arc::new(
        MockProvider::new("chat")
            .reply("<silence/>")
            .reply("<emo:sad>   ")
            .reply("DeepSeek-chan: 好啦"),
    );
    let mut h = Harness::new("always", no_check(), mock.clone(), None).await;
    let c = channel("c");
    for text in ["一", "二", "三"] {
        h.say(incoming(&c, "Owen", text));
        wait(3000).await;
    }
    assert_eq!(mock.requests().len(), 3);
    assert_eq!(h.sink.texts(), ["好啦"]);
    assert_eq!(h.sink.typing(), 3);
    let completed: Vec<String> = h
        .drain()
        .iter()
        .filter_map(|e| match &e.event {
            Event::AgentTurnCompleted { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(completed, ["", "", "好啦"]);
}

#[tokio::test(start_paused = true)]
async fn new_message_cancels_and_regenerates() {
    let slow = Arc::new(SlowProvider {
        delay: Duration::from_secs(3),
        ..Default::default()
    });
    let mut h = Harness::new("always", no_check(), slow.clone(), None).await;
    let c = channel("c");
    h.say(incoming(&c, "Owen", "問妳喔"));
    // Turn starts at 1.5s and would finish at 4.5s.
    wait(2500).await;
    assert_eq!(slow.calls.load(Ordering::SeqCst), 1);
    h.say(incoming(&c, "Owen", "算了換個問題"));
    wait(8000).await;

    assert_eq!(slow.calls.load(Ordering::SeqCst), 2);
    assert_eq!(h.sink.texts(), ["reply 2"]);
    let second = &slow.requests.lock()[1];
    assert_eq!(
        second.messages[1].content,
        "Owen: 問妳喔\nOwen: 算了換個問題"
    );

    let events = h.drain();
    let first_turn = events[0].correlation.unwrap();
    assert_eq!(*h.sink.cancelled.lock(), [first_turn]);
    let completed: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.event {
            Event::AgentTurnCompleted { turn, text, .. } => Some((*turn, text.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(completed.len(), 2);
    assert_eq!(completed[0], (first_turn, String::new()));
    assert_eq!(completed[1].1, "reply 2");
}

#[tokio::test(start_paused = true)]
async fn message_after_submission_starts_a_follow_up_turn() {
    let slow = Arc::new(SlowProvider {
        delay: Duration::from_secs(1),
        ..Default::default()
    });
    let h = Harness::new("always", no_check(), slow.clone(), None).await;
    let c = channel("c");
    h.say(incoming(&c, "Owen", "一"));
    wait(3000).await;
    assert_eq!(h.sink.texts(), ["reply 1"]);
    h.say(incoming(&c, "Owen", "二"));
    wait(3000).await;
    assert_eq!(h.sink.texts(), ["reply 1", "reply 2"]);
    assert!(h.sink.cancelled.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn contexts_generate_concurrently() {
    let slow = Arc::new(SlowProvider {
        delay: Duration::from_secs(3),
        ..Default::default()
    });
    let h = Harness::new("always", no_check(), slow.clone(), None).await;
    h.say(incoming(&channel("a"), "Owen", "a"));
    h.say(incoming(&channel("b"), "Owen", "b"));
    // 1.5s debounce + 3s generation, in parallel.
    wait(5000).await;
    assert_eq!(h.sink.texts().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn long_replies_are_split() {
    let long = format!("{}。{}", "啊".repeat(1500), "嗯".repeat(1000));
    let mock = Arc::new(MockProvider::new("chat").reply(&long));
    let h = Harness::new("always", no_check(), mock, None).await;
    h.say(incoming(&channel("c"), "Owen", "講長一點"));
    wait(3000).await;
    let texts = h.sink.texts();
    assert_eq!(texts.len(), 2);
    assert!(texts.iter().all(|t| t.chars().count() <= 1900));
    assert_eq!(texts.concat(), long);
    let actions = h.sink.actions.lock();
    assert!(actions.iter().all(|a| a.turn.is_some()));
}

#[tokio::test(start_paused = true)]
async fn persona_edits_apply_to_the_next_turn() {
    let mock = Arc::new(MockProvider::new("chat").reply("好"));
    let h = Harness::new("always", no_check(), mock.clone(), None).await;
    let persona = h.sup.services().require::<PersonaHandle>().unwrap();
    persona.set_section("identity", "新的人格");
    persona.set_section("style", "說話很短");
    h.say(incoming(&channel("c"), "Owen", "嗨"));
    wait(3000).await;
    assert_eq!(
        mock.requests()[0].messages[0].content,
        "新的人格\n\n說話很短"
    );
}

#[tokio::test(start_paused = true)]
async fn ignores_other_bots_by_default() {
    let mock = Arc::new(MockProvider::new("chat").reply("好"));
    let mut h = Harness::new("always", no_check(), mock.clone(), None).await;
    let mut msg = incoming(&channel("c"), "otherbot", "beep");
    msg.author.is_bot = true;
    h.say(msg);
    wait(3000).await;
    assert!(h.decisions().is_empty());
    h.say(incoming(&channel("c"), "Owen", "嗨"));
    wait(3000).await;
    assert_eq!(
        mock.requests()[0].messages[1].content,
        "otherbot: beep\nOwen: 嗨"
    );
}

#[tokio::test(start_paused = true)]
async fn stops_cleanly_mid_generation() {
    let slow = Arc::new(SlowProvider {
        delay: Duration::from_secs(30),
        ..Default::default()
    });
    let h = Harness::new("always", no_check(), slow.clone(), None).await;
    h.say(incoming(&channel("c"), "Owen", "嗨"));
    wait(2000).await;
    assert_eq!(slow.calls.load(Ordering::SeqCst), 1);
    tokio::time::timeout(Duration::from_secs(1), h.sup.stop_all())
        .await
        .expect("stop timed out");
    assert!(h.sink.texts().is_empty());
}

fn done() -> StreamEvent {
    StreamEvent::Done {
        finish_reason: None,
        usage: None,
    }
}

fn tool_call(index: u32, id: Option<&str>, name: Option<&str>, args: &str) -> StreamEvent {
    StreamEvent::ToolCallDelta {
        index,
        id: id.map(str::to_owned),
        name: name.map(str::to_owned),
        arguments: args.to_owned(),
    }
}

/// Content of the last (tool result) message of request `n`.
fn last_tool_result(mock: &MockProvider, n: usize) -> String {
    let requests = mock.requests();
    let last = requests[n].messages.last().unwrap();
    assert_eq!(last.role, ChatRole::Tool);
    last.content.clone()
}

#[tokio::test(start_paused = true)]
async fn typing_is_refreshed_while_generating() {
    let slow = Arc::new(SlowProvider {
        delay: Duration::from_secs(20),
        ..Default::default()
    });
    let h = Harness::new("always", no_check(), slow, None).await;
    h.say(incoming(&channel("c"), "Owen", "想一下再回我"));
    // The turn starts at 1.5s; typing at 1.5s, 9.5s and 17.5s; reply at 21.5s.
    wait(1600).await;
    assert_eq!(h.sink.typing(), 1);
    wait(8000).await;
    assert_eq!(h.sink.typing(), 2);
    wait(15_000).await;
    assert_eq!(h.sink.texts(), ["reply 1"]);
    assert_eq!(h.sink.typing(), 3);
    wait(30_000).await;
    assert_eq!(
        h.sink.typing(),
        3,
        "typing stops once the reply is submitted"
    );
    let actions = h.sink.actions.lock();
    assert!(
        actions
            .iter()
            .filter(|a| matches!(a.payload, ActionPayload::Typing { .. }))
            .all(|a| a.coalesce_key.as_deref() == Some("typing:test:guild:c"))
    );
}

#[tokio::test(start_paused = true)]
async fn cancelled_turn_stops_typing() {
    let slow = Arc::new(SlowProvider {
        delay: Duration::from_secs(20),
        ..Default::default()
    });
    let h = Harness::new("always", no_check(), slow, None).await;
    let c = channel("c");
    h.say(incoming(&c, "Owen", "一"));
    wait(5000).await;
    assert_eq!(h.sink.typing(), 1);
    h.say(incoming(&c, "Owen", "二"));
    // The old turn is dropped at 5s (its refresh would be due at 9.5s); the
    // new one starts at 6.5s and refreshes at 14.5s.
    wait(5000).await;
    assert_eq!(h.sink.typing(), 2);
}

#[tokio::test(start_paused = true)]
async fn react_tool_round_trip() {
    let mock = Arc::new(
        MockProvider::new("chat")
            .events(vec![
                StreamEvent::TextDelta("哼,".into()),
                tool_call(0, Some("call_a"), Some("react"), "{\"emo"),
                tool_call(0, None, None, "ji\": \"🐋\"}"),
                done(),
            ])
            .reply("才不是為了你按的。"),
    );
    let mut h = Harness::new("always", no_check(), mock.clone(), None).await;
    let msg = incoming(&channel("c"), "Owen", "給我一隻鯨魚");
    let target = msg.id.clone();
    h.say(msg);
    wait(3000).await;

    assert_eq!(h.sink.reactions(), [(target, "🐋".to_owned())]);
    // Text from the tool-call response is not sent on its own.
    assert_eq!(h.sink.texts(), ["才不是為了你按的。"]);

    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    let msgs = &requests[1].messages;
    let n = msgs.len();
    assert!(msgs[n - 3].content.contains("目前情境"));
    assert_eq!(msgs[n - 2].role, ChatRole::Assistant);
    assert_eq!(msgs[n - 2].content, "哼,");
    assert_eq!(msgs[n - 2].tool_calls.len(), 1);
    assert_eq!(msgs[n - 2].tool_calls[0].id, "call_a");
    assert_eq!(msgs[n - 2].tool_calls[0].name, "react");
    assert_eq!(msgs[n - 2].tool_calls[0].arguments, "{\"emoji\": \"🐋\"}");
    assert_eq!(msgs[n - 1].tool_call_id.as_deref(), Some("call_a"));
    assert_eq!(msgs[n - 1].content, "reacted with 🐋");
    // The first request's prefix is kept, so it can be served from cache.
    assert_eq!(&msgs[..n - 2], &requests[0].messages[..]);

    let actions = h.sink.actions.lock();
    let react = actions
        .iter()
        .find(|a| matches!(a.payload, ActionPayload::React { .. }))
        .unwrap();
    assert!(react.turn.is_some());
    assert_eq!(react.lane.as_str(), "text:test:guild:c");
    drop(actions);
    let tool_events: Vec<_> = h
        .drain()
        .iter()
        .filter(|e| e.topic() == "agent.tool")
        .map(|e| match &e.event {
            Event::Custom { payload, .. } => payload.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(tool_events.len(), 1);
    assert_eq!(tool_events[0]["tool"], "react");
    assert_eq!(tool_events[0]["ok"], true);
}

#[tokio::test(start_paused = true)]
async fn text_beside_tool_calls_is_sent_once() {
    let mock = Arc::new(
        MockProvider::new("chat")
            .events(vec![
                StreamEvent::TextDelta("好啦按給你。".into()),
                tool_call(0, Some("a"), Some("react"), r#"{"emoji":"👍"}"#),
                done(),
            ])
            .reply("<silence/>")
            .events(vec![
                tool_call(0, Some("b"), Some("react"), r#"{"emoji":"😤"}"#),
                done(),
            ])
            .reply("<silence/>"),
    );
    let h = Harness::new("always", no_check(), mock.clone(), None).await;
    let c = channel("c");
    h.say(incoming(&c, "Owen", "按個讚"));
    wait(3000).await;
    assert_eq!(h.sink.texts(), ["好啦按給你。"]);
    // A reaction alone, then silence: nothing is sent.
    h.say(incoming(&c, "Owen", "哈哈"));
    wait(3000).await;
    assert_eq!(h.sink.texts(), ["好啦按給你。"]);
    let emojis: Vec<String> = h.sink.reactions().into_iter().map(|(_, e)| e).collect();
    assert_eq!(emojis, ["👍", "😤"]);
    assert_eq!(mock.requests().len(), 4);
}

#[tokio::test(start_paused = true)]
async fn tool_errors_go_back_to_the_model() {
    let probe = Arc::new(Probe::new("probe"));
    let mock = Arc::new(
        MockProvider::new("chat")
            .events(vec![
                tool_call(0, Some("x"), Some("nope"), "{}"),
                tool_call(1, Some("y"), Some("probe"), "{bad"),
                tool_call(2, None, Some("react"), r#"{"emoji":""}"#),
                done(),
            ])
            .reply("嗯?"),
    );
    let h = Harness::build(
        "always",
        no_check(),
        mock.clone(),
        None,
        Setup {
            tools: vec![probe.clone()],
            ..Default::default()
        },
    )
    .await;
    h.say(incoming(&channel("c"), "Owen", "試試看"));
    wait(3000).await;
    assert!(probe.calls.lock().is_empty());
    assert!(h.sink.reactions().is_empty());
    assert_eq!(h.sink.texts(), ["嗯?"]);
    let requests = mock.requests();
    let results: Vec<(Option<String>, String)> = requests[1]
        .messages
        .iter()
        .filter(|m| m.role == ChatRole::Tool)
        .map(|m| (m.tool_call_id.clone(), m.content.clone()))
        .collect();
    assert_eq!(results.len(), 3);
    assert_eq!(results[0].0.as_deref(), Some("x"));
    assert!(results[0].1.contains("unknown tool"), "{results:?}");
    assert!(results[1].1.contains("not valid JSON"), "{results:?}");
    assert_eq!(results[2].0.as_deref(), Some("call_2"));
    assert!(results[2].1.contains("emoji"), "{results:?}");
    let names: Vec<String> = requests[0].tools.iter().map(|t| t.name.clone()).collect();
    assert_eq!(names, ["probe", "react"]);
}

#[tokio::test(start_paused = true)]
async fn tool_permissions_follow_the_triggering_users() {
    let call = || {
        vec![
            tool_call(0, Some("p"), Some("probe"), r#"{"x": 1}"#),
            done(),
        ]
    };
    let script = |mock: MockProvider, turns: usize| {
        (0..turns).fold(mock, |m, _| m.events(call()).reply("好"))
    };

    // Without an authorizer, tools that need a permission are denied.
    let probe = Arc::new(Probe {
        permission: Some("admin.secret"),
        ..Probe::new("probe")
    });
    let mock = Arc::new(script(MockProvider::new("chat"), 1));
    let h = Harness::build(
        "always",
        no_check(),
        mock.clone(),
        None,
        Setup {
            tools: vec![probe.clone()],
            ..Default::default()
        },
    )
    .await;
    h.say(incoming(&channel("c"), "Owen", "用一下"));
    wait(3000).await;
    assert!(probe.calls.lock().is_empty());
    assert!(last_tool_result(&mock, 1).contains("permission denied"));

    // With the commands module's authorizer: owners only.
    let probe = Arc::new(Probe {
        permission: Some("admin.secret"),
        ..Probe::new("probe")
    });
    let mock = Arc::new(script(MockProvider::new("chat"), 3));
    let h = Harness::build(
        "always",
        no_check(),
        mock.clone(),
        None,
        Setup {
            owners: Some(vec!["test:Owen"]),
            tools: vec![probe.clone()],
            ..Default::default()
        },
    )
    .await;
    let c = channel("c");
    let msg = incoming(&c, "Owen", "用一下");
    let target = msg.id.clone();
    h.say(msg);
    wait(3000).await;
    assert_eq!(last_tool_result(&mock, 1), "done");
    {
        let calls = probe.calls.lock();
        assert_eq!(calls.len(), 1);
        let (ctx, args) = &calls[0];
        assert_eq!(ctx.account, account("Owen"));
        assert_eq!(ctx.message, target);
        assert_eq!(ctx.context, c);
        assert_eq!(args["x"], 1);
    }

    h.say(incoming(&c, "阿明", "我也要用"));
    wait(3000).await;
    assert!(last_tool_result(&mock, 3).contains("permission denied"));

    // A turn mixing an owner and a user is denied, whoever spoke last.
    h.say(incoming(&c, "阿明", "幫我"));
    h.say(incoming(&c, "Owen", "嗯"));
    wait(3000).await;
    assert!(last_tool_result(&mock, 5).contains("permission denied"));
    assert_eq!(probe.calls.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn tool_loop_is_bounded_and_timed_out() {
    let probe = Arc::new(Probe {
        delay: Duration::from_secs(60),
        ..Probe::new("probe")
    });
    // Always asks for another tool call.
    let mock = Arc::new(
        MockProvider::new("chat")
            .events(vec![tool_call(0, Some("p"), Some("probe"), "{}"), done()]),
    );
    let config = serde_json::json!({
        "attention": { "llm_check": false },
        "max_tool_steps": 2,
        "tool_timeout_ms": 1000,
    });
    let h = Harness::build(
        "always",
        config,
        mock.clone(),
        None,
        Setup {
            tools: vec![probe.clone()],
            ..Default::default()
        },
    )
    .await;
    h.say(incoming(&channel("c"), "Owen", "一直用"));
    wait(10_000).await;
    assert_eq!(mock.requests().len(), 3);
    assert_eq!(probe.calls.lock().len(), 2);
    assert_eq!(last_tool_result(&mock, 2), "error: timed out");
    assert!(h.sink.texts().is_empty());
}

#[tokio::test(start_paused = true)]
async fn tools_can_be_disabled() {
    let mock = Arc::new(MockProvider::new("chat").events(vec![
        StreamEvent::TextDelta("好".into()),
        tool_call(0, Some("a"), Some("react"), r#"{"emoji":"👍"}"#),
        done(),
    ]));
    let config = serde_json::json!({
        "attention": { "llm_check": false },
        "tools_enabled": false,
    });
    let h = Harness::new("always", config, mock.clone(), None).await;
    h.say(incoming(&channel("c"), "Owen", "嗨"));
    wait(3000).await;
    let requests = mock.requests();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].tools.is_empty());
    assert!(h.sink.reactions().is_empty());
    assert_eq!(h.sink.texts(), ["好"]);
}

#[tokio::test(start_paused = true)]
async fn tools_registered_later_are_offered() {
    let mock = Arc::new(MockProvider::new("chat").reply("好"));
    let h = Harness::new("always", no_check(), mock.clone(), None).await;
    let registry = h.sup.services().require::<ToolRegistry>().unwrap();
    registry.register(Arc::new(Probe::new("later"))).unwrap();
    h.say(incoming(&channel("c"), "Owen", "嗨"));
    wait(3000).await;
    assert!(registry.unregister("later"));
    h.say(incoming(&channel("c"), "Owen", "再一次"));
    wait(3000).await;
    let requests = mock.requests();
    let names =
        |i: usize| -> Vec<String> { requests[i].tools.iter().map(|t| t.name.clone()).collect() };
    assert_eq!(names(0), ["later", "react"]);
    assert_eq!(names(1), ["react"]);
}

#[tokio::test(start_paused = true)]
async fn runtime_overrides_are_applied_and_persisted() {
    let store = Arc::new(MemorySettings::default());
    store
        .set(
            &ProfileId("test-chan".into()),
            "channel_mode:test:guild:loud",
            Some(serde_json::json!("always")),
        )
        .await
        .unwrap();
    store
        .set(
            &ProfileId("test-chan".into()),
            "channel_mode:test:guild:bad",
            Some(serde_json::json!("shouty")),
        )
        .await
        .unwrap();
    let mock = Arc::new(MockProvider::new("chat").reply("好"));
    let mut h = Harness::build(
        "off",
        no_check(),
        mock,
        None,
        Setup {
            store: Some(store.clone()),
            ..Default::default()
        },
    )
    .await;
    let handle = h.handle();
    let (c, loud) = (channel("c"), channel("loud"));
    assert_eq!(handle.channel_mode(&loud), ChannelMode::Always);
    assert_eq!(handle.channel_mode(&channel("bad")), ChannelMode::Off);
    assert_eq!(handle.channel_mode(&c), ChannelMode::Off);

    h.say(incoming(&c, "Owen", "嗨"));
    wait(3000).await;
    assert_eq!(h.decisions(), [false]);

    handle
        .set_channel_mode(&c, Some(ChannelMode::Always))
        .await
        .unwrap();
    assert_eq!(handle.channel_mode_override(&c), Some(ChannelMode::Always));
    assert_eq!(
        store.value("channel_mode:test:guild:c"),
        Some(serde_json::json!("always"))
    );
    h.say(incoming(&c, "Owen", "嗨嗨"));
    wait(3000).await;
    assert_eq!(h.decisions(), [true]);
    assert_eq!(h.sink.texts(), ["好"]);

    handle.set_channel_mode(&c, None).await.unwrap();
    assert_eq!(handle.channel_mode(&c), ChannelMode::Off);
    assert_eq!(store.value("channel_mode:test:guild:c"), None);

    assert_eq!(handle.activeness(&c), Activeness::Medium);
    handle
        .set_activeness(&c, Some(Activeness::High))
        .await
        .unwrap();
    assert_eq!(handle.activeness(&c), Activeness::High);
    assert_eq!(handle.activeness(&loud), Activeness::Medium);
    assert_eq!(
        store.value("activeness:test:guild:c"),
        Some(serde_json::json!("high"))
    );

    // Reloaded after a restart.
    h.sup.restart(&ModuleId::from("agent")).await.unwrap();
    let handle = h.handle();
    assert_eq!(handle.activeness(&c), Activeness::High);
    assert_eq!(handle.channel_mode(&loud), ChannelMode::Always);
    assert_eq!(handle.channel_mode(&c), ChannelMode::Off);
}

#[tokio::test(start_paused = true)]
async fn overrides_survive_restarts_without_a_store() {
    let mock = Arc::new(MockProvider::new("chat").reply("好"));
    let h = Harness::new("off", no_check(), mock, None).await;
    let c = channel("c");
    h.handle()
        .set_channel_mode(&c, Some(ChannelMode::Ambient))
        .await
        .unwrap();
    h.sup.restart(&ModuleId::from("agent")).await.unwrap();
    assert_eq!(h.handle().channel_mode(&c), ChannelMode::Ambient);
}

fn command(path: &str, who: &str, args: &[(&str, &str)]) -> Invocation {
    Invocation {
        path: path.split(' ').map(str::to_owned).collect(),
        args: args
            .iter()
            .map(|(k, v)| ((*k).to_owned(), ArgValue::String((*v).to_owned())))
            .collect(),
        invoker: account(who),
        invoker_display_name: who.into(),
        context: channel("c"),
        invoker_is_guild_admin: false,
    }
}

#[tokio::test(start_paused = true)]
async fn agent_commands() {
    let mock = Arc::new(MockProvider::new("chat").reply("好"));
    let h = Harness::build(
        "ambient",
        no_check(),
        mock,
        None,
        Setup {
            owners: Some(vec!["test:Owen"]),
            ..Default::default()
        },
    )
    .await;
    let reg = h.sup.services().require::<CommandRegistry>().unwrap();
    let handle = h.handle();
    let c = channel("c");
    let run = |inv: Invocation| {
        let reg = reg.clone();
        async move { reg.dispatch(inv).await.unwrap() }
    };

    let shown = run(command("mode", "Owen", &[])).await;
    assert!(
        shown.text.contains("`ambient`") && shown.text.contains("預設"),
        "{}",
        shown.text
    );

    let denied = run(command("mode", "阿明", &[("mode", "off")])).await;
    assert!(denied.text.contains("權限"), "{}", denied.text);
    assert_eq!(handle.channel_mode(&c), ChannelMode::Ambient);

    let bad = run(command("mode", "Owen", &[("mode", "loud")])).await;
    assert!(bad.ephemeral);

    run(command("mode", "Owen", &[("mode", "mention-only")])).await;
    assert_eq!(handle.channel_mode(&c), ChannelMode::MentionOnly);
    let shown = run(command("mode", "Owen", &[])).await;
    assert!(shown.text.contains("`mention-only`") && shown.text.contains("特別設定"));
    let reset = run(command("mode", "Owen", &[("mode", "reset")])).await;
    assert!(reset.text.contains("`ambient`"), "{}", reset.text);
    assert_eq!(handle.channel_mode_override(&c), None);

    run(command("activeness", "Owen", &[("level", "high")])).await;
    assert_eq!(handle.activeness(&c), Activeness::High);
    let shown = run(command("activeness", "Owen", &[])).await;
    assert!(shown.text.contains("`high`"), "{}", shown.text);
    run(command("activeness", "Owen", &[("level", "reset")])).await;
    assert_eq!(handle.activeness_override(&c), None);

    let persona = run(command("persona show", "Owen", &[])).await;
    assert!(persona.ephemeral);
    assert!(
        persona.text.contains("`identity`:11 字"),
        "{}",
        persona.text
    );
    let denied = run(command("persona show", "阿明", &[])).await;
    assert!(denied.text.contains("權限"));

    // A restarted `commands` module gets the agent commands again.
    h.sup.restart(&ModuleId::from("commands")).await.unwrap();
    wait(10).await;
    let fresh = h.sup.services().require::<CommandRegistry>().unwrap();
    assert!(!Arc::ptr_eq(&reg, &fresh));
    let mode_path = vec!["mode".to_owned()];
    assert!(fresh.get(&mode_path).is_some());

    // Stopping the agent removes them.
    h.sup.disable(&ModuleId::from("agent")).await.unwrap();
    assert!(fresh.get(&mode_path).is_none());
    assert!(
        fresh
            .get(&["persona".to_owned(), "show".to_owned()])
            .is_none()
    );
    assert!(fresh.get(&["ping".to_owned()]).is_some());
}
