use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use chrono::Utc;
use miyoria_kernel::ModuleContext;
use miyoria_types::{
    Action, ActionPayload, ActionSink, Event, LaneKey, MessageRef, PlatformSink, PlatformSinks,
    SpeakOutcome, TurnId, VoiceSink,
};
use parking_lot::Mutex;
use tokio::sync::Notify;
use tracing::{debug, warn};

use crate::SchedulerConfig;

struct Queued {
    seq: u64,
    action: Action,
}

struct Lane {
    queue: Vec<Queued>,
    wake: Arc<Notify>,
}

struct Inner {
    ctx: ModuleContext,
    config: SchedulerConfig,
    /// A lane is present exactly while its worker is alive.
    lanes: Mutex<HashMap<LaneKey, Lane>>,
    seq: AtomicU64,
}

/// Per-lane action queues. Cheap to clone; clones share state.
#[derive(Clone)]
pub struct Scheduler {
    inner: Arc<Inner>,
}

impl Scheduler {
    pub fn new(ctx: ModuleContext, config: SchedulerConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                ctx,
                config,
                lanes: Mutex::new(HashMap::new()),
                seq: AtomicU64::new(0),
            }),
        }
    }

    pub fn active_lanes(&self) -> Vec<LaneKey> {
        self.inner.lanes.lock().keys().cloned().collect()
    }

    /// Number of queued (not yet started) actions over all lanes.
    pub fn queued(&self) -> usize {
        self.inner
            .lanes
            .lock()
            .values()
            .map(|l| l.queue.len())
            .sum()
    }
}

#[async_trait]
impl ActionSink for Scheduler {
    async fn submit(&self, action: Action) -> anyhow::Result<()> {
        let inner = &self.inner;
        if inner.ctx.cancellation().is_cancelled() {
            anyhow::bail!("scheduler is stopped");
        }
        let seq = inner.seq.fetch_add(1, Ordering::Relaxed);
        let lane_key = action.lane.clone();
        let mut replaced = None;
        let mut spawn = None;
        {
            let mut lanes = inner.lanes.lock();
            let lane = lanes.entry(lane_key.clone()).or_insert_with(|| {
                let wake = Arc::new(Notify::new());
                spawn = Some(wake.clone());
                Lane {
                    queue: Vec::new(),
                    wake,
                }
            });
            if let Some(key) = &action.coalesce_key {
                if let Some(pos) = lane
                    .queue
                    .iter()
                    .position(|q| q.action.coalesce_key.as_ref() == Some(key))
                {
                    replaced = Some(lane.queue.swap_remove(pos).action);
                }
            }
            lane.queue.push(Queued { seq, action });
            lane.wake.notify_one();
        }
        if let Some(wake) = spawn {
            let inner = inner.clone();
            self.inner.ctx.spawn("lane", async move {
                inner.run_lane(lane_key, wake).await;
                Ok(())
            });
        }
        if let Some(old) = replaced {
            inner.complete(&old, Err("coalesced".to_owned()));
        }
        Ok(())
    }

    async fn cancel_turn(&self, turn: TurnId) -> anyhow::Result<()> {
        let mut removed = Vec::new();
        {
            let mut lanes = self.inner.lanes.lock();
            for lane in lanes.values_mut() {
                let (drop, keep): (Vec<_>, Vec<_>) = lane
                    .queue
                    .drain(..)
                    .partition(|q| q.action.turn == Some(turn));
                lane.queue = keep;
                removed.extend(drop.into_iter().map(|q| q.action));
            }
        }
        for action in &removed {
            self.inner.complete(action, Err("cancelled".to_owned()));
        }
        Ok(())
    }
}

impl Inner {
    async fn run_lane(self: Arc<Self>, lane: LaneKey, wake: Arc<Notify>) {
        let cancel = self.ctx.cancellation().clone();
        debug!(%lane, "lane worker started");
        loop {
            if cancel.is_cancelled() {
                break;
            }
            if let Some(action) = self.pop(&lane) {
                self.execute(action).await;
                continue;
            }
            tokio::select! {
                () = cancel.cancelled() => break,
                () = wake.notified() => {}
                () = tokio::time::sleep(self.config.lane_idle()) => {
                    if self.remove_if_idle(&lane) {
                        debug!(%lane, "lane worker idle, exiting");
                        return;
                    }
                }
            }
        }
        // Stopping: drop whatever is still queued in this lane.
        let leftover = self
            .lanes
            .lock()
            .remove(&lane)
            .map(|l| l.queue)
            .unwrap_or_default();
        for q in leftover {
            self.complete(&q.action, Err("cancelled".to_owned()));
        }
    }

    fn pop(&self, lane: &LaneKey) -> Option<Action> {
        let mut lanes = self.lanes.lock();
        let queue = &mut lanes.get_mut(lane)?.queue;
        let idx = queue
            .iter()
            .enumerate()
            .min_by_key(|(_, q)| (q.action.priority, q.action.created_at, q.seq))
            .map(|(i, _)| i)?;
        Some(queue.swap_remove(idx).action)
    }

    fn remove_if_idle(&self, lane: &LaneKey) -> bool {
        let mut lanes = self.lanes.lock();
        if lanes.get(lane).is_some_and(|l| l.queue.is_empty()) {
            lanes.remove(lane);
            true
        } else {
            false
        }
    }

    async fn execute(&self, action: Action) {
        if action.is_expired(Utc::now()) {
            self.complete(&action, Err("expired".to_owned()));
            return;
        }
        let target = match self.target_for(&action.payload) {
            Ok(target) => target,
            Err(error) => {
                self.complete(&action, Err(error));
                return;
            }
        };
        // Speech runs as long as playback lasts; give it more room.
        let timeout = match target {
            Target::Voice(_) => self.config.speak_timeout(),
            Target::Platform(_) => self.config.execute_timeout(),
        };
        let cancel = self.ctx.cancellation();
        let result = tokio::select! {
            r = tokio::time::timeout(timeout, run(&target, &action)) => {
                match r {
                    Ok(Ok(Outcome { message, interrupted })) => {
                        if interrupted && let Some(turn) = action.turn {
                            // The rest of an interrupted turn must not be spoken.
                            self.drop_queued_turn(&action.lane, turn);
                        }
                        Ok(message)
                    }
                    Ok(Err(e)) => Err(format!("{e:#}")),
                    Err(_) => Err("timed out".to_owned()),
                }
            }
            () = cancel.cancelled() => Err("cancelled".to_owned()),
        };
        self.complete(&action, result);
    }

    fn drop_queued_turn(&self, lane: &LaneKey, turn: TurnId) {
        let dropped: Vec<Action> = {
            let mut lanes = self.lanes.lock();
            let Some(l) = lanes.get_mut(lane) else {
                return;
            };
            let (drop, keep): (Vec<_>, Vec<_>) =
                l.queue.drain(..).partition(|q| q.action.turn == Some(turn));
            l.queue = keep;
            drop.into_iter().map(|q| q.action).collect()
        };
        for action in &dropped {
            self.complete(action, Err("cancelled".to_owned()));
        }
    }

    fn target_for(&self, payload: &ActionPayload) -> Result<Target, String> {
        if matches!(payload, ActionPayload::Speak { .. }) {
            return self
                .ctx
                .services()
                .get::<dyn VoiceSink>()
                .map(Target::Voice)
                .ok_or_else(|| "no voice sink".to_owned());
        }
        let platform = payload.platform();
        self.ctx
            .services()
            .get::<PlatformSinks>()
            .and_then(|sinks| sinks.get(platform))
            .map(Target::Platform)
            .ok_or_else(|| format!("no sink for platform {platform}"))
    }

    fn complete(&self, action: &Action, result: Result<Option<MessageRef>, String>) {
        if let Err(error) = &result {
            match error.as_str() {
                "expired" | "cancelled" | "coalesced" => {
                    debug!(action = %action.id, lane = %action.lane, %error, "action dropped");
                }
                _ => warn!(action = %action.id, lane = %action.lane, %error, "action failed"),
            }
        }
        let (ok, error, message) = match result {
            Ok(message) => (true, None, message),
            Err(error) => (false, Some(error), None),
        };
        let event = Event::ActionCompleted {
            action: action.id,
            turn: action.turn,
            ok,
            error,
            message,
        };
        self.ctx.bus().publish(self.ctx.id(), event, action.turn);
    }
}

enum Target {
    Platform(Arc<dyn PlatformSink>),
    Voice(Arc<dyn VoiceSink>),
}

#[derive(Default)]
struct Outcome {
    message: Option<MessageRef>,
    interrupted: bool,
}

async fn run(target: &Target, action: &Action) -> anyhow::Result<Outcome> {
    let sent = |message| Outcome {
        message,
        interrupted: false,
    };
    match (target, &action.payload) {
        (Target::Platform(sink), ActionPayload::SendMessage { context, message }) => sink
            .send(context, message.clone())
            .await
            .map(|m| sent(Some(m))),
        (Target::Platform(sink), ActionPayload::React { message, emoji }) => {
            sink.react(message, emoji).await.map(|()| sent(None))
        }
        (Target::Platform(sink), ActionPayload::Typing { context }) => {
            sink.typing(context).await.map(|()| sent(None))
        }
        (
            Target::Voice(voice),
            ActionPayload::Speak {
                context,
                text,
                emotion,
            },
        ) => voice
            .speak(context, text, emotion.as_deref(), action.turn)
            .await
            .map(|outcome| Outcome {
                message: None,
                interrupted: outcome == SpeakOutcome::Interrupted,
            }),
        _ => anyhow::bail!("action payload does not match its target"),
    }
}
