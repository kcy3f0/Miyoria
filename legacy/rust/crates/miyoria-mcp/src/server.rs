//! The optional MCP server Miyoria exposes to external agents (Claude Code and
//! the like). Read-only on purpose: it can inspect Miyoria, never make her act.

use std::sync::Arc;

use anyhow::Context as _;
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use miyoria_kernel::{ModuleContext, SupervisorHandle};
use miyoria_store::DecisionLog;
use miyoria_tools::ToolRegistry;
use miyoria_types::{ModuleStateKind, ProfileId};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig as ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, ServerHandler};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::status::McpStatus;

const DEFAULT_DECISIONS: u64 = 20;
const MAX_DECISIONS: u64 = 200;

/// Handler for one MCP session. Services are looked up per call because the
/// modules providing them can be stopped or restarted at any time.
#[derive(Clone)]
pub(crate) struct ExposedServer {
    ctx: ModuleContext,
}

impl ExposedServer {
    pub(crate) fn new(ctx: ModuleContext) -> Self {
        Self { ctx }
    }

    async fn status(&self) -> anyhow::Result<Value> {
        let sup = self.ctx.services().require::<SupervisorHandle>()?;
        let modules = sup.list().await;
        let unhealthy: Vec<_> = modules
            .iter()
            .filter(|m| m.enabled && m.state != ModuleStateKind::Running)
            .map(|m| json!({"id": m.id, "state": m.state, "reason": m.reason}))
            .collect();
        let tools = self
            .ctx
            .services()
            .get::<ToolRegistry>()
            .map(|r| r.names().len());
        let mcp = self.ctx.services().get::<McpStatus>().map(|s| s.servers());
        Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "modules_total": modules.len(),
            "modules_not_running": unhealthy,
            "registered_tools": tools,
            "mcp_servers": mcp,
        }))
    }

    async fn list_modules(&self) -> anyhow::Result<Value> {
        let sup = self.ctx.services().require::<SupervisorHandle>()?;
        Ok(serde_json::to_value(sup.list().await)?)
    }

    fn list_tools(&self) -> anyhow::Result<Value> {
        let registry = self.ctx.services().require::<ToolRegistry>()?;
        let tools: Vec<_> = registry
            .specs()
            .into_iter()
            .map(|s| json!({"name": s.name, "description": s.description}))
            .collect();
        Ok(Value::Array(tools))
    }

    async fn recent_decisions(
        &self,
        args: &serde_json::Map<String, Value>,
    ) -> anyhow::Result<Value> {
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_DECISIONS)
            .clamp(1, MAX_DECISIONS) as usize;
        let log = self.ctx.services().require::<dyn DecisionLog>()?;
        let profile = self.ctx.services().require::<ProfileId>()?;
        let records = log.recent(&profile, None, limit).await?;
        Ok(serde_json::to_value(records)?)
    }
}

fn tool(name: &'static str, description: &'static str, schema: Value) -> Tool {
    let Value::Object(schema) = schema else {
        unreachable!("tool schemas are objects")
    };
    Tool::new(name, description, Arc::new(schema))
}

fn text_result(value: &Value, is_error: bool) -> CallToolResponse {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    let content = vec![ContentBlock::text(text)];
    CallToolResponse::Complete(if is_error {
        CallToolResult::error(content)
    } else {
        CallToolResult::success(content)
    })
}

impl ServerHandler for ExposedServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("miyoria", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Read-only view of a running Miyoria instance: module health, registered \
                 tools and recent attention decisions.",
            )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let none = json!({"type": "object", "properties": {}});
        Ok(ListToolsResult::with_all_items(vec![
            tool(
                "status",
                "Overall health: module counts, modules that are not running, tool count, MCP client connections.",
                none.clone(),
            ),
            tool("list_modules", "State of every module.", none.clone()),
            tool(
                "list_tools",
                "Names and descriptions of every tool the model can currently call.",
                none,
            ),
            tool(
                "recent_decisions",
                "Most recent attention decisions (why she did or did not reply), newest first.",
                json!({
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": MAX_DECISIONS,
                            "description": "How many records to return (default 20)."
                        }
                    }
                }),
            ),
        ]))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let args = request.arguments.unwrap_or_default();
        let outcome = match request.name.as_ref() {
            "status" => self.status().await,
            "list_modules" => self.list_modules().await,
            "list_tools" => self.list_tools(),
            "recent_decisions" => self.recent_decisions(&args).await,
            other => {
                return Err(ErrorData::invalid_params(
                    format!("unknown tool `{other}`"),
                    None,
                ));
            }
        };
        Ok(match outcome {
            Ok(value) => text_result(&value, false),
            Err(e) => text_result(&json!({"error": format!("{e:#}")}), true),
        })
    }
}

/// Rejects requests without the right bearer token.
async fn require_token(State(token): State<Arc<[u8]>>, request: Request, next: Next) -> Response {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
        .unwrap_or("");
    if presented.as_bytes().ct_eq(&token).into() && !token.is_empty() {
        next.run(request).await
    } else {
        let mut response =
            (StatusCode::UNAUTHORIZED, "missing or invalid bearer token").into_response();
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        response
    }
}

/// Binds the listener (so a busy port is reported at start).
pub(crate) async fn bind(addr: &str) -> anyhow::Result<TcpListener> {
    TcpListener::bind(addr)
        .await
        .with_context(|| format!("cannot bind MCP server to `{addr}`"))
}

/// Serves Streamable HTTP MCP at `/mcp` until `cancel` fires.
pub(crate) async fn serve(
    listener: TcpListener,
    ctx: ModuleContext,
    token: String,
    extra_hosts: Vec<String>,
    cancel: CancellationToken,
) -> anyhow::Result<()> {
    let mut hosts: Vec<String> = vec!["localhost".into(), "127.0.0.1".into(), "::1".into()];
    hosts.extend(extra_hosts);
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts(hosts)
        .with_cancellation_token(cancel.child_token());
    let mcp = StreamableHttpService::new(
        move || Ok(ExposedServer::new(ctx.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let app = Router::new()
        .nest_service("/mcp", mcp)
        .layer(middleware::from_fn_with_state(
            Arc::<[u8]>::from(token.into_bytes()),
            require_token,
        ));
    axum::serve(listener, app)
        .with_graceful_shutdown(async move { cancel.cancelled().await })
        .await
        .context("MCP server stopped")
}
