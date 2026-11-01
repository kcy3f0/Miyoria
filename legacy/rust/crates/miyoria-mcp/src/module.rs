use std::sync::Arc;

use anyhow::Context as _;
use async_trait::async_trait;
use miyoria_kernel::{Config, Health, Module, ModuleContext, ModuleManifest};
use miyoria_tools::ToolRegistry;
use parking_lot::Mutex;
use tracing::{info, warn};

use crate::client::{Registrar, ServerRunner};
use crate::config::McpConfig;
use crate::server;
use crate::status::{ExposeStatus, McpStatus, ServerState, ServerStatus};

struct Running {
    status: Arc<McpStatus>,
    registrar: Arc<Registrar>,
}

/// Module `mcp`: connects to configured MCP servers and mirrors their tools
/// into the shared [`ToolRegistry`]; optionally serves a read-only MCP
/// endpoint. Provides `Arc<McpStatus>`; requires the `Arc<ToolRegistry>`
/// service to exist.
pub struct McpModule {
    manifest: ModuleManifest,
    config: McpConfig,
    running: Mutex<Option<Running>>,
}

impl McpModule {
    pub const ID: &'static str = "mcp";

    pub fn new(config: McpConfig) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "MCP")
                .description("MCP client for external tools, optional read-only MCP server"),
            config,
            running: Mutex::new(None),
        }
    }

    /// Builds the module from the app config's top-level `[mcp]` section.
    pub fn from_app_config(config: &Config) -> anyhow::Result<Self> {
        let section = config
            .section("mcp")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        Ok(Self::new(McpConfig::from_value(&section)?))
    }

    /// Status of the current run, if the module is running.
    pub fn status(&self) -> Option<Arc<McpStatus>> {
        self.running.lock().as_ref().map(|r| r.status.clone())
    }
}

#[async_trait]
impl Module for McpModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let registry = ctx
            .services()
            .get::<ToolRegistry>()
            .context("the tool registry service is not available")?;
        let status = Arc::new(McpStatus::new());
        let registrar = Arc::new(Registrar::new(registry));

        for (name, server) in &self.config.servers {
            status.insert(ServerStatus::new(
                name,
                server.effective_transport().as_str(),
                server.permission_node(name),
            ));
            if !server.enabled {
                status.update(name, |s| s.state = ServerState::Disabled);
                continue;
            }
            if let Err(e) = server.validate(name) {
                warn!(server = %name, error = %e, "invalid MCP server config");
                status.update(name, |s| {
                    s.state = ServerState::Failed;
                    s.last_error = Some(format!("invalid config: {e:#}"));
                });
                continue;
            }
            let runner = ServerRunner {
                name: name.clone(),
                config: server.clone(),
                status: status.clone(),
                registrar: registrar.clone(),
                backoff_initial: self.config.reconnect_initial(),
                backoff_max: self.config.reconnect_max(),
            };
            let cancel = ctx.cancellation().clone();
            ctx.spawn("mcp-client", async move {
                runner.run(cancel).await;
                Ok(())
            });
        }

        let expose = &self.config.server;
        if expose.enabled {
            let outcome = if expose.token.trim().is_empty() {
                Err(anyhow::anyhow!(
                    "`mcp.server.token` must be set when the MCP server is enabled"
                ))
            } else {
                server::bind(&expose.bind).await
            };
            match outcome {
                Ok(listener) => {
                    let local = listener.local_addr().ok().map(|a| a.to_string());
                    info!(addr = ?local, "MCP server listening");
                    status.set_expose(ExposeStatus {
                        enabled: true,
                        listening: local,
                        error: None,
                    });
                    let (token, hosts) = (expose.token.clone(), expose.allowed_hosts.clone());
                    let (serve_ctx, cancel) = (ctx.clone(), ctx.cancellation().clone());
                    ctx.spawn("mcp-expose", async move {
                        server::serve(listener, serve_ctx, token, hosts, cancel).await
                    });
                }
                Err(e) => {
                    warn!(error = %e, "MCP server not started");
                    status.set_expose(ExposeStatus {
                        enabled: true,
                        listening: None,
                        error: Some(format!("{e:#}")),
                    });
                }
            }
        }

        ctx.provide::<McpStatus>(status.clone());
        *self.running.lock() = Some(Running { status, registrar });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        if let Some(running) = self.running.lock().take() {
            running.registrar.close();
        }
        Ok(())
    }

    async fn health(&self) -> Health {
        let Some(status) = self.status() else {
            return Health::Unhealthy("not running".into());
        };
        let expose = status.expose();
        if let Some(e) = expose.error {
            return Health::Degraded(format!("MCP server: {e}"));
        }
        let down = status.unavailable();
        if down.is_empty() {
            Health::Healthy
        } else {
            Health::Degraded(format!("MCP servers not connected: {}", down.join(", ")))
        }
    }
}
