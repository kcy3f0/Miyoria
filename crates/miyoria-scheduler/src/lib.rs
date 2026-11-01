//! Action scheduler (module `scheduler`).
//!
//! Everything that produces output submits [`Action`](miyoria_types::Action)s
//! to the [`ActionSink`] this module provides. Each [`LaneKey`] gets its own
//! worker that runs the lane's actions one at a time, most urgent first, and
//! executes them through the [`PlatformSinks`](miyoria_types::PlatformSinks)
//! service. Idle lane workers exit, so lanes cost nothing while quiet.

mod scheduler;

#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest};
use miyoria_types::{ActionSink, LaneKey};
use parking_lot::Mutex;
use serde::Deserialize;

pub use scheduler::Scheduler;

/// `[modules.scheduler]` config section.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct SchedulerConfig {
    /// A lane worker with nothing queued exits after this long.
    pub lane_idle_ms: u64,
    /// A single action that takes longer than this fails with `timed out`.
    pub execute_timeout_ms: u64,
    /// Timeout for `Speak` actions, which last as long as the playback.
    pub speak_timeout_ms: u64,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            lane_idle_ms: 60_000,
            execute_timeout_ms: 30_000,
            speak_timeout_ms: 120_000,
        }
    }
}

impl SchedulerConfig {
    pub fn lane_idle(&self) -> Duration {
        Duration::from_millis(self.lane_idle_ms)
    }

    pub fn execute_timeout(&self) -> Duration {
        Duration::from_millis(self.execute_timeout_ms)
    }

    pub fn speak_timeout(&self) -> Duration {
        Duration::from_millis(self.speak_timeout_ms)
    }
}

/// Module `scheduler`: provides `Arc<dyn ActionSink>`.
pub struct SchedulerModule {
    manifest: ModuleManifest,
    current: Mutex<Option<Scheduler>>,
}

impl SchedulerModule {
    pub const ID: &'static str = "scheduler";

    pub fn new() -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Action scheduler")
                .description("Per-lane output queues with priority, TTL and coalescing"),
            current: Mutex::new(None),
        }
    }

    /// The scheduler of the current run, if the module is running.
    pub fn scheduler(&self) -> Option<Scheduler> {
        self.current.lock().clone()
    }

    /// Lanes that currently have a worker.
    pub fn active_lanes(&self) -> Vec<LaneKey> {
        self.scheduler()
            .map(|s| s.active_lanes())
            .unwrap_or_default()
    }
}

impl Default for SchedulerModule {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Module for SchedulerModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: SchedulerConfig = ctx.config()?;
        let scheduler = Scheduler::new(ctx.clone(), config);
        ctx.provide::<dyn ActionSink>(Arc::new(scheduler.clone()));
        *self.current.lock() = Some(scheduler);
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        self.current.lock().take();
        Ok(())
    }
}
