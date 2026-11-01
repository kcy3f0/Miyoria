//! Model tools `remember` and `recall`.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use miyoria_store::MemoryKind;
use miyoria_tools::{Tool, ToolContext, ToolSpec};
use serde_json::json;

use crate::contributor::{PROMPT_KINDS, format_lines};
use crate::engine::{MemoryEngine, NewMemory, Stored};
use crate::scope::{scope_for_new, visible_scopes};

pub const REMEMBER: &str = "remember";
pub const RECALL: &str = "recall";

/// Saves a note about the current speaker or herself.
pub struct RememberTool {
    engine: Arc<MemoryEngine>,
}

impl RememberTool {
    pub fn new(engine: Arc<MemoryEngine>) -> Self {
        Self { engine }
    }
}

#[async_trait]
impl Tool for RememberTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: REMEMBER.to_owned(),
            description: "把一件值得長期記住的事記下來:關於正在跟你說話的人(about=speaker),\
                或關於你自己的承諾、意見、經歷(about=self)。寫成日後單獨看也懂的一句話,包含名字。"
                .to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "要記住的事,例如「Owen 下週三要考期末考」" },
                    "about": { "type": "string", "enum": ["speaker", "self"], "description": "關於對方還是關於自己" },
                    "importance": { "type": "number", "minimum": 0, "maximum": 1, "description": "重要程度 0~1" },
                    "global": { "type": "boolean", "description": "只有名字、希望怎麼被稱呼這類到哪都適用、不私密的事才設 true" }
                },
                "required": ["content"]
            }),
        }
    }

    async fn call(&self, ctx: &ToolContext, args: serde_json::Value) -> anyhow::Result<String> {
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("`content` is required"))?
            .to_owned();
        let about_self = args.get("about").and_then(|v| v.as_str()) == Some("self");
        let importance = args
            .get("importance")
            .and_then(serde_json::Value::as_f64)
            .map_or(0.6, |v| v.clamp(0.0, 1.0) as f32);
        let global = args
            .get("global")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        let person = self.engine.person_of(&ctx.account).await;
        let (kind, subjects) = if about_self {
            (MemoryKind::SelfNote, Vec::new())
        } else {
            (MemoryKind::Fact, person.into_iter().collect::<Vec<_>>())
        };
        let global_person = if global && !about_self { person } else { None };
        let scope = scope_for_new(
            self.engine.config(),
            &ctx.context,
            Some(&ctx.account),
            kind,
            global_person,
        );
        let stored = self
            .engine
            .store(
                NewMemory {
                    kind,
                    scope,
                    subjects,
                    content,
                    importance,
                    confidence: 0.9,
                    source_context: Some(ctx.context.clone()),
                    due: None,
                },
                Utc::now(),
            )
            .await?;
        Ok(match stored {
            Stored::Inserted(_) => "記住了。".to_owned(),
            Stored::Reinforced(_) => "這件事我本來就記得,現在記得更牢了。".to_owned(),
            Stored::Superseded { .. } => "記住了(更新了之前記的內容)。".to_owned(),
        })
    }
}

/// Searches memories visible in the current context.
pub struct RecallTool {
    engine: Arc<MemoryEngine>,
}

impl RecallTool {
    pub fn new(engine: Arc<MemoryEngine>) -> Self {
        Self { engine }
    }
}

#[async_trait]
impl Tool for RecallTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: RECALL.to_owned(),
            description: "在你的長期記憶裡搜尋跟某件事有關的回憶(只會找到這裡可以提的記憶)。"
                .to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "要想起什麼,例如「Owen 喜歡吃什麼」" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20 }
                },
                "required": ["query"]
            }),
        }
    }

    async fn call(&self, ctx: &ToolContext, args: serde_json::Value) -> anyhow::Result<String> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("`query` is required"))?;
        let limit = args
            .get("limit")
            .and_then(serde_json::Value::as_u64)
            .map_or(self.engine.config().recall_limit, |n| {
                n.clamp(1, 20) as usize
            });
        let person = self.engine.person_of(&ctx.account).await;
        let scopes = visible_scopes(&ctx.context, [&ctx.account], person);
        let present: Vec<_> = person.into_iter().collect();
        let now = Utc::now();
        let recalled = self
            .engine
            .recall(&scopes, &present, query, &PROMPT_KINDS, limit, now)
            .await?;
        if recalled.is_empty() {
            return Ok("想不起來有關的事。".to_owned());
        }
        Ok(format_lines(&recalled, now))
    }
}
