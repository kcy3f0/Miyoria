//! Initiative engine (module `initiative`).
//!
//! Decides *when* she starts talking on her own and publishes
//! `agent.initiative` events; the agent decides what to say (and checks
//! channel modes). Triggers:
//!
//! - **idle_channel**: a lively conversation she took part in went quiet.
//! - **followup**: a due [`FollowupSource`] item and its person is around.
//! - **greeting**: a friend's first message of the day.
//! - **voice_join**: someone with good affinity joined her voice channel.
//!
//! Every initiative passes a budget (per-context and global daily caps),
//! never interrupts an active conversation and adapts: when nobody answers
//! her initiative in a context, that context's idle threshold doubles (and
//! relaxes again with replies and with time). Mood energy shortens or
//! lengthens the idle threshold.
//!
//! Optional services: `dyn SocialSignals` (needed for greeting, voice_join
//! and followups of a person), `dyn MoodSignals`, `dyn FollowupSource` and
//! `dyn SettingsStore` (persists counters and backoff under profile
//! `_global`, key `initiative:state`).

pub mod clock;
pub mod config;
pub mod engine;

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest, Subscription, TopicFilter};
use miyoria_store::SettingsStore;
use miyoria_types::{FollowupSource, MoodSignals, ProfileId, SocialSignals};
use tokio::time::{MissedTickBehavior, interval_at};
use tracing::{debug, info, warn};

pub use clock::{Clock, SystemClock, TokioClock};
pub use config::InitiativeConfig;
pub use engine::{Blocked, Emission, Engine, Signals, Snapshot};

/// Settings key of the persisted state.
pub const STATE_KEY: &str = "initiative:state";
/// Profile under which the state is stored.
pub const STATE_PROFILE: &str = "_global";

const STORE_TIMEOUT: Duration = Duration::from_secs(5);

/// Module `initiative`; `profile` selects whose followups are polled.
pub struct InitiativeModule {
    manifest: ModuleManifest,
    profile: ProfileId,
    clock: Arc<dyn Clock>,
}

impl InitiativeModule {
    pub const ID: &'static str = "initiative";

    pub fn new(profile: ProfileId) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Initiative")
                .description("Decides when she starts a conversation on her own")
                .optional("memory")
                .optional("social")
                .optional("mood"),
            profile,
            clock: Arc::new(SystemClock),
        }
    }

    /// Replaces the time source (tests).
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }
}

#[async_trait]
impl Module for InitiativeModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: InitiativeConfig = ctx.config()?;
        let mut engine = Engine::new(config.clone());
        let store = ctx.services().get::<dyn SettingsStore>();
        if let Some(store) = &store {
            match tokio::time::timeout(STORE_TIMEOUT, load_state(store.as_ref())).await {
                Ok(Ok(Some(snapshot))) => {
                    info!("restored initiative counters");
                    engine.restore(snapshot);
                }
                Ok(Ok(None)) => {}
                Ok(Err(e)) => warn!(error = %format!("{e:#}"), "could not load initiative state"),
                Err(_) => warn!("loading initiative state timed out"),
            }
        }
        let events = ctx.subscribe(TopicFilter::new([
            "platform.ready",
            "platform.message.created",
            "voice.joined",
            "voice.left",
            "voice.participants",
            "voice.utterance",
            "voice.playback",
        ]));
        let runner = Runner {
            ctx: ctx.clone(),
            engine,
            tick: Duration::from_secs(config.tick_secs.max(1)),
            profile: self.profile.clone(),
            clock: self.clock.clone(),
            store,
            failed_marks: HashSet::new(),
        };
        ctx.spawn("initiative", runner.run(events));
        Ok(())
    }
}

async fn load_state(store: &dyn SettingsStore) -> anyhow::Result<Option<Snapshot>> {
    let value = store
        .get(&ProfileId::from(STATE_PROFILE), STATE_KEY)
        .await?;
    Ok(value.map(serde_json::from_value).transpose()?)
}

struct Runner {
    ctx: ModuleContext,
    engine: Engine,
    tick: Duration,
    profile: ProfileId,
    clock: Arc<dyn Clock>,
    store: Option<Arc<dyn SettingsStore>>,
    /// Followups published whose `mark_done` failed; never publish twice.
    failed_marks: HashSet<String>,
}

impl Runner {
    async fn run(mut self, mut events: Subscription) -> anyhow::Result<()> {
        let mut ticker = interval_at(tokio::time::Instant::now() + self.tick, self.tick);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                () = self.ctx.cancellation().cancelled() => break,
                env = events.recv() => {
                    let Some(env) = env else { break };
                    let social = self.ctx.services().get::<dyn SocialSignals>();
                    let mood = self.ctx.services().get::<dyn MoodSignals>();
                    let sig = Signals { social: social.as_deref(), mood: mood.as_deref() };
                    for e in self.engine.observe(self.clock.now(), &env.event, &sig) {
                        self.publish(e);
                    }
                }
                _ = ticker.tick() => self.on_tick().await,
            }
            self.persist().await;
        }
        self.persist().await;
        Ok(())
    }

    fn publish(&self, emission: Emission) {
        self.ctx.publish(emission.into_event());
    }

    async fn on_tick(&mut self) {
        let now = self.clock.now();
        let social = self.ctx.services().get::<dyn SocialSignals>();
        let mood = self.ctx.services().get::<dyn MoodSignals>();
        let sig = Signals {
            social: social.as_deref(),
            mood: mood.as_deref(),
        };
        for e in self.engine.tick(now, &sig) {
            self.publish(e);
        }
        let Some(source) = self.ctx.services().get::<dyn FollowupSource>() else {
            return;
        };
        let due = match tokio::time::timeout(STORE_TIMEOUT, source.due(&self.profile, now)).await {
            Ok(Ok(due)) => due,
            Ok(Err(e)) => {
                warn!(error = %format!("{e:#}"), "could not fetch due followups");
                return;
            }
            Err(_) => {
                warn!("fetching due followups timed out");
                return;
            }
        };
        for followup in due {
            if self.failed_marks.contains(&followup.id) {
                continue;
            }
            let Some(emission) = self.engine.plan_followup(now, &followup, &sig) else {
                continue;
            };
            self.publish(emission);
            if let Err(e) = source.mark_done(&followup.id).await {
                warn!(id = %followup.id, error = %format!("{e:#}"), "could not mark followup done");
                self.failed_marks.insert(followup.id);
            } else {
                debug!(id = %followup.id, "followup brought up");
            }
        }
    }

    async fn persist(&mut self) {
        let Some(store) = &self.store else { return };
        let Some(snapshot) = self.engine.take_snapshot() else {
            return;
        };
        let value = match serde_json::to_value(&snapshot) {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "could not serialize initiative state");
                return;
            }
        };
        let profile = ProfileId::from(STATE_PROFILE);
        let write = store.set(&profile, STATE_KEY, Some(value));
        match tokio::time::timeout(STORE_TIMEOUT, write).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => warn!(error = %format!("{e:#}"), "could not save initiative state"),
            Err(_) => warn!("saving initiative state timed out"),
        }
    }
}
