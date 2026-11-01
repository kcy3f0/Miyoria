//! Module `memory`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration as StdDuration;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use miyoria_commands::CommandRegistry;
use miyoria_kernel::{
    Health, Module, ModuleContext, ModuleManifest, ServiceRegistry, Subscription, TopicFilter,
};
use miyoria_llm::LlmRouter;
use miyoria_store::{MemoryRecordStore, MessageLog, PeopleStore, SettingsStore, Store};
use miyoria_tools::ToolRegistry;
use miyoria_types::{Authorizer, ContextKey, Event, FollowupSource, ProfileId, PromptContributors};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::commands::{AuthorizerLookup, MemoryCommands};
use crate::config::{EmbeddingConfig, MemoryConfig};
use crate::contributor::{CONTRIBUTOR_KEY, MemoryContributor};
use crate::embed::{Embedder, build_embedder};
use crate::engine::MemoryEngine;
use crate::tools::{RECALL, REMEMBER, RecallTool, RememberTool};

/// Module `memory` (requires `llm`, optional `commands`).
///
/// Services used: `LlmRouter`, `dyn MemoryRecordStore` (else `Store::memories`),
/// and optionally `dyn MessageLog`, `dyn PeopleStore`, `dyn SettingsStore`
/// (each else the `Store` field), `PromptContributors`, `ToolRegistry`,
/// `CommandRegistry`, `dyn Authorizer`.
///
/// Provides `Arc<MemoryEngine>` and `Arc<dyn FollowupSource>`; registers the
/// prompt contributor `memory`, the tools `remember` / `recall` and the
/// `memory` commands (re-checked periodically, so start order does not matter).
pub struct MemoryModule {
    manifest: ModuleManifest,
    profile: ProfileId,
    embedding: EmbeddingConfig,
    embedder: Option<Arc<dyn Embedder>>,
    records: Option<Arc<dyn MemoryRecordStore>>,
    installer: Arc<Installer>,
    degraded: Mutex<Option<String>>,
}

impl MemoryModule {
    pub const ID: &'static str = "memory";

    /// `embedding` is the top-level `[memory.embedding]` section.
    pub fn new(profile: ProfileId, embedding: EmbeddingConfig) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Memory")
                .description("Long-term memory: consolidation, recall, followups")
                .requires("llm")
                .optional("commands"),
            profile,
            embedding,
            embedder: None,
            records: None,
            installer: Arc::new(Installer::default()),
            degraded: Mutex::new(None),
        }
    }

    /// Uses this embedder instead of building one from config.
    #[must_use]
    pub fn with_embedder(mut self, embedder: Arc<dyn Embedder>) -> Self {
        self.embedder = Some(embedder);
        self
    }

    /// Uses this record store instead of looking one up.
    #[must_use]
    pub fn with_records(mut self, records: Arc<dyn MemoryRecordStore>) -> Self {
        self.records = Some(records);
        self
    }
}

#[async_trait]
impl Module for MemoryModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: MemoryConfig = ctx.config()?;
        let services = ctx.services();
        let store = services.get::<Store>();
        let router = services.require::<LlmRouter>()?;
        let records = self
            .records
            .clone()
            .or_else(|| services.get::<dyn MemoryRecordStore>())
            .or_else(|| store.as_ref().map(|s| s.memories.clone()))
            .ok_or_else(|| anyhow::anyhow!("no memory record store (`dyn MemoryRecordStore`)"))?;
        let messages = services
            .get::<dyn MessageLog>()
            .or_else(|| store.as_ref().map(|s| s.messages.clone()));
        let people = services
            .get::<dyn PeopleStore>()
            .or_else(|| store.as_ref().map(|s| s.people.clone()));
        let settings = services
            .get::<dyn SettingsStore>()
            .or_else(|| store.as_ref().map(|s| s.settings.clone()));
        let embedder = match &self.embedder {
            Some(e) => e.clone(),
            None => build_embedder(&self.embedding)?,
        };
        *self.degraded.lock() = messages
            .is_none()
            .then(|| "no message log: consolidation is off".to_owned());

        let engine = Arc::new(
            MemoryEngine::new(self.profile.clone(), config.clone(), records)
                .with_embedder(embedder.clone())
                .with_people(people)
                .with_messages(messages)
                .with_settings(settings)
                .with_router(Some(router)),
        );
        ctx.provide(engine.clone());
        ctx.provide::<dyn FollowupSource>(engine.clone());
        self.installer.install(&ctx, &engine);
        info!(embedder = embedder.name(), "memory started");

        let installer = self.installer.clone();
        let task_ctx = ctx.clone();
        let task_engine = engine.clone();
        // Subscribe before returning so no message published after start is missed.
        let sub = ctx.subscribe(TopicFilter::new([
            "platform.message.created",
            "voice.utterance",
        ]));
        ctx.spawn("consolidate", async move {
            consolidation_loop(task_ctx, task_engine, installer, sub).await;
            Ok(())
        });
        if config.forgetting.enabled {
            let cancel = ctx.cancellation().clone();
            ctx.spawn("forget", async move {
                maintenance_loop(engine, cancel).await;
                Ok(())
            });
        }
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        self.installer.uninstall();
        Ok(())
    }

    async fn health(&self) -> Health {
        match self.degraded.lock().clone() {
            Some(reason) => Health::Degraded(reason),
            None => Health::Healthy,
        }
    }
}

/// Registers the contributor, tools and commands into whatever registries
/// exist now; idempotent.
#[derive(Default)]
struct Installer {
    contributors: Mutex<Option<Arc<PromptContributors>>>,
    tools: Mutex<Option<Arc<ToolRegistry>>>,
    commands: MemoryCommands,
}

impl Installer {
    fn install(&self, ctx: &ModuleContext, engine: &Arc<MemoryEngine>) {
        let services: &ServiceRegistry = ctx.services();
        if let Some(reg) = services.get::<PromptContributors>() {
            let mut slot = self.contributors.lock();
            if !slot.as_ref().is_some_and(|r| Arc::ptr_eq(r, &reg)) {
                if let Some(old) = slot.take() {
                    old.unregister(CONTRIBUTOR_KEY);
                }
                reg.register(Arc::new(MemoryContributor::new(engine.clone())));
                *slot = Some(reg);
            }
        }
        if let Some(reg) = services.get::<ToolRegistry>() {
            let mut slot = self.tools.lock();
            if !slot.as_ref().is_some_and(|r| Arc::ptr_eq(r, &reg)) {
                if let Some(old) = slot.take() {
                    old.unregister(REMEMBER);
                    old.unregister(RECALL);
                }
                let ok = reg
                    .register(Arc::new(RememberTool::new(engine.clone())))
                    .and_then(|()| reg.register(Arc::new(RecallTool::new(engine.clone()))));
                match ok {
                    Ok(()) => *slot = Some(reg),
                    Err(e) => warn!(error = %format!("{e:#}"), "could not register memory tools"),
                }
            }
        }
        if let Some(reg) = services.get::<CommandRegistry>() {
            let c = ctx.clone();
            let lookup: AuthorizerLookup = Arc::new(move || c.services().get::<dyn Authorizer>());
            self.commands.install(reg, engine.clone(), lookup);
        }
    }

    fn uninstall(&self) {
        if let Some(reg) = self.contributors.lock().take() {
            reg.unregister(CONTRIBUTOR_KEY);
        }
        if let Some(reg) = self.tools.lock().take() {
            reg.unregister(REMEMBER);
            reg.unregister(RECALL);
        }
        self.commands.uninstall();
    }
}

/// Per-context activity since the last consolidation.
#[derive(Clone, Debug)]
pub struct Activity {
    pub pending: usize,
    pub last: DateTime<Utc>,
    pub retry_at: Option<DateTime<Utc>>,
}

/// Decides which contexts to consolidate.
#[derive(Debug, Default)]
pub struct ActivityTracker {
    contexts: HashMap<ContextKey, Activity>,
}

impl ActivityTracker {
    pub fn message(&mut self, context: ContextKey, at: DateTime<Utc>) {
        let a = self.contexts.entry(context).or_insert(Activity {
            pending: 0,
            last: at,
            retry_at: None,
        });
        a.pending += 1;
        a.last = a.last.max(at);
    }

    /// A context that may have unconsolidated lines from before a restart.
    pub fn maybe_pending(&mut self, context: ContextKey) {
        self.contexts.entry(context).or_insert(Activity {
            pending: 1,
            last: DateTime::<Utc>::UNIX_EPOCH,
            retry_at: None,
        });
    }

    /// Contexts idle for `consolidate_idle_secs` or with
    /// `consolidate_every_messages` pending lines.
    pub fn due(&self, now: DateTime<Utc>, config: &MemoryConfig) -> Vec<ContextKey> {
        let idle =
            Duration::seconds(i64::try_from(config.consolidate_idle_secs).unwrap_or(i64::MAX / 2));
        self.contexts
            .iter()
            .filter(|(_, a)| {
                a.pending > 0
                    && a.retry_at.is_none_or(|r| now >= r)
                    && (a.pending >= config.consolidate_every_messages.max(1)
                        || now - a.last >= idle)
            })
            .map(|(c, _)| c.clone())
            .collect()
    }

    pub fn done(&mut self, context: &ContextKey) {
        self.contexts.remove(context);
    }

    pub fn failed(&mut self, context: &ContextKey, retry_at: DateTime<Utc>) {
        if let Some(a) = self.contexts.get_mut(context) {
            a.retry_at = Some(retry_at);
        }
    }

    pub fn pending(&self, context: &ContextKey) -> usize {
        self.contexts.get(context).map_or(0, |a| a.pending)
    }
}

async fn consolidation_loop(
    ctx: ModuleContext,
    engine: Arc<MemoryEngine>,
    installer: Arc<Installer>,
    mut sub: Subscription,
) {
    let config = engine.config().clone();
    let cancel = ctx.cancellation().clone();
    let mut tracker = ActivityTracker::default();
    for context in engine.watermarked_contexts().await {
        tracker.maybe_pending(context);
    }
    let mut tick = tokio::time::interval(StdDuration::from_secs(config.tick_secs.max(1)));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            env = sub.recv() => {
                let Some(env) = env else { return };
                match &env.event {
                    Event::PlatformMessageCreated(m) => tracker.message(m.context().clone(), Utc::now()),
                    Event::VoiceUtterance(u) => tracker.message(u.context.clone(), Utc::now()),
                    _ => {}
                }
            }
            _ = tick.tick() => {
                installer.install(&ctx, &engine);
                if !engine.can_consolidate() {
                    continue;
                }
                let now = Utc::now();
                for context in tracker.due(now, &config) {
                    if cancel.is_cancelled() {
                        return;
                    }
                    match engine.consolidate(&context, now).await {
                        Ok(report) => {
                            if report.inserted + report.reinforced + report.superseded > 0 {
                                info!(%context, ?report, "memories consolidated");
                            }
                            tracker.done(&context);
                        }
                        Err(e) => {
                            warn!(%context, error = %format!("{e:#}"), "consolidation failed, will retry");
                            let retry = Duration::seconds(i64::try_from(config.retry_secs).unwrap_or(120));
                            tracker.failed(&context, now + retry);
                        }
                    }
                }
            }
        }
    }
}

async fn maintenance_loop(engine: Arc<MemoryEngine>, cancel: CancellationToken) {
    let every = Duration::hours(
        i64::try_from(engine.config().forgetting.interval_hours.max(1)).unwrap_or(24),
    );
    let start = tokio::time::Instant::now() + StdDuration::from_secs(60);
    let mut tick = tokio::time::interval_at(start, StdDuration::from_secs(600));
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            _ = tick.tick() => {
                let now = Utc::now();
                if engine.last_maintenance_run().await.is_some_and(|last| now - last < every) {
                    continue;
                }
                match engine.maintain(now).await {
                    Ok(report) => info!(?report, "memory maintenance done"),
                    Err(e) => warn!(error = %format!("{e:#}"), "memory maintenance failed"),
                }
            }
        }
    }
}
