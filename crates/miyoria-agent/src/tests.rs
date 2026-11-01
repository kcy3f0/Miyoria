//! Module-level tests: a real supervisor with a stub `llm` module (mock
//! providers) and a fake `scheduler` that records actions.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::{FutureExt, StreamExt};
use miyoria_kernel::{
    EventBus, Module, ModuleContext, ModuleManifest, ServiceRegistry, Subscription, Supervisor,
    TopicFilter,
};
use miyoria_llm::{
    ChatProvider, ChatRequest, ChatRole, ChatStream, LlmRouter, MockProvider, StreamEvent,
};
use miyoria_profile::{PersonaSection, Profile, ProfileManifest};
use miyoria_types::{
    AccountRef, Action, ActionPayload, ActionSink, Author, ContextKey, ContextKind, Envelope,
    Event, IncomingMessage, MessageRef, ModuleId, PlatformId, Priority, ProfileId, TurnId,
};
use parking_lot::Mutex;

use crate::{AgentModule, PersonaHandle, RandomSource};

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
        let sup = Supervisor::new(EventBus::default(), Arc::new(ServiceRegistry::new()));
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
    assert_eq!(msgs[0].role, ChatRole::System);
    assert_eq!(msgs[0].content, "你是住在深海的鯨魚娘。");
    assert_eq!(msgs[1].role, ChatRole::System);
    assert!(msgs[1].content.contains("目前情境"));
    assert!(
        msgs[1].content.contains("阿明、Owen"),
        "{}",
        msgs[1].content
    );
    assert_eq!(msgs.len(), 3);
    assert_eq!(
        msgs[2].content,
        "Owen: 早安\nOwen: DeepSeek 在嗎\n阿明: 安安"
    );

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
    let tail: Vec<(ChatRole, &str)> = requests[1].messages[2..]
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
    });
    h.say(incoming(&c, "Owen", "人呢"));
    wait(3000).await;
    let requests = mock.requests();
    assert_eq!(requests[1].messages[2].content, "Owen: 嗨\nOwen: 人呢");
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
        second.messages[2].content,
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
        mock.requests()[0].messages[2].content,
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
