//! Tool registry from the app, prompt contributors, social and mood signals,
//! initiative and the LLM budget.

use miyoria_types::{
    Attitude, DecisionTrace, Mood, MoodSignals, PersonId, PromptContributor, PromptContributors,
    PromptRequest, PromptSection, SocialSignals, VoiceParticipant,
};

use super::*;
use crate::BudgetState;
use crate::signals::EXHAUSTED_LINE;

fn app() -> ModuleId {
    ModuleId::from("app")
}

/// Every decision published so far.
fn traces(h: &mut Harness) -> Vec<DecisionTrace> {
    h.drain()
        .iter()
        .filter_map(|e| match &e.event {
            Event::AgentDecision(d) => Some(d.clone()),
            _ => None,
        })
        .collect()
}

fn has_reason(trace: &DecisionTrace, prefix: &str) -> bool {
    trace.reasons.iter().any(|r| r.starts_with(prefix))
}

/// The per-turn situation message (the last one) of request `i`.
fn situation(mock: &MockProvider, i: usize) -> String {
    let requests = mock.requests();
    let msgs = &requests[i].messages;
    assert_eq!(msgs.last().unwrap().role, ChatRole::System);
    msgs.last().unwrap().content.clone()
}

// ---------------------------------------------------------------- tools

#[tokio::test(start_paused = true)]
async fn uses_the_app_tool_registry() {
    let mock = Arc::new(MockProvider::new("chat").reply("好"));
    let app_tools = Arc::new(ToolRegistry::new());
    app_tools
        .register(Arc::new(Probe::new("app_tool")))
        .unwrap();
    let setup = Setup {
        app_tools: Some(app_tools.clone()),
        tools: vec![Arc::new(Probe::new("early"))],
        ..Default::default()
    };
    let h = Harness::build("always", no_check(), mock.clone(), None, setup).await;
    // The service is still the app's, and it got `react` and the tool
    // registered on the module before start.
    let provided = h.sup.services().require::<ToolRegistry>().unwrap();
    assert!(Arc::ptr_eq(&provided, &app_tools));
    assert_eq!(app_tools.names(), ["app_tool", "early", "react"]);

    // Tools registered on the app's registry later are offered too.
    app_tools.register(Arc::new(Probe::new("later"))).unwrap();
    h.say(incoming(&channel("c"), "Owen", "嗨"));
    wait(3000).await;
    let names: Vec<String> = mock.requests()[0]
        .tools
        .iter()
        .map(|t| t.name.clone())
        .collect();
    assert_eq!(names, ["app_tool", "early", "later", "react"]);

    // Stopping the agent removes `react` but leaves the app's service.
    h.sup.disable(&ModuleId::from("agent")).await.unwrap();
    assert_eq!(app_tools.names(), ["app_tool", "early", "later"]);
    let provided = h.sup.services().require::<ToolRegistry>().unwrap();
    assert!(Arc::ptr_eq(&provided, &app_tools));
}

#[tokio::test(start_paused = true)]
async fn provides_its_own_registry_without_one_from_the_app() {
    let mock = Arc::new(MockProvider::new("chat").reply("好"));
    let h = Harness::new("always", no_check(), mock, None).await;
    let registry = h.sup.services().require::<ToolRegistry>().unwrap();
    assert_eq!(registry.names(), ["react"]);
}

// ---------------------------------------------------------------- contributors

/// Answers fixed sections after `delay` (or fails).
struct Contributor {
    key: &'static str,
    delay: Duration,
    fail: bool,
    sections: Vec<PromptSection>,
    requests: Mutex<Vec<PromptRequest>>,
}

impl Contributor {
    fn new(key: &'static str, sections: Vec<PromptSection>) -> Self {
        Self {
            key,
            delay: Duration::ZERO,
            fail: false,
            sections,
            requests: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl PromptContributor for Contributor {
    fn key(&self) -> &str {
        self.key
    }

    async fn contribute(&self, request: &PromptRequest) -> anyhow::Result<Vec<PromptSection>> {
        self.requests.lock().push(request.clone());
        tokio::time::sleep(self.delay).await;
        if self.fail {
            anyhow::bail!("database is down");
        }
        Ok(self.sections.clone())
    }
}

fn section(key: &str, title: &str, body: &str, order: i32) -> PromptSection {
    PromptSection {
        key: key.into(),
        title: title.into(),
        body: body.into(),
        order,
    }
}

#[tokio::test(start_paused = true)]
async fn contributor_sections_are_added_to_the_situation() {
    let mock = Arc::new(MockProvider::new("chat").reply("哼,當然記得"));
    let mut h = Harness::new("always", no_check(), mock.clone(), None).await;
    let registry = Arc::new(PromptContributors::new());
    h.sup.services().provide(&app(), registry.clone());

    let memory = Arc::new(Contributor::new(
        "memory",
        vec![section("memory", "你記得的事", "Owen 明天要考數學", 10)],
    ));
    let social = Arc::new(Contributor::new(
        "social",
        vec![section("social", "關係", "Owen 是你的朋友", 0)],
    ));
    let slow = Arc::new(Contributor {
        delay: Duration::from_secs(60),
        ..Contributor::new("slow", vec![section("slow", "太慢", "不該出現", 5)])
    });
    let broken = Arc::new(Contributor {
        fail: true,
        ..Contributor::new("broken", vec![section("broken", "壞掉", "不該出現", 5)])
    });
    for c in [&memory, &social, &slow, &broken] {
        registry.register(c.clone());
    }

    let c = channel("c");
    h.say(incoming(&c, "阿明", "安安"));
    wait(3000).await;
    h.drain();
    let before = mock.requests().len();
    h.say(incoming(&c, "Owen", "妳還記得我明天要幹嘛嗎"));
    // Debounce (1.5 s) plus at most the contributor timeout (0.8 s).
    wait(1500 + 700).await;
    assert_eq!(mock.requests().len(), before, "waited for the contributors");
    wait(200).await;
    assert_eq!(
        mock.requests().len(),
        before + 1,
        "slow contributor skipped"
    );
    wait(1000).await;

    let s = situation(&mock, before);
    assert!(
        s.ends_with("## 關係\nOwen 是你的朋友\n\n## 你記得的事\nOwen 明天要考數學"),
        "{s}"
    );
    assert!(!s.contains("不該出現"));

    let trace = traces(&mut h).pop().unwrap();
    assert!(trace.respond);
    assert!(
        trace
            .reasons
            .contains(&"context from: memory, social".to_owned()),
        "{:?}",
        trace.reasons
    );
    assert!(
        trace
            .reasons
            .contains(&"context skipped: broken (failed), slow (timed out)".to_owned()),
        "{:?}",
        trace.reasons
    );

    // What the contributors saw.
    let request = memory.requests.lock().last().unwrap().clone();
    assert_eq!(request.context, c);
    assert_eq!(request.profile, ProfileId("test-chan".into()));
    assert_eq!(request.speakers, [account("Owen")]);
    assert_eq!(request.query, "Owen: 妳還記得我明天要幹嘛嗎");
    assert_eq!(request.recent, ["阿明: 安安", "DeepSeek-chan: 哼,當然記得"]);
    assert!(!request.voice);
    let mut names: Vec<&str> = request
        .participants
        .iter()
        .map(|p| p.display_name.as_str())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["Owen", "阿明"]);
    // Contributors are only asked for turns she answers.
    assert_eq!(memory.requests.lock().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn contributed_context_is_capped() {
    let mock = Arc::new(MockProvider::new("chat").reply("嗯"));
    let config = serde_json::json!({
        "attention": { "llm_check": false },
        "max_context_chars": 40,
    });
    let h = Harness::new("always", config, mock.clone(), None).await;
    let registry = Arc::new(PromptContributors::new());
    h.sup.services().provide(&app(), registry.clone());
    registry.register(Arc::new(Contributor::new(
        "memory",
        vec![
            section("a", "短", "第一段", 0),
            section("b", "長", &"很長".repeat(100), 1),
        ],
    )));
    h.say(incoming(&channel("c"), "Owen", "嗨"));
    wait(3000).await;
    let s = situation(&mock, 0);
    let tail = &s[s.find("## 短").unwrap()..];
    assert_eq!(tail.chars().count(), 40, "{tail}");
    assert!(tail.ends_with('…'));
}

// ---------------------------------------------------------------- social

#[derive(Default)]
struct FakeSocial {
    attitudes: Mutex<HashMap<String, Attitude>>,
}

impl FakeSocial {
    fn set(&self, id: &str, affinity: f32, blocked: bool, call_name: Option<&str>) {
        self.attitudes.lock().insert(
            id.into(),
            Attitude {
                person: PersonId::new(),
                affinity,
                trust: 50.0,
                familiarity: 50.0,
                blocked,
                label: String::new(),
                call_name: call_name.map(str::to_owned),
            },
        );
    }
}

impl SocialSignals for FakeSocial {
    fn attitude(&self, account: &AccountRef) -> Option<Attitude> {
        self.attitudes.lock().get(&account.id).cloned()
    }
}

fn provide_social(h: &Harness) -> Arc<FakeSocial> {
    let social = Arc::new(FakeSocial::default());
    h.sup
        .services()
        .provide::<dyn SocialSignals>(&app(), social.clone());
    social
}

#[tokio::test(start_paused = true)]
async fn blocked_people_are_ignored_and_hidden() {
    let mock = Arc::new(MockProvider::new("chat").reply("嗯"));
    let mut h = Harness::new("always", no_check(), mock.clone(), None).await;
    let social = provide_social(&h);
    social.set("troll", 0.0, true, None);
    let c = channel("c");
    h.say(mention(&c, "troll", "DeepSeek 理我"));
    wait(3000).await;
    assert!(
        mock.requests().is_empty(),
        "blocked people never start a turn"
    );
    assert!(traces(&mut h).is_empty());

    h.say(incoming(&c, "Owen", "早安"));
    wait(3000).await;
    let requests = mock.requests();
    assert_eq!(requests.len(), 1);
    let history: String = requests[0]
        .messages
        .iter()
        .map(|m| m.content.as_str())
        .collect();
    assert!(!history.contains("理我"), "{history}");
    assert!(history.contains("Owen: 早安"));
}

#[tokio::test(start_paused = true)]
async fn affinity_shapes_replies_and_tone() {
    let mock = Arc::new(MockProvider::new("chat").reply("……幹嘛"));
    // Rolls 0.5: probabilities below that lose.
    let setup = Setup {
        roll: Some(0.5),
        ..Default::default()
    };
    let mut h = Harness::build("mention-only", no_check(), mock.clone(), None, setup).await;
    let social = provide_social(&h);
    social.set("rude", -50.0, false, None);
    social.set("hater", -90.0, false, None);
    social.set("Owen", 80.0, false, Some("歐文"));
    let c = channel("c");

    // Disliked, but addressed: she still answers, coldly.
    h.say(mention(&c, "rude", "喂"));
    wait(3000).await;
    assert_eq!(mock.requests().len(), 1);
    let s = situation(&mock, 0);
    assert!(s.contains("你對 rude 的態度:冷淡"), "{s}");
    let trace = traces(&mut h).pop().unwrap();
    assert!(trace.respond);
    assert!(has_reason(&trace, "affinity -50"), "{:?}", trace.reasons);

    // Very low affinity: direct address may be ignored (p 0.4 < roll 0.5).
    h.say(mention(&channel("c2"), "hater", "喂"));
    wait(3000).await;
    assert_eq!(mock.requests().len(), 1);
    let trace = traces(&mut h).pop().unwrap();
    assert!(!trace.respond);
    assert!(
        has_reason(&trace, "very low affinity"),
        "{:?}",
        trace.reasons
    );

    // Friends get a warm tone and their call name.
    h.say(mention(&channel("c3"), "Owen", "早"));
    wait(3000).await;
    let s = situation(&mock, 1);
    assert!(
        s.contains("你對 Owen 的態度:親近,你都叫對方「歐文」"),
        "{s}"
    );
}

#[tokio::test(start_paused = true)]
async fn affinity_scales_ambient_probability() {
    let mock = Arc::new(MockProvider::new("chat").reply("鯨魚最大"));
    let config = serde_json::json!({
        "attention": { "llm_check": false, "cooldown_ms": 0, "keywords": ["鯨魚"] }
    });
    let setup = Setup {
        roll: Some(0.45),
        ..Default::default()
    };
    let mut h = Harness::build("ambient", config, mock.clone(), None, setup).await;
    let social = provide_social(&h);
    social.set("friend", 100.0, false, None);
    social.set("stranger", -100.0, false, None);
    // Same message, different speakers, separate channels.
    h.say(incoming(&channel("a"), "stranger", "你們看過鯨魚嗎?"));
    wait(3000).await;
    h.say(incoming(&channel("b"), "friend", "你們看過鯨魚嗎?"));
    wait(3000).await;
    let traces = traces(&mut h);
    assert_eq!(traces.len(), 2);
    assert!(!traces[0].respond, "{:?}", traces[0].reasons);
    assert!(traces[1].respond, "{:?}", traces[1].reasons);
    assert_eq!(mock.requests().len(), 1);
}

// ---------------------------------------------------------------- mood

struct FakeMood(Mood);

impl MoodSignals for FakeMood {
    fn mood(&self) -> Mood {
        self.0
    }
}

#[tokio::test(start_paused = true)]
async fn mood_adds_a_hint() {
    let mock = Arc::new(MockProvider::new("chat").reply("好睏"));
    let h = Harness::new("always", no_check(), mock.clone(), None).await;
    h.sup.services().provide::<dyn MoodSignals>(
        &app(),
        Arc::new(FakeMood(Mood {
            valence: 0.5,
            arousal: 0.1,
            energy: 0.1,
        })),
    );
    h.say(incoming(&channel("c"), "Owen", "嗨"));
    wait(3000).await;
    let s = situation(&mock, 0);
    assert!(s.contains("- 你現在的狀態:心情不錯、平靜、有點累"), "{s}");
}

// ---------------------------------------------------------------- initiative

fn initiative(context: &ContextKey, hint: &str) -> Event {
    Event::AgentInitiative {
        context: context.clone(),
        reason: "idle_channel".into(),
        hint: hint.into(),
        about: vec![account("Owen")],
    }
}

fn ambient_config(cooldown_ms: u64) -> serde_json::Value {
    serde_json::json!({
        "attention": { "llm_check": false, "cooldown_ms": cooldown_ms },
        "voice": { "cooldown_ms": cooldown_ms }
    })
}

#[tokio::test(start_paused = true)]
async fn initiative_starts_a_turn_without_input() {
    let mock = Arc::new(MockProvider::new("chat").reply("欸,Owen,考試考得怎樣?"));
    let mut h = Harness::new("ambient", ambient_config(0), mock.clone(), None).await;
    let social = provide_social(&h);
    social.set("Owen", 60.0, false, None);
    let c = channel("c");
    h.say(incoming(&c, "Owen", "我明天要考試"));
    wait(3000).await;
    assert!(mock.requests().is_empty(), "plain chatter is not answered");
    h.drain();

    h.publish(initiative(&c, "問 Owen 考試考得怎樣"));
    wait(100).await;
    let requests = mock.requests();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].tools.is_empty(),
        "no triggering message, no tools"
    );
    let s = situation(&mock, 0);
    assert!(s.contains("是你自己想主動開啟話題"), "{s}");
    assert!(s.contains("你想到可以聊的:問 Owen 考試考得怎樣。"), "{s}");
    assert!(s.contains("你對 Owen 的態度:親近"), "{s}");
    assert_eq!(
        h.sink.sent(),
        [("欸,Owen,考試考得怎樣?".to_owned(), Priority::Initiative)]
    );
    let trace = traces(&mut h).pop().unwrap();
    assert!(trace.respond);
    assert_eq!(trace.reasons[0], "initiative:idle_channel");
}

#[tokio::test(start_paused = true)]
async fn initiative_may_stay_silent() {
    let mock = Arc::new(MockProvider::new("chat").reply("<silence/>"));
    let h = Harness::new("ambient", ambient_config(0), mock.clone(), None).await;
    h.publish(initiative(&channel("c"), ""));
    wait(100).await;
    assert_eq!(mock.requests().len(), 1);
    assert!(h.sink.sent().is_empty());
}

#[tokio::test(start_paused = true)]
async fn initiative_is_skipped_when_not_appropriate() {
    let mock = Arc::new(MockProvider::new("chat").reply("嗯"));
    let config = serde_json::json!({
        "attention": { "llm_check": false, "cooldown_ms": 60_000 },
        "channels": { "quiet": "mention-only", "dead": "off" }
    });
    let mut h = Harness::new("ambient", config, mock.clone(), None).await;
    let skipped = |h: &mut Harness| -> String {
        let trace = traces(h).pop().expect("a decision");
        assert!(!trace.respond);
        assert_eq!(trace.reasons[0], "initiative:idle_channel");
        trace.reasons[1].clone()
    };

    h.publish(initiative(&channel("quiet"), ""));
    wait(100).await;
    assert_eq!(skipped(&mut h), "skipped: mode mention-only");
    h.publish(initiative(&channel("dead"), ""));
    wait(100).await;
    assert_eq!(skipped(&mut h), "skipped: mode off");

    // A debounce is pending.
    let c = channel("c");
    h.say(mention(&c, "Owen", "DeepSeek"));
    wait(500).await;
    h.publish(initiative(&c, ""));
    wait(100).await;
    assert_eq!(skipped(&mut h), "skipped: messages are waiting for a turn");
    wait(3000).await;
    assert_eq!(mock.requests().len(), 1);
    h.drain();

    // She just spoke there.
    h.publish(initiative(&c, ""));
    wait(100).await;
    assert!(skipped(&mut h).starts_with("skipped: cooldown"));

    // Not in that voice channel.
    let vc = ContextKey {
        kind: ContextKind::Voice,
        ..channel("vc")
    };
    h.publish(initiative(&vc, ""));
    wait(100).await;
    assert_eq!(skipped(&mut h), "skipped: not in this voice channel");
    assert_eq!(mock.requests().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn initiative_is_skipped_while_a_turn_runs() {
    let slow = Arc::new(SlowProvider {
        delay: Duration::from_secs(5),
        ..Default::default()
    });
    let mut h = Harness::new("ambient", ambient_config(0), slow.clone(), None).await;
    let c = channel("c");
    h.say(mention(&c, "Owen", "DeepSeek"));
    wait(2000).await;
    h.publish(initiative(&c, ""));
    wait(100).await;
    let trace = traces(&mut h).pop().unwrap();
    assert_eq!(trace.reasons[1], "skipped: a turn is in flight");
    wait(10_000).await;
    assert_eq!(slow.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn new_message_replaces_an_initiative_turn() {
    let slow = Arc::new(SlowProvider {
        delay: Duration::from_secs(5),
        ..Default::default()
    });
    let h = Harness::new("ambient", ambient_config(0), slow.clone(), None).await;
    let c = channel("c");
    h.publish(initiative(&c, "聊天"));
    wait(1000).await;
    h.say(mention(&c, "Owen", "DeepSeek 妳在嗎"));
    wait(10_000).await;
    // The initiative turn was cancelled and the message answered instead.
    assert_eq!(slow.calls.load(Ordering::SeqCst), 2);
    assert_eq!(h.sink.sent(), [("reply 2".to_owned(), Priority::Direct)]);
    let requests = slow.requests.lock();
    assert!(
        !requests[1]
            .messages
            .last()
            .unwrap()
            .content
            .contains("主動")
    );
}

fn voice_ctx() -> ContextKey {
    ContextKey {
        kind: ContextKind::Voice,
        ..channel("vc")
    }
}

fn voice_joined() -> Event {
    let member = |id: &str, is_self| VoiceParticipant {
        account: account(id),
        display_name: id.into(),
        is_self,
        muted: false,
        deafened: false,
    };
    Event::VoiceJoined {
        context: voice_ctx(),
        participants: vec![member("Owen", false), member("her", true)],
    }
}

fn speeches(sink: &FakeSink) -> Vec<(String, Priority)> {
    sink.actions
        .lock()
        .iter()
        .filter_map(|a| match &a.payload {
            ActionPayload::Speak { text, .. } => Some((text.clone(), a.priority)),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn initiative_in_voice_is_spoken() {
    let mock = Arc::new(MockProvider::new("chat").reply("大家都好安靜喔。"));
    let h = Harness::new("ambient", ambient_config(0), mock.clone(), None).await;
    h.publish(voice_joined());
    wait(100).await;
    h.publish(initiative(&voice_ctx(), "大家都不講話"));
    wait(1000).await;
    let s = situation(&mock, 0);
    assert!(s.contains("你自己想主動用說的開個話題"), "{s}");
    assert_eq!(
        speeches(&h.sink),
        [("大家都好安靜喔。".to_owned(), Priority::Initiative)]
    );
}

// ---------------------------------------------------------------- budget

fn budget(state: &str) -> Event {
    Event::Custom {
        topic: "llm.budget".into(),
        payload: serde_json::json!({ "state": state, "spent_usd": 12.5 }),
    }
}

#[tokio::test(start_paused = true)]
async fn degraded_budget_saves_tokens() {
    let mock = Arc::new(MockProvider::new("chat").reply("嗯"));
    let config = serde_json::json!({
        "attention": { "llm_check": false, "cooldown_ms": 0, "keywords": ["鯨魚"] }
    });
    let mut h = Harness::new("ambient", config, mock.clone(), None).await;
    h.publish(budget("degraded"));
    wait(10).await;
    assert_eq!(h.handle().llm_budget(), BudgetState::Degraded);

    let c = channel("c");
    h.say(incoming(&c, "Owen", "你們看過鯨魚嗎?"));
    wait(3000).await;
    assert!(mock.requests().is_empty());
    let trace = traces(&mut h).pop().unwrap();
    assert!(!trace.respond);
    assert!(
        has_reason(&trace, "llm budget degraded: as mention-only"),
        "{:?}",
        trace.reasons
    );

    h.publish(initiative(&c, ""));
    wait(100).await;
    let trace = traces(&mut h).pop().unwrap();
    assert_eq!(trace.reasons[1], "skipped: llm budget degraded");

    // Direct address is still answered.
    h.say(mention(&c, "Owen", "鯨魚"));
    wait(3000).await;
    assert_eq!(mock.requests().len(), 1);

    // Back to normal.
    h.publish(budget("ok"));
    wait(10).await;
    assert_eq!(h.handle().llm_budget(), BudgetState::Ok);
    h.say(incoming(&channel("d"), "Owen", "你們看過鯨魚嗎?"));
    wait(3000).await;
    assert_eq!(mock.requests().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn exhausted_budget_stops_generation() {
    let mock = Arc::new(MockProvider::new("chat").reply("嗯"));
    let mut h = Harness::new("mention-only", no_check(), mock.clone(), None).await;
    h.publish(budget("broke"));
    h.publish(budget("exhausted"));
    wait(10).await;
    assert_eq!(h.handle().llm_budget(), BudgetState::Exhausted);

    let c = channel("c");
    h.say(mention(&c, "Owen", "DeepSeek"));
    wait(3000).await;
    assert_eq!(h.sink.texts(), [EXHAUSTED_LINE]);
    let trace = traces(&mut h).pop().unwrap();
    assert!(trace.respond);
    assert!(has_reason(
        &trace,
        "llm budget exhausted: out-of-energy line"
    ));

    // Once per context per hour.
    h.say(mention(&c, "Owen", "DeepSeek?"));
    wait(3000).await;
    assert_eq!(h.sink.texts().len(), 1);
    let trace = traces(&mut h).pop().unwrap();
    assert!(!trace.respond);
    h.say(mention(&channel("other"), "Owen", "DeepSeek"));
    wait(3000).await;
    assert_eq!(h.sink.texts().len(), 2);
    wait(3600 * 1000).await;
    h.say(mention(&c, "Owen", "DeepSeek!!"));
    wait(3000).await;
    assert_eq!(h.sink.texts().len(), 3);

    // Not a single model call; initiative ignored.
    h.publish(initiative(&channel("x"), ""));
    wait(100).await;
    assert!(mock.requests().is_empty());

    h.publish(budget("ok"));
    wait(10).await;
    h.say(mention(&c, "Owen", "DeepSeek"));
    wait(3000).await;
    assert_eq!(mock.requests().len(), 1);
    assert_eq!(h.sink.texts().last().unwrap(), "嗯");
}

#[tokio::test(start_paused = true)]
async fn exhausted_budget_in_voice_speaks_the_line() {
    let mock = Arc::new(MockProvider::new("chat").reply("嗯。"));
    let config = serde_json::json!({
        "attention": { "llm_check": false },
        "voice": { "default_mode": "mention-only", "cooldown_ms": 0 }
    });
    let h = Harness::new("mention-only", config, mock.clone(), None).await;
    h.publish(voice_joined());
    h.publish(budget("exhausted"));
    wait(100).await;
    h.publish(Event::VoiceUtterance(miyoria_types::VoiceUtterance {
        id: "u1".into(),
        context: voice_ctx(),
        speaker: Author {
            account: account("Owen"),
            display_name: "Owen".into(),
            is_bot: false,
        },
        text: "deepseek 妳在嗎".into(),
        language: None,
        emotion: None,
        audio_events: Vec::new(),
        started_at: chrono::Utc::now(),
        ended_at: chrono::Utc::now(),
        asr_ms: 100,
    }));
    wait(3000).await;
    assert!(mock.requests().is_empty());
    assert_eq!(
        speeches(&h.sink),
        [(EXHAUSTED_LINE.to_owned(), Priority::Direct)]
    );
}

#[tokio::test(start_paused = true)]
async fn budget_state_survives_restarts() {
    let mock = Arc::new(MockProvider::new("chat").reply("嗯"));
    let h = Harness::new("always", no_check(), mock, None).await;
    h.publish(budget("degraded"));
    wait(10).await;
    h.sup.restart(&ModuleId::from("agent")).await.unwrap();
    assert_eq!(h.handle().llm_budget(), BudgetState::Degraded);
}
