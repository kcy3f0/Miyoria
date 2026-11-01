//! Host-side stand-ins that forward tool calls, command invocations and
//! prompt requests to an extension process.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use miyoria_commands::{CommandReply, CommandSpec, Invocation};
use miyoria_tools::{Tool, ToolContext, ToolSpec};
use miyoria_types::{PromptContributor, PromptRequest, PromptSection};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::rpc::Peer;

pub(crate) struct ProxyTool {
    pub peer: Arc<Peer>,
    /// Name the extension registered (may contain dots).
    pub wire_name: String,
    /// Spec with the registry name.
    pub spec: ToolSpec,
    pub permission: Option<String>,
    pub timeout: Duration,
}

/// The `context` object of `tools.call`.
pub(crate) fn tool_context_json(ctx: &ToolContext) -> Value {
    json!({
        "turn": ctx.turn,
        "context": ctx.context,
        "account": ctx.account,
        "message": ctx.message,
        "priority": ctx.priority,
    })
}

#[async_trait]
impl Tool for ProxyTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn permission(&self) -> Option<&str> {
        self.permission.as_deref()
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> anyhow::Result<String> {
        let result = self
            .peer
            .request(
                "tools.call",
                json!({ "name": self.wire_name, "args": args, "context": tool_context_json(ctx) }),
                self.timeout,
            )
            .await
            .map_err(|e| anyhow::anyhow!("{}", e.message))?;
        Ok(match result {
            Value::String(s) => s,
            Value::Object(mut obj) => match obj.remove("content") {
                Some(Value::String(s)) => s,
                Some(other) => other.to_string(),
                None => Value::Object(obj).to_string(),
            },
            other => other.to_string(),
        })
    }
}

/// Forwards one command to `commands.invoke`.
pub(crate) async fn invoke_command(
    peer: Arc<Peer>,
    spec: CommandSpec,
    invocation: Invocation,
    timeout: Duration,
) -> anyhow::Result<CommandReply> {
    #[derive(Deserialize)]
    struct Reply {
        text: String,
        ephemeral: Option<bool>,
    }
    let params = serde_json::to_value(&invocation)?;
    let result = peer
        .request("commands.invoke", params, timeout)
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message))?;
    let reply = match result {
        Value::String(text) => Reply {
            text,
            ephemeral: None,
        },
        other => serde_json::from_value(other)
            .map_err(|e| anyhow::anyhow!("bad `commands.invoke` result: {e}"))?,
    };
    Ok(CommandReply {
        text: reply.text,
        ephemeral: reply.ephemeral.unwrap_or(spec.ephemeral),
    })
}

pub(crate) struct ProxyPrompt {
    pub peer: Arc<Peer>,
    /// Registered key, `ext.<id>.<key>`.
    pub key: String,
    /// Key the extension knows.
    pub wire_key: String,
    pub timeout: Duration,
}

#[async_trait]
impl PromptContributor for ProxyPrompt {
    fn key(&self) -> &str {
        &self.key
    }

    async fn contribute(&self, request: &PromptRequest) -> anyhow::Result<Vec<PromptSection>> {
        #[derive(Deserialize)]
        struct Result {
            #[serde(default)]
            sections: Vec<PromptSection>,
        }
        let value = self
            .peer
            .request(
                "prompt.contribute",
                json!({ "key": self.wire_key, "request": request }),
                self.timeout,
            )
            .await
            .map_err(|e| anyhow::anyhow!("{}", e.message))?;
        let result: Result = serde_json::from_value(value)
            .map_err(|e| anyhow::anyhow!("bad `prompt.contribute` result: {e}"))?;
        Ok(result.sections)
    }
}
