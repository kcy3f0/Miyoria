//! Module tests: fake adapter tools, scripted LLMs, paused time.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use miyoria_commands::{ArgValue, CommandRegistry, Invocation, Permissions};
use miyoria_kernel::{EventBus, ServiceRegistry, Subscription, Supervisor, TopicFilter};
use miyoria_llm::{
    ChatProvider, ChatRequest, ChatStream, LlmRouter, MockProvider, ModelRef, StreamEvent,
};
use miyoria_queue::{ItemState, QueueConfig, RequestQueue, SubmitRequest};
use miyoria_tools::{Tool, ToolContext, ToolRegistry, ToolSpec};
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, Event, ModuleId, PlatformId, PromptContributors,
    PromptRequest, TurnId,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::{GameHandle, GameModule};

// ----- fakes -----

struct FakeObserve {
    text: Mutex<String>,
    calls: Mutex<u32>,
}

#[async_trait]
impl Tool for FakeObserve {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "game_minecraft_observe".into(),
            description: "查看 Minecraft 現在的狀態".into(),
            parameters: json!({ "type": "object", "properties": {} }),
        }
    }

    async fn call(&self, _ctx: &ToolContext, _args: Value) -> anyhow::Result<String> {
        *self.calls.lock() += 1;
        Ok(self.text.lock().clone())
    }
}

struct FakeAct {
    calls: Mutex<Vec<Value>>,
    contexts: Mutex<Vec<ContextKey>>,
    reply: Mutex<String>,
}

#[async_trait]
impl Tool for FakeAct {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "game_minecraft_act".into(),
            description: "在 Minecraft 裡做一個高階動作。可用動作:\n- goto:走\n- mine:挖\n- get:取得\n- chat:說話".into(),
            parameters: json!({ "type": "object", "properties": { "action": { "type": "string" } } }),
        }
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> anyhow::Result<String> {
        self.calls.lock().push(args);
        self.contexts.lock().push(ctx.context.clone());
        Ok(self.reply.lock().clone())
    }
}

/// Replies computed from the request (the user message), for tests whose
/// replies depend on the director's state.
struct FnProvider {
    reply: Box<dyn Fn(&str) -> String + Send + Sync>,
    requests: Mutex<Vec<ChatRequest>>,
}

#[async_trait]
impl ChatProvider for FnProvider {
    fn name(&self) -> &str {
        "fn"
    }

    async fn stream(&self, request: ChatRequest) -> anyhow::Result<ChatStream> {
        let user = request
            .messages
            .last()
            .map(|m| m.content.clone())
            .unwrap_or_default();
        self.requests.lock().push(request);
        let text = (self.reply)(&user);
        let events = vec![
            Ok(StreamEvent::TextDelta(text)),
            Ok(StreamEvent::Done {
                finish_reason: Some("stop".into()),
                usage: None,
            }),
        ];
        Ok(futures::stream::iter(events).boxed())
    }
}

const IDLE: &str =
    "血量 20/20\n位置 (0, 64, 0)\n\n狀態:{\"connected\":true,\"in_game\":true,\"busy\":false}";
const BUSY: &str = "血量 20/20\n位置 (5, 64, 5)\nBaritone 執行中(Mine)\n\n狀態:{\"connected\":true,\"in_game\":true,\"busy\":true}";

fn decision(goal: &str, action: Value, commentary: Option<&str>) -> String {
    json!({ "goal": goal, "goal_status": "working", "action": action, "commentary": commentary })
        .to_string()
}

fn text_ctx() -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: Some("g1".into()),
        channel: "text1".into(),
        kind: ContextKind::Channel,
    }
}

fn voice_ctx() -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: Some("g1".into()),
        channel: "voice1".into(),
        kind: ContextKind::Voice,
    }
}

fn owner() -> AccountRef {
    AccountRef {
        platform: PlatformId::new("discord"),
        id: "1".into(),
    }
}

struct Harness {
    sup: Supervisor,
    observe: Arc<FakeObserve>,
    act: Arc<FakeAct>,
    tools: Arc<ToolRegistry>,
    commands: Arc<CommandRegistry>,
    queue: Arc<RequestQueue>,
    prompts: Arc<PromptContributors>,
    initiatives: Subscription,
    moods: Subscription,
}

impl Harness {
    async fn new(provider: Arc<dyn ChatProvider>, config: Value) -> Self {
        let bus = EventBus::default();
        let services = Arc::new(ServiceRegistry::new());
        let sup = Supervisor::new(bus.clone(), services.clone());
        let app = ModuleId::from("app");
        let observe = Arc::new(FakeObserve {
            text: Mutex::new(IDLE.to_owned()),
            calls: Mutex::new(0),
        });
        let act = Arc::new(FakeAct {
            calls: Mutex::new(Vec::new()),
            contexts: Mutex::new(Vec::new()),
            reply: Mutex::new("成功:開始了".to_owned()),
        });
        let tools = Arc::new(ToolRegistry::new());
        tools.register(observe.clone()).unwrap();
        tools.register(act.clone()).unwrap();
        let commands = Arc::new(CommandRegistry::new(
            Permissions::from_strings::<&str>(&[]).unwrap(),
        ));
        let queue_bus = bus.clone();
        let queue = Arc::new(
            RequestQueue::new(QueueConfig::default()).with_publisher(Arc::new(move |e| {
                queue_bus.publish(&ModuleId::from("queue"), e, None)
            })),
        );
        let prompts = Arc::new(PromptContributors::new());
        let mut providers: HashMap<String, Arc<dyn ChatProvider>> = HashMap::new();
        providers.insert("mock".into(), provider);
        let purposes = HashMap::from([(
            "game".to_owned(),
            vec!["mock:m".parse::<ModelRef>().unwrap()],
        )]);
        services.provide(&app, tools.clone());
        services.provide(&app, commands.clone());
        services.provide(&app, queue.clone());
        services.provide(&app, prompts.clone());
        services.provide(&app, Arc::new(LlmRouter::new(providers, purposes)));
        let initiatives = bus.subscribe(TopicFilter::new(["agent.initiative"]));
        let moods = bus.subscribe(TopicFilter::new(["mood.nudge"]));
        sup.register(
            Arc::new(GameModule::new("DeepSeek醬", "傲嬌的鯨魚女孩,嘴硬心軟。")),
            config,
            true,
        )
        .await;
        sup.start_all().await.unwrap();
        Self {
            sup,
            observe,
            act,
            tools,
            commands,
            queue,
            prompts,
            initiatives,
            moods,
        }
    }

    async fn command(&self, path: &str, args: &[(&str, &str)], context: ContextKey) -> String {
        let mut inv = Invocation::new(path, owner(), context);
        inv.invoker_display_name = "Owen".into();
        for (k, v) in args {
            inv = inv.with_arg(*k, ArgValue::String((*v).to_owned()));
        }
        let reply = self.commands.dispatch(inv).await.unwrap();
        settle().await;
        reply.text
    }

    async fn start(&self) -> String {
        self.command("game start", &[("where", "here")], text_ctx())
            .await
    }

    async fn publish(&self, event: Event) {
        self.sup.bus().publish(&ModuleId::from("test"), event, None);
        settle().await;
    }

    async fn game_event(&self, kind: &str, text: &str, important: bool, extra: Value) {
        let mut data = json!({ "text": text });
        if let (Value::Object(d), Value::Object(e)) = (&mut data, extra) {
            d.extend(e);
        }
        self.publish(Event::Custom {
            topic: format!("game.minecraft.{kind}"),
            payload: json!({ "type": kind, "data": data, "important": important }),
        })
        .await;
    }

    fn acts(&self) -> Vec<Value> {
        self.act.calls.lock().clone()
    }

    fn act_names(&self) -> Vec<String> {
        self.acts()
            .iter()
            .map(|a| a["action"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    fn status(&self) -> Option<crate::GameStatus> {
        self.sup.services().get::<GameHandle>().unwrap().status()
    }

    /// Initiative hints published so far.
    async fn hints(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(Some(env)) =
            tokio::time::timeout(Duration::from_millis(1), self.initiatives.recv()).await
        {
            if let Event::AgentInitiative { hint, reason, .. } = &env.event {
                assert_eq!(reason, "game");
                out.push(hint.clone());
            }
        }
        out
    }

    async fn nudges(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(Some(env)) =
            tokio::time::timeout(Duration::from_millis(1), self.moods.recv()).await
        {
            if let Event::Custom { payload, .. } = &env.event {
                out.push(payload.clone());
            }
        }
        out
    }
}

/// Lets the director task run (paused time advances only when idle).
async fn settle() {
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(5)).await;
}

async fn secs(n: u64) {
    tokio::time::sleep(Duration::from_secs(n)).await;
    settle().await;
}

fn fn_provider(f: impl Fn(&str) -> String + Send + Sync + 'static) -> Arc<FnProvider> {
    Arc::new(FnProvider {
        reply: Box::new(f),
        requests: Mutex::new(Vec::new()),
    })
}

// ----- tests -----

#[tokio::test(start_paused = true)]
async fn decide_loop_keeps_the_goal_while_the_bot_works() {
    let mine_iron = json!({ "name": "mine", "args": { "block": "iron_ore" } });
    let wood = json!({ "name": "mine", "args": { "block": "oak_log" } });
    let llm = Arc::new(
        MockProvider::new("mock")
            .reply(&decision("挖鐵礦", mine_iron.clone(), None))
            .reply(&decision("砍樹", wood.clone(), None)),
    );
    let h = Harness::new(llm.clone(), Value::Null).await;
    let reply = h.start().await;
    assert!(reply.contains("開始玩 Minecraft"), "{reply}");

    // First decision right away: the goal action runs.
    assert_eq!(
        h.acts(),
        [json!({ "action": "mine", "args": { "block": "iron_ore" } })]
    );
    let req = &llm.requests()[0];
    assert!(req.json_mode);
    assert!(req.messages[0].content.contains("傲嬌的鯨魚女孩"));
    assert!(req.messages[0].content.contains("- mine:挖"));
    assert!(req.messages[1].content.contains("剛開始玩"));
    let goal = h.status().unwrap().goal.unwrap();
    assert_eq!(goal.text, "挖鐵礦");

    // The bot is busy: switching to another goal is refused until the goal
    // is old enough.
    *h.observe.text.lock() = BUSY.to_owned();
    secs(20).await;
    assert_eq!(llm.requests().len(), 2);
    assert!(
        llm.requests()[1].messages[1]
            .content
            .contains("目前目標:挖鐵礦")
    );
    secs(20).await;
    assert_eq!(llm.requests().len(), 3);
    assert_eq!(h.acts().len(), 1, "no goal spam while the bot works");
    assert_eq!(h.status().unwrap().goal.unwrap().text, "挖鐵礦");
    secs(20).await;
    assert_eq!(llm.requests().len(), 4);
    assert_eq!(h.acts().len(), 2);
    assert_eq!(h.acts()[1]["args"]["block"], "oak_log");
    assert_eq!(h.status().unwrap().goal.unwrap().text, "砍樹");

    // Same action again while busy: not re-issued; once idle it is.
    secs(20).await;
    assert_eq!(h.acts().len(), 2);
    *h.observe.text.lock() = IDLE.to_owned();
    secs(20).await;
    assert_eq!(h.acts().len(), 3);
    h.sup.stop_all().await;
}

#[tokio::test(start_paused = true)]
async fn queue_goals_are_consumed_and_finished() {
    let llm = fn_provider(|user| {
        if user.contains("目前目標:沒有") {
            decision("閒晃", Value::Null, None)
        } else if user.contains("蓋房子") && user.contains("目前目標:蓋房子") {
            decision(
                "蓋房子",
                json!({ "name": "goto", "args": { "x": 1, "z": 2 } }),
                None,
            )
        } else {
            decision(
                "挖鑽石",
                json!({ "name": "goto", "args": { "block": "diamond_ore" } }),
                None,
            )
        }
    });
    let mut h = Harness::new(llm.clone(), Value::Null).await;
    h.start().await;
    h.hints().await;
    assert!(h.acts().is_empty());

    let submit = |text: &str, who: &str| {
        let req = SubmitRequest::new(
            AccountRef {
                platform: PlatformId::new("discord"),
                id: who.to_owned(),
            },
            who,
            "game_goal",
            text,
        );
        h.queue.submit(req).unwrap().item.id
    };
    let first = submit("挖鑽石", "Amy");
    let second = submit("蓋房子", "Bob");
    let song = h
        .queue
        .submit(SubmitRequest::new(owner(), "Owen", "song", "唱歌"))
        .unwrap()
        .item
        .id;
    assert_eq!(h.queue.next().unwrap().id, first);
    settle().await;
    assert_eq!(h.queue.next().unwrap().id, second);
    settle().await;
    assert_eq!(h.queue.next().unwrap().id, song);
    settle().await;

    // The viewer goal is announced at once and becomes the current goal; the
    // second one waits.
    let hints = h.hints().await;
    assert_eq!(hints.len(), 1, "{hints:?}");
    assert!(hints[0].contains("觀眾 Amy 想要你:挖鑽石"), "{hints:?}");
    let status = h.status().unwrap();
    let goal = status.goal.unwrap();
    assert_eq!(
        (goal.text.as_str(), goal.queue_item),
        ("挖鑽石", Some(first))
    );
    assert_eq!(status.backlog.len(), 1);

    // An early decision (min_decide_secs after the first) acts on it.
    secs(4).await;
    assert_eq!(h.act_names(), ["goto"]);
    assert!(
        llm.requests.lock().last().unwrap().messages[1]
            .content
            .contains("觀眾 Amy 的請求")
    );

    // Events right after the action belong to the previous goal.
    h.game_event("goal_reached", "抵達目標了", false, json!({}))
        .await;
    assert_eq!(h.queue.get(first).unwrap().state, ItemState::Active);
    secs(3).await;
    h.game_event("goal_reached", "抵達目標了", false, json!({}))
        .await;
    assert_eq!(h.queue.get(first).unwrap().state, ItemState::Done);
    let hints = h.hints().await;
    assert!(
        hints.iter().any(|x| x.contains("完成了觀眾 Amy 的請求")),
        "{hints:?}"
    );

    // The next viewer goal took over; failing it skips the queue item.
    let goal = h.status().unwrap().goal.unwrap();
    assert_eq!(goal.queue_item, Some(second));
    secs(4).await;
    assert_eq!(h.acts().len(), 2);
    assert_eq!(h.acts()[1]["args"], json!({ "x": 1, "z": 2 }));
    secs(4).await;
    h.game_event("goal_failed", "找不到路,目標失敗", false, json!({}))
        .await;
    assert_eq!(h.queue.get(second).unwrap().state, ItemState::Skipped);
    assert!(h.status().unwrap().goal.is_none());
    // Other kinds are left alone.
    assert_eq!(h.queue.get(song).unwrap().state, ItemState::Active);
    h.sup.stop_all().await;
}

#[tokio::test(start_paused = true)]
async fn commentary_is_rate_limited_but_deaths_get_through() {
    let llm = Arc::new(MockProvider::new("mock").reply(&decision(
        "閒晃",
        Value::Null,
        Some("吐槽一下天氣"),
    )));
    let config = json!({ "decide_secs": 5 });
    let mut h = Harness::new(llm.clone(), config).await;
    h.start().await;
    for _ in 0..6 {
        secs(5).await;
    }
    // Decisions at 0, 5, ..., 30; commentary at most every 15 s.
    assert_eq!(llm.requests().len(), 7);
    let hints = h.hints().await;
    assert_eq!(hints.len(), 3, "{hints:?}");
    assert!(hints[0].contains("實況:吐槽一下天氣"));
    assert!(hints[0].contains("你正在直播玩 Minecraft"));

    // An important event bypasses the regular limit (only the short urgent
    // one applies).
    secs(1).await;
    h.game_event("death", "死掉了(苦力怕)", true, json!({}))
        .await;
    assert!(
        h.hints().await.is_empty(),
        "urgent limit: 1 s after the last line"
    );
    secs(3).await;
    h.game_event("death", "死掉了(苦力怕)", true, json!({}))
        .await;
    let hints = h.hints().await;
    assert_eq!(hints.len(), 1);
    assert!(hints[0].contains("剛剛死掉了(苦力怕)"), "{hints:?}");
    h.sup.stop_all().await;
}

#[tokio::test(start_paused = true)]
async fn death_nudges_mood_and_resets_goals() {
    let llm = Arc::new(MockProvider::new("mock").reply(&decision(
        "挖鐵礦",
        json!({ "name": "mine", "args": { "block": "iron_ore" } }),
        None,
    )));
    let mut h = Harness::new(llm.clone(), Value::Null).await;
    h.start().await;
    assert_eq!(h.status().unwrap().goal.unwrap().text, "挖鐵礦");
    h.nudges().await;

    // Her own goal is dropped on death...
    secs(1).await;
    h.game_event("death", "死掉了(岩漿)", true, json!({})).await;
    assert!(h.status().unwrap().goal.is_none());
    let nudges = h.nudges().await;
    assert_eq!(nudges.len(), 1);
    assert_eq!(nudges[0]["reason"], "game: death");
    assert!(nudges[0]["valence"].as_f64().unwrap() < 0.0);
    // ...and the next (early) decision picks one again.
    secs(4).await;
    assert_eq!(h.acts().len(), 2);
    assert!(
        llm.requests().last().unwrap().messages[1]
            .content
            .contains("死掉了(岩漿)")
    );

    // A commanded goal survives the death and is re-issued.
    let reply = h
        .command("game goal", &[("text", "去挖鐵礦")], text_ctx())
        .await;
    assert!(reply.contains("知道了啦"), "{reply}");
    secs(4).await;
    assert_eq!(h.acts().len(), 3);
    let goal = h.status().unwrap().goal.unwrap();
    assert_eq!(goal.text, "去挖鐵礦");
    assert!(goal.note.contains("Owen"));
    // While the bot is busy the same action is not repeated...
    *h.observe.text.lock() = BUSY.to_owned();
    secs(20).await;
    assert_eq!(h.acts().len(), 3);
    // ...but after a death the goal starts over, so it is issued again.
    h.game_event("death", "死掉了", true, json!({})).await;
    let goal = h.status().unwrap().goal.unwrap();
    assert_eq!(
        (goal.text.as_str(), goal.action.as_deref()),
        ("去挖鐵礦", None)
    );
    secs(4).await;
    assert_eq!(h.acts().len(), 4);
    let goal = h.status().unwrap().goal.unwrap();
    assert_eq!(goal.text, "去挖鐵礦");
    assert!(goal.action.is_some());

    // Achievements cheer her up.
    h.game_event("advancement", "達成成就「石器時代」", true, json!({}))
        .await;
    let nudges = h.nudges().await;
    assert!(
        nudges
            .iter()
            .any(|n| n["reason"] == "game: advancement" && n["valence"].as_f64().unwrap() > 0.0)
    );
    h.sup.stop_all().await;
}

#[tokio::test(start_paused = true)]
async fn stop_ends_the_session() {
    let llm = Arc::new(MockProvider::new("mock").reply(&decision("閒晃", Value::Null, None)));
    let h = Harness::new(llm.clone(), Value::Null).await;
    assert!(
        h.command("game stop", &[], text_ctx())
            .await
            .contains("本來就沒在玩")
    );
    assert!(
        h.command("game status", &[], text_ctx())
            .await
            .contains("沒在玩")
    );
    h.start().await;
    assert!(h.start().await.contains("已經在玩"));
    let status = h.command("game status", &[], text_ctx()).await;
    assert!(status.contains("正在玩 Minecraft"), "{status}");

    // While playing the chat prompt knows about the game.
    let section = h.prompts.all()[0]
        .contribute(&prompt_request())
        .await
        .unwrap();
    assert_eq!(section[0].key, "game");
    assert!(section[0].body.contains("你正在直播玩 Minecraft"));
    assert!(section[0].body.contains("血量 20/20"));

    let reply = h.command("game stop", &[], text_ctx()).await;
    assert!(reply.contains("收工"), "{reply}");
    assert_eq!(h.act_names(), ["stop"]);
    assert!(h.status().is_none());
    assert!(
        h.prompts.all()[0]
            .contribute(&prompt_request())
            .await
            .unwrap()
            .is_empty()
    );
    let asked = llm.requests().len();
    secs(60).await;
    assert_eq!(llm.requests().len(), asked, "no decisions after stop");

    // Stopping the module removes its commands and prompt.
    h.sup.stop_all().await;
    assert!(h.commands.specs().is_empty());
    assert!(h.prompts.all().is_empty());
}

#[tokio::test(start_paused = true)]
async fn start_checks_the_adapter_and_picks_the_context() {
    let llm = Arc::new(MockProvider::new("mock").reply(&decision("閒晃", Value::Null, None)));
    let h = Harness::new(
        llm,
        json!({ "stream_context": {
        "platform": "discord", "scope": "g2", "channel": "stream", "kind": "voice"
    } }),
    )
    .await;
    let reply = h
        .command("game start", &[("game", "terraria")], text_ctx())
        .await;
    assert!(reply.contains("找不到 terraria"), "{reply}");

    // Without a voice channel, `auto` falls back to the stream context.
    h.command("game start", &[], text_ctx()).await;
    assert_eq!(h.status().unwrap().context.channel, "stream");
    h.command("game stop", &[], text_ctx()).await;

    // In a voice channel, `auto` uses it.
    h.publish(Event::VoiceJoined {
        context: voice_ctx(),
        participants: vec![],
    })
    .await;
    h.command("game start", &[], text_ctx()).await;
    assert_eq!(h.status().unwrap().context, voice_ctx());
    h.command("game stop", &[], text_ctx()).await;
    // The final `stop` action runs with the session's context.
    assert_eq!(h.act.contexts.lock().last().cloned(), Some(voice_ctx()));

    h.publish(Event::VoiceLeft {
        context: voice_ctx(),
        reason: None,
    })
    .await;
    let reply = h
        .command("game start", &[("where", "voice")], text_ctx())
        .await;
    assert!(reply.contains("不在語音頻道"), "{reply}");
    h.sup.stop_all().await;
}

#[tokio::test(start_paused = true)]
async fn no_llm_while_the_game_is_unreachable() {
    let llm = Arc::new(MockProvider::new("mock").reply(&decision("閒晃", Value::Null, None)));
    let h = Harness::new(llm.clone(), Value::Null).await;
    *h.observe.text.lock() = "沒有連上 Minecraft。\n\n狀態:{\"connected\":false}".to_owned();
    h.start().await;
    secs(40).await;
    assert_eq!(*h.observe.calls.lock(), 3);
    assert!(llm.requests().is_empty());
    assert!(h.status().unwrap().summary.contains("沒有連上"));

    // Losing the adapter tools shows up as an observation error.
    h.tools.unregister("game_minecraft_observe");
    secs(20).await;
    assert!(h.status().unwrap().summary.contains("看不到遊戲"));
    h.sup.stop_all().await;
}

#[tokio::test(start_paused = true)]
async fn failed_actions_count_against_requested_goals() {
    let llm = Arc::new(MockProvider::new("mock").reply(&decision(
        "蓋房子",
        json!({ "name": "get", "args": { "item": "oak_planks" } }),
        None,
    )));
    let h = Harness::new(llm.clone(), json!({ "max_attempts": 2 })).await;
    *h.act.reply.lock() = "失敗:沒有安裝 AltoClef".to_owned();
    h.start().await;
    // Her own goal is not adopted when its action fails.
    assert!(h.status().unwrap().goal.is_none());
    assert!(h.status().unwrap().last_action.unwrap().contains("失敗"));

    h.command("game goal", &[("text", "蓋房子")], text_ctx())
        .await;
    secs(4).await;
    assert!(
        h.status().unwrap().goal.is_some(),
        "one failure is tolerated"
    );
    secs(4).await;
    assert!(
        h.status().unwrap().goal.is_none(),
        "gave up after two failures"
    );
    h.sup.stop_all().await;
}

fn prompt_request() -> PromptRequest {
    PromptRequest {
        profile: "p".into(),
        turn: TurnId::new(),
        context: text_ctx(),
        participants: vec![],
        speakers: vec![],
        query: "你在幹嘛".into(),
        recent: vec![],
        voice: false,
        now: chrono::Utc::now(),
    }
}
