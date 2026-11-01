use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use miyoria_kernel::{EventBus, ServiceRegistry, Subscription, Supervisor, TopicFilter};
use miyoria_types::{
    Action, ActionId, ActionPayload, ActionSink, ContextKey, ContextKind, Event, LaneKey,
    MessageRef, ModuleId, OutgoingMessage, PlatformId, PlatformSink, PlatformSinks, Priority,
    TurnId,
};
use parking_lot::Mutex;
use tokio::sync::Notify;

use crate::SchedulerModule;

#[derive(Default)]
struct FakeSink {
    ops: Mutex<Vec<String>>,
    /// `typing` blocks until notified, to hold a lane busy.
    gate: Notify,
}

#[async_trait]
impl PlatformSink for FakeSink {
    fn platform(&self) -> PlatformId {
        PlatformId::new("fake")
    }

    async fn send(
        &self,
        context: &ContextKey,
        message: OutgoingMessage,
    ) -> anyhow::Result<MessageRef> {
        self.ops.lock().push(format!("send:{}", message.text));
        Ok(MessageRef {
            context: context.clone(),
            id: "m".into(),
        })
    }

    async fn react(&self, _message: &MessageRef, emoji: &str) -> anyhow::Result<()> {
        self.ops.lock().push(format!("react:{emoji}"));
        Ok(())
    }

    async fn typing(&self, _context: &ContextKey) -> anyhow::Result<()> {
        self.ops.lock().push("typing".into());
        self.gate.notified().await;
        Ok(())
    }
}

struct Harness {
    sup: Supervisor,
    module: Arc<SchedulerModule>,
    sink: Arc<FakeSink>,
    actions: Arc<dyn ActionSink>,
    completed: Subscription,
}

async fn harness(config: serde_json::Value) -> Harness {
    let services = Arc::new(ServiceRegistry::new());
    let sinks = Arc::new(PlatformSinks::new());
    let sink = Arc::new(FakeSink::default());
    sinks.register(sink.clone());
    services.provide(&ModuleId::from("app"), sinks);
    let sup = Supervisor::new(EventBus::default(), services);
    let completed = sup.bus().subscribe(TopicFilter::new(["action.completed"]));
    let module = Arc::new(SchedulerModule::new());
    sup.register(module.clone(), config, true).await;
    sup.start_all().await.unwrap();
    let actions = sup.services().require::<dyn ActionSink>().unwrap();
    Harness {
        sup,
        module,
        sink,
        actions,
        completed,
    }
}

fn context(platform: &str) -> ContextKey {
    ContextKey {
        platform: PlatformId::new(platform),
        scope: Some("g".into()),
        channel: "c".into(),
        kind: ContextKind::Channel,
    }
}

fn send(text: &str, priority: Priority) -> Action {
    let ctx = context("fake");
    Action::new(
        LaneKey::text(&ctx),
        priority,
        ActionPayload::SendMessage {
            context: ctx,
            message: OutgoingMessage {
                text: text.into(),
                reply_to: None,
            },
        },
    )
}

fn blocker() -> Action {
    let ctx = context("fake");
    Action::new(
        LaneKey::text(&ctx),
        Priority::System,
        ActionPayload::Typing { context: ctx },
    )
}

#[derive(Debug, PartialEq)]
struct Done {
    action: ActionId,
    ok: bool,
    error: Option<String>,
}

async fn next_done(sub: &mut Subscription) -> Done {
    let env = tokio::time::timeout(Duration::from_secs(30), sub.recv())
        .await
        .expect("timed out waiting for action.completed")
        .unwrap();
    match &env.event {
        Event::ActionCompleted {
            action, ok, error, ..
        } => Done {
            action: *action,
            ok: *ok,
            error: error.clone(),
        },
        other => panic!("unexpected event {other:?}"),
    }
}

/// Submits a blocking action and waits until the lane is busy with it.
async fn hold_lane(h: &Harness) {
    h.actions.submit(blocker()).await.unwrap();
    while !h.sink.ops.lock().iter().any(|o| o == "typing") {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

fn ops(h: &Harness) -> Vec<String> {
    h.sink.ops.lock().clone()
}

#[tokio::test(start_paused = true)]
async fn runs_in_priority_then_creation_order() {
    let mut h = harness(serde_json::Value::Null).await;
    hold_lane(&h).await;
    for (text, prio) in [
        ("a", Priority::Initiative),
        ("b", Priority::Direct),
        ("c", Priority::System),
        ("d", Priority::Direct),
        ("e", Priority::Idle),
    ] {
        h.actions.submit(send(text, prio)).await.unwrap();
    }
    h.sink.gate.notify_one();
    for _ in 0..6 {
        assert!(next_done(&mut h.completed).await.ok);
    }
    assert_eq!(
        ops(&h),
        ["typing", "send:c", "send:b", "send:d", "send:a", "send:e"]
    );
}

#[tokio::test(start_paused = true)]
async fn coalesces_queued_actions_with_same_key() {
    let mut h = harness(serde_json::Value::Null).await;
    hold_lane(&h).await;
    let first = send("x1", Priority::Direct).with_coalesce_key("emo");
    let first_id = first.id;
    h.actions.submit(first).await.unwrap();
    h.actions.submit(send("y", Priority::Direct)).await.unwrap();
    h.actions
        .submit(send("x2", Priority::Direct).with_coalesce_key("emo"))
        .await
        .unwrap();
    let dropped = next_done(&mut h.completed).await;
    assert_eq!(dropped.action, first_id);
    assert_eq!(dropped.error.as_deref(), Some("coalesced"));
    h.sink.gate.notify_one();
    for _ in 0..3 {
        assert!(next_done(&mut h.completed).await.ok);
    }
    assert_eq!(ops(&h), ["typing", "send:y", "send:x2"]);
}

#[tokio::test(start_paused = true)]
async fn drops_expired_actions_before_execution() {
    let mut h = harness(serde_json::Value::Null).await;
    hold_lane(&h).await;
    let mut stale = send("stale", Priority::Direct).with_ttl(Duration::from_secs(1));
    stale.created_at -= chrono::Duration::seconds(10);
    h.actions.submit(stale).await.unwrap();
    h.actions
        .submit(send("fresh", Priority::Direct))
        .await
        .unwrap();
    h.sink.gate.notify_one();
    assert!(next_done(&mut h.completed).await.ok);
    let dropped = next_done(&mut h.completed).await;
    assert!(!dropped.ok);
    assert_eq!(dropped.error.as_deref(), Some("expired"));
    assert!(next_done(&mut h.completed).await.ok);
    assert_eq!(ops(&h), ["typing", "send:fresh"]);
}

#[tokio::test(start_paused = true)]
async fn cancel_turn_removes_queued_actions_of_that_turn() {
    let mut h = harness(serde_json::Value::Null).await;
    hold_lane(&h).await;
    let (t1, t2) = (TurnId::new(), TurnId::new());
    h.actions
        .submit(send("t1a", Priority::Direct).with_turn(t1))
        .await
        .unwrap();
    h.actions
        .submit(send("t2", Priority::Direct).with_turn(t2))
        .await
        .unwrap();
    h.actions
        .submit(send("t1b", Priority::Direct).with_turn(t1))
        .await
        .unwrap();
    h.actions.cancel_turn(t1).await.unwrap();
    for _ in 0..2 {
        assert_eq!(
            next_done(&mut h.completed).await.error.as_deref(),
            Some("cancelled")
        );
    }
    h.sink.gate.notify_one();
    for _ in 0..2 {
        assert!(next_done(&mut h.completed).await.ok);
    }
    assert_eq!(ops(&h), ["typing", "send:t2"]);
}

#[tokio::test(start_paused = true)]
async fn missing_platform_sink_fails_the_action() {
    let mut h = harness(serde_json::Value::Null).await;
    let ctx = context("nowhere");
    h.actions
        .submit(Action::new(
            LaneKey::text(&ctx),
            Priority::Direct,
            ActionPayload::Typing { context: ctx },
        ))
        .await
        .unwrap();
    let done = next_done(&mut h.completed).await;
    assert!(!done.ok);
    assert_eq!(done.error.as_deref(), Some("no sink for platform nowhere"));
}

#[tokio::test(start_paused = true)]
async fn lanes_run_independently_and_idle_workers_exit() {
    let mut h = harness(serde_json::json!({ "lane_idle_ms": 1000 })).await;
    hold_lane(&h).await;
    // A different lane is not blocked by the busy one.
    let other = ContextKey {
        channel: "other".into(),
        ..context("fake")
    };
    h.actions
        .submit(Action::new(
            LaneKey::text(&other),
            Priority::Direct,
            ActionPayload::SendMessage {
                context: other.clone(),
                message: OutgoingMessage::default(),
            },
        ))
        .await
        .unwrap();
    assert!(next_done(&mut h.completed).await.ok);
    assert_eq!(h.module.active_lanes().len(), 2);

    h.sink.gate.notify_one();
    assert!(next_done(&mut h.completed).await.ok);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(h.module.active_lanes().is_empty());

    // A new submission revives the lane.
    h.actions
        .submit(send("again", Priority::Direct))
        .await
        .unwrap();
    assert!(next_done(&mut h.completed).await.ok);
    assert_eq!(ops(&h).last().unwrap(), "send:again");
}

#[tokio::test(start_paused = true)]
async fn stops_cleanly_with_work_in_flight() {
    let mut h = harness(serde_json::Value::Null).await;
    hold_lane(&h).await;
    h.actions
        .submit(send("queued", Priority::Direct))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), h.sup.stop_all())
        .await
        .expect("stop timed out");
    for _ in 0..2 {
        assert_eq!(
            next_done(&mut h.completed).await.error.as_deref(),
            Some("cancelled")
        );
    }
    assert!(
        h.actions
            .submit(send("late", Priority::Direct))
            .await
            .is_err()
    );
    assert_eq!(ops(&h), ["typing"]);
    assert!(h.module.scheduler().is_none());
}

/// Interrupts the first utterance (after `gate` is notified), completes the rest.
#[derive(Default)]
struct FakeVoice {
    spoken: Mutex<Vec<String>>,
    gate: Notify,
}

#[async_trait]
impl miyoria_types::VoiceSink for FakeVoice {
    async fn speak(
        &self,
        _context: &ContextKey,
        text: &str,
        _emotion: Option<&str>,
        _turn: Option<TurnId>,
    ) -> anyhow::Result<miyoria_types::SpeakOutcome> {
        let first = {
            let mut spoken = self.spoken.lock();
            spoken.push(text.to_owned());
            spoken.len() == 1
        };
        if first {
            self.gate.notified().await;
            Ok(miyoria_types::SpeakOutcome::Interrupted)
        } else {
            Ok(miyoria_types::SpeakOutcome::Completed)
        }
    }
}

#[tokio::test]
async fn interrupted_speech_drops_rest_of_turn() {
    let mut h = harness(serde_json::Value::Null).await;
    let voice = Arc::new(FakeVoice::default());
    h.sup
        .services()
        .provide::<dyn miyoria_types::VoiceSink>(&ModuleId::from("app"), voice.clone());
    let ctx = ContextKey {
        kind: ContextKind::Voice,
        ..context("fake")
    };
    let lane = LaneKey::voice("fake", "g");
    let speak = |text: &str, turn: TurnId| {
        Action::new(
            lane.clone(),
            Priority::Direct,
            ActionPayload::Speak {
                context: ctx.clone(),
                text: text.into(),
                emotion: None,
            },
        )
        .with_turn(turn)
    };
    let (t1, t2) = (TurnId::new(), TurnId::new());
    // "a1" holds the lane until notified, so the rest are queued behind it.
    for action in [
        speak("a1", t1),
        speak("a2", t1),
        speak("a3", t1),
        speak("b1", t2),
    ] {
        h.actions.submit(action).await.unwrap();
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    voice.gate.notify_one();
    for _ in 0..4 {
        next_done(&mut h.completed).await;
    }
    assert_eq!(*voice.spoken.lock(), vec!["a1".to_owned(), "b1".to_owned()]);
}
