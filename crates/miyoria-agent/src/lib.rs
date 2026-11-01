//! Cognition core (module `agent`).
//!
//! Turns `platform.*` events into replies: each conversation context keeps a
//! [`Session`](session::Session), a coordinator debounces messages into turns,
//! [attention](attention) decides whether to respond, and the reply is
//! generated through the `chat` LLM purpose, parsed by the
//! [expression parser](expression) and submitted to the scheduler.

pub mod attention;
pub mod config;
pub mod expression;
pub mod persona;
pub mod prompt;
pub mod session;

mod coordinator;
mod runtime;
mod turn;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use async_trait::async_trait;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest};
use miyoria_profile::Profile;

pub use attention::{RandomSource, SeededRandom};
pub use config::{AgentConfig, AttentionConfig, ChannelMode};
pub use expression::{Expression, ExpressionParser, Segment};
pub use persona::PersonaHandle;

use runtime::Agent;

/// Module `agent`: requires `llm` and `scheduler`; provides [`PersonaHandle`].
pub struct AgentModule {
    manifest: ModuleManifest,
    persona: PersonaHandle,
    random: Option<Arc<dyn RandomSource>>,
}

impl AgentModule {
    pub const ID: &'static str = "agent";

    pub fn new(profile: Profile) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Agent")
                .description("Attention, conversation and reply generation")
                .requires("llm")
                .requires("scheduler"),
            persona: PersonaHandle::new(profile),
            random: None,
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
        let events = ctx.subscribe(Agent::topics());
        ctx.provide(Arc::new(self.persona.clone()));
        let agent = Arc::new(Agent::new(
            ctx.clone(),
            config,
            self.persona.clone(),
            random,
        ));
        ctx.spawn("events", agent.run(events));
        Ok(())
    }
}
