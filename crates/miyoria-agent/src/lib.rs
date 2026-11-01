//! Cognition core (module `agent`).
//!
//! Turns `platform.*` and `voice.*` events into replies: each conversation
//! context (text channel, DM or voice channel) keeps a
//! [`Session`](session::Session), a coordinator debounces messages into turns,
//! [attention](attention) decides whether to respond, and the reply is
//! generated through the `chat` LLM purpose (with an optional
//! [tool loop](tools)), parsed by the [expression parser](expression) and
//! submitted to the scheduler. In voice channels the reply is cut into
//! [sentences](speech) that are spoken (`Speak` actions) while the model is
//! still generating.

pub mod attention;
pub mod config;
pub mod expression;
pub mod handle;
pub mod persona;
pub mod prompt;
pub mod session;
pub mod speech;
pub mod tools;

mod commands;
mod coordinator;
mod runtime;
mod turn;

#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest};
use miyoria_profile::Profile;
use miyoria_store::SettingsStore;
use parking_lot::RwLock;
use tracing::{info, warn};

pub use attention::{RandomSource, SeededRandom};
pub use config::{Activeness, AgentConfig, AttentionConfig, ChannelMode, VoiceConfig};
pub use expression::{Expression, ExpressionParser, Segment};
pub use handle::AgentHandle;
pub use persona::PersonaHandle;
pub use tools::{Tool, ToolContext, ToolRegistry};

use commands::AgentCommands;
use handle::{Overrides, VoiceRooms};
use runtime::Agent;
use tools::ReactTool;

/// Loading persisted settings must not hold up startup for long.
const SETTINGS_LOAD_TIMEOUT: Duration = Duration::from_secs(5);

/// Module `agent`: requires `llm` and `scheduler`, optionally uses `commands`.
///
/// Provides [`PersonaHandle`], [`AgentHandle`] and [`ToolRegistry`] (the
/// latter keeps tools registered by other modules across agent restarts).
/// Uses the optional services `dyn SettingsStore` (persisting runtime
/// settings), `dyn Authorizer` (tool permissions) and `CommandRegistry`.
pub struct AgentModule {
    manifest: ModuleManifest,
    persona: PersonaHandle,
    random: Option<Arc<dyn RandomSource>>,
    tools: Arc<ToolRegistry>,
    overrides: Arc<RwLock<Overrides>>,
    voice_rooms: Arc<VoiceRooms>,
    commands: Arc<AgentCommands>,
}

impl AgentModule {
    pub const ID: &'static str = "agent";

    pub fn new(profile: Profile) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Agent")
                .description("Attention, conversation and reply generation")
                .requires("llm")
                .requires("scheduler")
                .optional("commands"),
            persona: PersonaHandle::new(profile),
            random: None,
            tools: Arc::new(ToolRegistry::new()),
            overrides: Arc::default(),
            voice_rooms: Arc::default(),
            commands: Arc::default(),
        }
    }

    /// Replaces the decision sampler (default: seeded from config or entropy).
    pub fn with_random(mut self, random: Arc<dyn RandomSource>) -> Self {
        self.random = Some(random);
        self
    }

    pub fn persona(&self) -> PersonaHandle {
        self.persona.clone()
    }

    /// The tool registry (also provided as a service while running).
    pub fn tools(&self) -> Arc<ToolRegistry> {
        self.tools.clone()
    }
}

#[async_trait]
impl Module for AgentModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: AgentConfig = ctx.config()?;
        let random = self.random.clone().unwrap_or_else(|| {
            Arc::new(match config.seed {
                Some(seed) => SeededRandom::new(seed),
                None => SeededRandom::from_entropy(),
            })
        });
        let store = ctx.services().get::<dyn SettingsStore>();
        let handle = Arc::new(AgentHandle::new(
            config.clone(),
            self.persona.clone(),
            self.overrides.clone(),
            self.voice_rooms.clone(),
            store,
        ));
        match tokio::time::timeout(SETTINGS_LOAD_TIMEOUT, handle.load()).await {
            Ok(Ok(0)) => {}
            Ok(Ok(n)) => info!(count = n, "loaded runtime channel settings"),
            Ok(Err(e)) => warn!(error = %format!("{e:#}"), "could not load runtime settings"),
            Err(_) => warn!("loading runtime settings timed out"),
        }
        self.tools.register(Arc::new(ReactTool::new(ctx.clone())))?;

        let events = ctx.subscribe(Agent::topics());
        ctx.provide(Arc::new(self.persona.clone()));
        ctx.provide(handle.clone());
        ctx.provide(self.tools.clone());
        self.commands
            .install(ctx.services(), handle.clone(), self.persona.clone());
        let agent = Arc::new(Agent::new(
            ctx.clone(),
            config,
            self.persona.clone(),
            random,
            handle,
            self.tools.clone(),
            self.commands.clone(),
        ));
        ctx.spawn("events", agent.run(events));
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        self.commands.uninstall();
        self.tools.unregister(ReactTool::NAME);
        Ok(())
    }
}
