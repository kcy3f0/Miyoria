//! Tools the model may call during a turn.
//!
//! The app creates one [`ToolRegistry`] at boot and provides it as the
//! service `Arc<ToolRegistry>`; any module (memory, extensions, MCP, ...) may
//! register and unregister tools at any time. The agent offers the registered
//! tools to the model and checks permissions against the user who triggered
//! the turn, never against the model.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
pub use miyoria_llm::ToolSpec;
use miyoria_types::{AccountRef, ContextKey, MessageRef, Priority, TurnId};
use parking_lot::RwLock;

/// What a tool call is running on behalf of.
#[derive(Clone, Debug)]
pub struct ToolContext {
    pub turn: TurnId,
    pub context: ContextKey,
    /// Author of the message that triggered the turn.
    pub account: AccountRef,
    /// The message that triggered the turn (the latest one).
    pub message: MessageRef,
    /// Priority for actions the tool submits (same as her reply).
    pub priority: Priority,
}

#[async_trait]
pub trait Tool: Send + Sync {
    /// Name, description and JSON Schema of the arguments shown to the model.
    fn spec(&self) -> ToolSpec;

    /// Permission node the triggering user needs, if any.
    fn permission(&self) -> Option<&str> {
        None
    }

    /// Runs the tool. The returned text (or error) goes back to the model, so
    /// keep it short.
    async fn call(&self, ctx: &ToolContext, args: serde_json::Value) -> anyhow::Result<String>;
}

/// Every tool offered to the model, by name.
#[derive(Default)]
pub struct ToolRegistry {
    tools: RwLock<BTreeMap<String, Arc<dyn Tool>>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers (or replaces) a tool under `spec().name`, which must be 1–64
    /// ASCII letters, digits, `_` or `-`.
    pub fn register(&self, tool: Arc<dyn Tool>) -> anyhow::Result<()> {
        let name = tool.spec().name;
        let valid = (1..=64).contains(&name.len())
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !valid {
            anyhow::bail!("invalid tool name `{name}`");
        }
        self.tools.write().insert(name, tool);
        Ok(())
    }

    pub fn unregister(&self, name: &str) -> bool {
        self.tools.write().remove(name).is_some()
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.read().get(name).cloned()
    }

    pub fn names(&self) -> Vec<String> {
        self.tools.read().keys().cloned().collect()
    }

    /// Specs of every registered tool, ordered by name.
    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools.read().values().map(|t| t.spec()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.read().is_empty()
    }
}
