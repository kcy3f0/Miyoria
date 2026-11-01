//! Tools the model may call during a turn.
//!
//! Tools live in the [`ToolRegistry`], provided as the service
//! `Arc<ToolRegistry>` by the agent module; other modules (extensions) may
//! register and unregister tools at any time. Permissions are checked against
//! the user who triggered the turn, never against the model.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use miyoria_kernel::ModuleContext;
use miyoria_llm::ToolSpec;
use miyoria_types::{
    AccountRef, Action, ActionPayload, ActionSink, ContextKey, LaneKey, MessageRef, Priority,
    TurnId,
};
use parking_lot::RwLock;

/// Longest emoji (or custom emoji reference such as `name:123`) `react` accepts.
const MAX_EMOJI_LEN: usize = 64;

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

/// Built-in `react`: adds an emoji reaction to the triggering message.
pub(crate) struct ReactTool {
    ctx: ModuleContext,
}

impl ReactTool {
    pub const NAME: &'static str = "react";

    pub fn new(ctx: ModuleContext) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl Tool for ReactTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: Self::NAME.into(),
            description: "對觸發這次對話的那則訊息加上一個 emoji 反應。只想表達情緒、不需要多說話時可以只按反應然後輸出 <silence/>。".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "emoji": {
                        "type": "string",
                        "description": "一個 emoji,例如 👍、😤、🐋"
                    }
                },
                "required": ["emoji"]
            }),
        }
    }

    async fn call(&self, ctx: &ToolContext, args: serde_json::Value) -> anyhow::Result<String> {
        let emoji = args
            .get("emoji")
            .and_then(|e| e.as_str())
            .map(str::trim)
            .unwrap_or_default();
        if emoji.is_empty() || emoji.chars().count() > MAX_EMOJI_LEN {
            anyhow::bail!("`emoji` must be a single emoji");
        }
        let sink = self.ctx.services().require::<dyn ActionSink>()?;
        let action = Action::new(
            LaneKey::text(&ctx.context),
            ctx.priority,
            ActionPayload::React {
                message: ctx.message.clone(),
                emoji: emoji.to_owned(),
            },
        )
        .with_turn(ctx.turn);
        sink.submit(action).await?;
        Ok(format!("reacted with {emoji}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Named(&'static str);

    #[async_trait]
    impl Tool for Named {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: self.0.into(),
                description: "test".into(),
                parameters: serde_json::json!({ "type": "object" }),
            }
        }

        async fn call(&self, _: &ToolContext, _: serde_json::Value) -> anyhow::Result<String> {
            Ok("ok".into())
        }
    }

    #[test]
    fn register_and_unregister() {
        let reg = ToolRegistry::new();
        assert!(reg.is_empty());
        reg.register(Arc::new(Named("b_tool"))).unwrap();
        reg.register(Arc::new(Named("a-tool"))).unwrap();
        reg.register(Arc::new(Named("a-tool"))).unwrap();
        assert!(reg.register(Arc::new(Named("bad name"))).is_err());
        assert!(reg.register(Arc::new(Named(""))).is_err());
        assert_eq!(reg.names(), ["a-tool", "b_tool"]);
        assert_eq!(reg.specs().len(), 2);
        assert!(reg.get("a-tool").is_some());
        assert!(reg.unregister("a-tool"));
        assert!(!reg.unregister("a-tool"));
        assert_eq!(reg.names(), ["b_tool"]);
    }
}
