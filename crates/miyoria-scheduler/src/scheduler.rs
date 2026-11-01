use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use chrono::Utc;
use miyoria_kernel::ModuleContext;
use miyoria_types::{
    Action, ActionPayload, ActionSink, Event, LaneKey, PlatformSink, PlatformSinks, TurnId,
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
        let platform = action.payload.platform();
        let sink = self
            .ctx
            .services()
            .get::<PlatformSinks>()
            .and_then(|sinks| sinks.get(platform));
        let Some(sink) = sink else {
            let error = format!("no sink for platform {platform}");
            self.complete(&action, Err(error));
            return;
        };
        let cancel = self.ctx.cancellation();
        let result = tokio::select! {
            r = tokio::time::timeout(self.config.execute_timeout(), run(&*sink, &action.payload)) => {
                match r {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(e)) => Err(format!("{e:#}")),
                    Err(_) => Err("timed out".to_owned()),
                }
            }
            () = cancel.cancelled() => Err("cancelled".to_owned()),
        };
        self.complete(&action, result);
    }

    fn complete(&self, action: &Action, result: Result<(), String>) {
        if let Err(error) = &result {
            match error.as_str() {
                "expired" | "cancelled" | "coalesced" => {
                    debug!(action = %action.id, lane = %action.lane, %error, "action dropped");
                }
                _ => warn!(action = %action.id, lane = %action.lane, %error, "action failed"),
            }
        }
        let event = Event::ActionCompleted {
            action: action.id,
            turn: action.turn,
            ok: result.is_ok(),
            error: result.err(),
        };
        self.ctx.bus().publish(self.ctx.id(), event, action.turn);
    }
}

async fn run(sink: &dyn PlatformSink, payload: &ActionPayload) -> anyhow::Result<()> {
    match payload {
        ActionPayload::SendMessage { context, message } => {
            sink.send(context, message.clone()).await.map(drop)
        }
        ActionPayload::React { message, emoji } => sink.react(message, emoji).await,
        ActionPayload::Typing { context } => sink.typing(context).await,
    }
}
