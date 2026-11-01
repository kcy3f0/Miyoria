//! A tiny MCP server over stdio used by the integration tests.
//!
//! Tools: echo, big, slow, fail, crash, image, env, cwd, grow, read_a,
//! danger_delete, dotted.name. `grow` adds the tool `extra` and sends
//! `tools/list_changed`. With `FIXTURE_EXIT_AT_START=1` the process prints to
//! stderr and exits before the handshake.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::stdio;
use rmcp::{ErrorData, ServerHandler, ServiceExt};
use serde_json::{Value, json};

#[derive(Clone, Default)]
struct Fixture {
    grown: Arc<AtomicBool>,
}

fn tool(name: &'static str, description: &'static str, props: Value) -> Tool {
    let Value::Object(schema) = json!({"type": "object", "properties": props}) else {
        unreachable!()
    };
    Tool::new(name, description, Arc::new(schema))
}

impl ServerHandler for Fixture {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .build(),
        )
        .with_server_info(Implementation::new("fixture", "0.0.1"))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut tools = vec![
            tool(
                "echo",
                "Echoes `text`.",
                json!({"text": {"type": "string"}}),
            ),
            tool(
                "big",
                "Returns `n` x characters.",
                json!({"n": {"type": "integer"}}),
            ),
            tool(
                "slow",
                "Sleeps `ms` then answers.",
                json!({"ms": {"type": "integer"}}),
            ),
            tool("fail", "Always reports a tool error.", json!({})),
            tool("crash", "Exits the process.", json!({})),
            tool("image", "Returns text plus an image.", json!({})),
            tool(
                "env",
                "Reads environment variable `name`.",
                json!({"name": {"type": "string"}}),
            ),
            tool("cwd", "Returns the working directory.", json!({})),
            tool("grow", "Adds the `extra` tool and notifies.", json!({})),
            tool("read_a", "A read tool.", json!({})),
            tool("danger_delete", "A dangerous tool.", json!({})),
            tool("dotted.name", "Name needing sanitizing.", json!({})),
        ];
        if self.grown.load(Ordering::SeqCst) {
            tools.push(tool("extra", "Appears after `grow`.", json!({})));
        }
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let args = request.arguments.unwrap_or_default();
        let text = |s: String| CallToolResult::success(vec![ContentBlock::text(s)]);
        let result = match request.name.as_ref() {
            "echo" => text(
                args.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            ),
            "big" => text("x".repeat(args.get("n").and_then(Value::as_u64).unwrap_or(0) as usize)),
            "slow" => {
                let ms = args.get("ms").and_then(Value::as_u64).unwrap_or(0);
                tokio::time::sleep(Duration::from_millis(ms)).await;
                text("done".into())
            }
            "fail" => CallToolResult::error(vec![ContentBlock::text("it broke")]),
            "crash" => std::process::exit(3),
            "image" => CallToolResult::success(vec![
                ContentBlock::text("caption"),
                ContentBlock::image("AAAA", "image/png"),
            ]),
            "env" => {
                let name = args.get("name").and_then(Value::as_str).unwrap_or("");
                text(std::env::var(name).unwrap_or_else(|_| "<unset>".into()))
            }
            "cwd" => text(std::env::current_dir().unwrap().display().to_string()),
            "grow" => {
                self.grown.store(true, Ordering::SeqCst);
                let _ = context.peer.notify_tool_list_changed().await;
                text("grown".into())
            }
            other => text(format!("called {other}")),
        };
        Ok(CallToolResponse::Complete(result))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::var_os("FIXTURE_EXIT_AT_START").is_some() {
        eprintln!("fixture refuses to start");
        std::process::exit(1);
    }
    let service = Fixture::default().serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
