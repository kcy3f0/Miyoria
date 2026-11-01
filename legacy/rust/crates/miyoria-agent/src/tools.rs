//! Built-in tools. The interface lives in `miyoria-tools`.

use async_trait::async_trait;
use miyoria_kernel::ModuleContext;
use miyoria_llm::ToolSpec;
pub use miyoria_tools::{Tool, ToolContext, ToolRegistry};
use miyoria_types::{Action, ActionPayload, ActionSink, LaneKey};

/// Longest emoji (or custom emoji reference such as `name:123`) `react` accepts.
const MAX_EMOJI_LEN: usize = 64;

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
    use std::sync::Arc;

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
