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
//!
//! Other modules shape her turns through optional services: prompt
//! contributors (`PromptContributors`) add per-turn context, `dyn
//! SocialSignals` and `dyn MoodSignals` steer attention and tone, and
//! `agent.initiative` events let her start conversations. `llm.budget` events
//! make her save tokens (see [`BudgetState`]).

pub mod attention;
pub mod config;
pub mod expression;
pub mod handle;
pub mod persona;
pub mod prompt;
pub mod session;
pub mod signals;
pub mod speech;
pub mod tools;

mod commands;
mod contributors;
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
pub use signals::BudgetState;
pub use tools::{Tool, ToolContext, ToolRegistry};

use commands::AgentCommands;
use handle::{Overrides, VoiceRooms};
use runtime::Agent;
use tools::ReactTool;

/// Loading persisted settings must not hold up startup for long.
const SETTINGS_LOAD_TIMEOUT: Duration = Duration::from_secs(5);

/// Module `agent`: requires `llm` and `scheduler`, optionally uses `commands`.
///
/// Provides [`PersonaHandle`] and [`AgentHandle`]. Uses the `Arc<ToolRegistry>`
/// service when the app provides one at start; otherwise it provides its own
/// (which keeps tools registered by other modules across agent restarts).
/// Either way the built-in `react` tool is registered while running.
///
/// Uses the optional services `dyn SettingsStore` (persisting runtime
/// settings), `dyn Authorizer` (tool permissions), `CommandRegistry`,
/// `PromptContributors` (per-turn context), `dyn SocialSignals` and `dyn
/// MoodSignals`; they are looked up per turn, so they may come and go.
pub struct AgentModule {
    manifest: ModuleManifest,
    persona: PersonaHandle,
    random: Option<Arc<dyn RandomSource>>,
    /// Used when the app provides no registry.
    own_tools: Arc<ToolRegistry>,
    /// The registry in use.
    tools: RwLock<Arc<ToolRegistry>>,
    budget: Arc<RwLock<BudgetState>>,
    overrides: Arc<RwLock<Overrides>>,
    voice_rooms: Arc<VoiceRooms>,
    commands: Arc<AgentCommands>,
}

impl AgentModule {
    pub const ID: &'static str = "agent";

    pub fn new(profile: Profile) -> Self {
        let own_tools = Arc::new(ToolRegistry::new());
        Self {
            manifest: ModuleManifest::new(Self::ID, "Agent")
                .description("Attention, conversation and reply generation")
                .requires("llm")
                .requires("scheduler")
                .optional("commands"),
            persona: PersonaHandle::new(profile),
            random: None,
            tools: RwLock::new(own_tools.clone()),
            own_tools,
            budget: Arc::default(),
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

    /// The tool registry in use: the app's (once started, if it provides
    /// one) or the module's own. Tools registered here before start are
    /// carried over into an app-provided registry.
    pub fn tools(&self) -> Arc<ToolRegistry> {
        self.tools.read().clone()
    }

    /// The app's `Arc<ToolRegistry>` service if it provides one (pre-start
    /// registrations are carried over), else the module's own.
    fn resolve_tools(&self, ctx: &ModuleContext) -> anyhow::Result<(Arc<ToolRegistry>, bool)> {
        match ctx.services().get::<ToolRegistry>() {
            Some(app) if !Arc::ptr_eq(&app, &self.own_tools) => {
                for name in self.own_tools.names() {
                    if app.get(&name).is_none() {
                        if let Some(tool) = self.own_tools.get(&name) {
                            app.register(tool)?;
                        }
                    }
                }
                Ok((app, false))
            }
            _ => Ok((self.own_tools.clone(), true)),
        }
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
            self.budget.clone(),
            store,
        ));
        match tokio::time::timeout(SETTINGS_LOAD_TIMEOUT, handle.load()).await {
            Ok(Ok(0)) => {}
            Ok(Ok(n)) => info!(count = n, "loaded runtime channel settings"),
            Ok(Err(e)) => warn!(error = %format!("{e:#}"), "could not load runtime settings"),
            Err(_) => warn!("loading runtime settings timed out"),
        }
        let (tools, own) = self.resolve_tools(&ctx)?;
        if !own {
            info!("using the app's tool registry");
        }
        *self.tools.write() = tools.clone();
        tools.register(Arc::new(ReactTool::new(ctx.clone())))?;

        let events = ctx.subscribe(Agent::topics());
        ctx.provide(Arc::new(self.persona.clone()));
        ctx.provide(handle.clone());
        if own {
            ctx.provide(tools.clone());
        }
        self.commands
            .install(ctx.services(), handle.clone(), self.persona.clone());
        let agent = Arc::new(Agent::new(
            ctx.clone(),
            config,
            self.persona.clone(),
            random,
            handle,
            tools,
            self.commands.clone(),
        ));
        ctx.spawn("events", agent.run(events));
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        self.commands.uninstall();
        self.tools.read().unregister(ReactTool::NAME);
        Ok(())
    }
}
