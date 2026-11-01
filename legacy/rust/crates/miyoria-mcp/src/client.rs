//! The MCP client side: one supervised connection per configured server whose
//! tools are mirrored into the [`ToolRegistry`].

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow, bail};
use async_trait::async_trait;
use miyoria_llm::ToolSpec;
use miyoria_tools::{Tool, ToolContext, ToolRegistry};
use parking_lot::Mutex;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ClientCapabilities, ClientConfig, Implementation,
};
use rmcp::service::{NotificationContext, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess, which_command};
use rmcp::{ClientHandler, Peer, RoleClient, ServiceExt};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::config::{ServerConfig, Transport};
use crate::policy::{ToolFilter, flatten_result, registry_name, truncate_chars};
use crate::status::{McpStatus, ServerState};

/// How long a closing child process gets to exit before we stop waiting.
const CLOSE_GRACE: Duration = Duration::from_secs(5);

/// Registers tools in the shared registry and remembers what it added, so
/// everything can be removed on stop. After [`close`](Self::close) nothing
/// more can be registered.
pub(crate) struct Registrar {
    registry: Arc<ToolRegistry>,
    names: Mutex<BTreeSet<String>>,
    closed: AtomicBool,
}

impl Registrar {
    pub(crate) fn new(registry: Arc<ToolRegistry>) -> Self {
        Self {
            registry,
            names: Mutex::new(BTreeSet::new()),
            closed: AtomicBool::new(false),
        }
    }

    fn register(&self, tool: Arc<dyn Tool>) -> anyhow::Result<()> {
        let name = tool.spec().name;
        let mut names = self.names.lock();
        if self.closed.load(Ordering::Acquire) {
            bail!("MCP module is stopping");
        }
        self.registry.register(tool)?;
        names.insert(name);
        Ok(())
    }

    fn unregister(&self, name: &str) {
        if self.names.lock().remove(name) {
            self.registry.unregister(name);
        }
    }

    /// Removes every tool this registrar added and refuses new ones.
    pub(crate) fn close(&self) {
        let mut names = self.names.lock();
        self.closed.store(true, Ordering::Release);
        for name in std::mem::take(&mut *names) {
            self.registry.unregister(&name);
        }
    }
}

/// Receives server notifications; only `tools/list_changed` matters here.
struct Handler {
    tools_changed: Arc<Notify>,
}

impl ClientHandler for Handler {
    fn get_info(&self) -> ClientConfig {
        ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("miyoria", env!("CARGO_PKG_VERSION")),
        )
    }

    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.tools_changed.notify_one();
    }
}

type Service = RunningService<RoleClient, Handler>;

/// A tool of an MCP server, as the model sees it.
struct McpTool {
    spec: ToolSpec,
    server: String,
    remote_name: String,
    permission: Option<String>,
    peer: Peer<RoleClient>,
    timeout: Duration,
    max_result_chars: usize,
}

#[async_trait]
impl Tool for McpTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn permission(&self) -> Option<&str> {
        self.permission.as_deref()
    }

    async fn call(&self, _ctx: &ToolContext, args: serde_json::Value) -> anyhow::Result<String> {
        let mut params = CallToolRequestParams::new(self.remote_name.clone());
        match args {
            serde_json::Value::Object(map) => params = params.with_arguments(map),
            serde_json::Value::Null => {}
            other => bail!("tool arguments must be a JSON object, got {other}"),
        }
        let response = tokio::time::timeout(self.timeout, self.peer.call_tool_once(params))
            .await
            .map_err(|_| {
                anyhow!(
                    "MCP tool `{}` on server `{}` timed out after {} ms",
                    self.remote_name,
                    self.server,
                    self.timeout.as_millis()
                )
            })?
            .map_err(|e| {
                anyhow!(
                    "MCP tool `{}` on server `{}` failed: {e}",
                    self.remote_name,
                    self.server
                )
            })?;
        let CallToolResponse::Complete(result) = response else {
            bail!(
                "MCP tool `{}` on server `{}` asked for client input or a task, which is not supported",
                self.remote_name,
                self.server
            );
        };
        let text = truncate_chars(flatten_result(&result), self.max_result_chars);
        if result.is_error == Some(true) {
            bail!("{text}");
        }
        Ok(text)
    }
}

/// Keeps one server connected for as long as the module runs.
pub(crate) struct ServerRunner {
    pub name: String,
    pub config: ServerConfig,
    pub status: Arc<McpStatus>,
    pub registrar: Arc<Registrar>,
    pub backoff_initial: Duration,
    pub backoff_max: Duration,
}

/// Why one connection attempt / session ended.
enum SessionEnd {
    Cancelled,
    /// Never got as far as `Connected`.
    ConnectFailed(anyhow::Error),
    /// Was connected, then lost or broke.
    Lost(anyhow::Error, Duration),
}

impl ServerRunner {
    /// Connects, mirrors tools and reconnects with backoff until cancelled.
    /// Never fails: problems end up in the server's status.
    pub(crate) async fn run(self, cancel: CancellationToken) {
        let mut backoff = self.backoff_initial;
        let mut connects = 0u32;
        loop {
            self.status
                .update(&self.name, |s| s.state = ServerState::Connecting);
            let end = self.session(&cancel, &mut connects).await;
            self.registrar_clear();
            let error = match end {
                SessionEnd::Cancelled => break,
                SessionEnd::ConnectFailed(e) => e,
                SessionEnd::Lost(e, lived) => {
                    if lived >= self.backoff_max {
                        backoff = self.backoff_initial;
                    }
                    e
                }
            };
            let message = format!("{error:#}");
            warn!(server = %self.name, error = %message, retry_in_ms = backoff.as_millis() as u64, "MCP server unavailable");
            self.status.update(&self.name, |s| {
                s.state = ServerState::Failed;
                s.tools.clear();
                s.last_error = Some(message);
            });
            tokio::select! {
                () = cancel.cancelled() => break,
                () = tokio::time::sleep(backoff) => {}
            }
            backoff = (backoff * 2).min(self.backoff_max);
        }
        self.registrar_clear();
        debug!(server = %self.name, "MCP server runner stopped");
    }

    /// Unregisters this server's tools (the registrar also tracks them, but
    /// only per name, so we go through the status list).
    fn registrar_clear(&self) {
        if let Some(status) = self.status.server(&self.name) {
            for name in &status.tools {
                self.registrar.unregister(name);
            }
        }
        self.status.update(&self.name, |s| s.tools.clear());
    }

    async fn session(&self, cancel: &CancellationToken, connects: &mut u32) -> SessionEnd {
        let tools_changed = Arc::new(Notify::new());
        let connect = connect(
            &self.name,
            &self.config,
            Handler {
                tools_changed: tools_changed.clone(),
            },
        );
        let service = tokio::select! {
            () = cancel.cancelled() => return SessionEnd::Cancelled,
            r = tokio::time::timeout(self.config.connect_timeout(), connect) => match r {
                Ok(Ok(service)) => service,
                Ok(Err(e)) => return SessionEnd::ConnectFailed(e),
                Err(_) => return SessionEnd::ConnectFailed(anyhow!(
                    "timed out connecting after {} ms",
                    self.config.connect_timeout().as_millis()
                )),
            },
        };
        let peer = service.peer().clone();
        let stop = service.cancellation_token();
        let mut waiter = AbortOnDrop(tokio::spawn(async move {
            let _ = service.waiting().await;
        }));

        let filter = ToolFilter::new(&self.config.tools_allow, &self.config.tools_deny);
        let mut lived_from: Option<Instant> = None;
        let mut closed = false;
        let outcome: anyhow::Result<()> = async {
            self.sync_tools(&peer, &filter).await?;
            *connects += 1;
            lived_from = Some(Instant::now());
            let reconnects = connects.saturating_sub(1);
            self.status.update(&self.name, |s| {
                s.state = ServerState::Connected;
                s.reconnects = reconnects;
            });
            info!(server = %self.name, "MCP server connected");
            loop {
                tokio::select! {
                    () = cancel.cancelled() => return Ok(()),
                    _ = &mut waiter.0 => {
                        closed = true;
                        bail!("connection closed");
                    }
                    () = tools_changed.notified() => {
                        debug!(server = %self.name, "MCP tool list changed");
                        self.sync_tools(&peer, &filter).await?;
                    }
                }
            }
        }
        .await;

        // Closing the service also ends the child process.
        if !closed {
            stop.cancel();
            if tokio::time::timeout(CLOSE_GRACE, &mut waiter.0)
                .await
                .is_err()
            {
                warn!(server = %self.name, "MCP connection did not close in time");
            }
        }
        match (outcome, cancel.is_cancelled()) {
            (_, true) | (Ok(()), _) => SessionEnd::Cancelled,
            (Err(e), false) => match lived_from {
                Some(since) => SessionEnd::Lost(e, since.elapsed()),
                None => SessionEnd::ConnectFailed(e),
            },
        }
    }

    /// Lists the server's tools and makes the registry match the allowed ones.
    async fn sync_tools(&self, peer: &Peer<RoleClient>, filter: &ToolFilter) -> anyhow::Result<()> {
        let listed = tokio::time::timeout(self.config.connect_timeout(), peer.list_all_tools())
            .await
            .map_err(|_| anyhow!("timed out listing tools"))?
            .map_err(|e| anyhow!("cannot list tools: {e}"))?;
        let remote_count = listed.len();

        let mut allowed: Vec<_> = listed
            .into_iter()
            .filter(|t| filter.allows(&t.name))
            .collect();
        allowed.sort_by(|a, b| a.name.cmp(&b.name));

        let permission = self.config.permission_node(&self.name);
        let mut wanted: BTreeMap<String, Arc<dyn Tool>> = BTreeMap::new();
        let mut taken = BTreeSet::new();
        for tool in allowed {
            let Some(name) = registry_name(&self.name, &tool.name, &taken) else {
                warn!(server = %self.name, tool = %tool.name, "cannot derive a unique tool name, skipping");
                continue;
            };
            taken.insert(name.clone());
            let mut schema = (*tool.input_schema).clone();
            if schema.is_empty() {
                schema.insert("type".into(), "object".into());
            }
            let description = tool
                .description
                .as_deref()
                .map(str::to_owned)
                .or_else(|| tool.title.clone())
                .unwrap_or_else(|| tool.name.to_string());
            wanted.insert(
                name.clone(),
                Arc::new(McpTool {
                    spec: ToolSpec {
                        name,
                        description,
                        parameters: serde_json::Value::Object(schema),
                    },
                    server: self.name.clone(),
                    remote_name: tool.name.to_string(),
                    permission: permission.clone(),
                    peer: peer.clone(),
                    timeout: self.config.call_timeout(),
                    max_result_chars: self.config.max_result_chars,
                }),
            );
        }

        let previous = self
            .status
            .server(&self.name)
            .map(|s| s.tools)
            .unwrap_or_default();
        for old in previous.iter().filter(|n| !wanted.contains_key(*n)) {
            self.registrar.unregister(old);
        }
        let mut registered = Vec::with_capacity(wanted.len());
        for (name, tool) in wanted {
            match self.registrar.register(tool) {
                Ok(()) => registered.push(name),
                Err(e) => {
                    warn!(server = %self.name, tool = %name, error = %e, "cannot register MCP tool")
                }
            }
        }
        self.status.update(&self.name, |s| {
            s.tools = registered;
            s.remote_tool_count = remote_count;
        });
        Ok(())
    }
}

struct AbortOnDrop<T>(JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Opens the transport and runs the MCP handshake.
async fn connect(name: &str, config: &ServerConfig, handler: Handler) -> anyhow::Result<Service> {
    match config.effective_transport() {
        Transport::Stdio => {
            let command = config.command.as_deref().unwrap_or_default();
            // Resolve through PATH so shims like `npx.cmd` work on Windows.
            let mut cmd =
                which_command(command).unwrap_or_else(|_| tokio::process::Command::new(command));
            cmd.args(&config.args).envs(&config.env);
            if let Some(cwd) = &config.cwd {
                cmd.current_dir(cwd);
            }
            #[cfg(windows)]
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            let (transport, stderr) = TokioChildProcess::builder(cmd)
                .stderr(Stdio::piped())
                .spawn()
                .with_context(|| format!("cannot start `{command}`"))?;
            let tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
            if let Some(stderr) = stderr {
                let (tail, name) = (tail.clone(), name.to_owned());
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        debug!(server = %name, "stderr: {line}");
                        let mut tail = tail.lock();
                        if tail.len() >= 5 {
                            tail.pop_front();
                        }
                        tail.push_back(line);
                    }
                });
            }
            handler.serve(transport).await.map_err(|e| {
                // Let the stderr reader catch up so the cause is included.
                let lines: Vec<String> = tail.lock().iter().cloned().collect();
                if lines.is_empty() {
                    anyhow!("MCP handshake failed: {e}")
                } else {
                    anyhow!("MCP handshake failed: {e} (stderr: {})", lines.join(" | "))
                }
            })
        }
        Transport::Http => {
            install_crypto_provider();
            let url = config.url.as_deref().unwrap_or_default();
            let mut transport_config = StreamableHttpClientTransportConfig::with_uri(url);
            let mut headers = HashMap::new();
            for (key, value) in &config.headers {
                if key.eq_ignore_ascii_case("authorization") {
                    let token = value
                        .strip_prefix("Bearer ")
                        .or_else(|| value.strip_prefix("bearer "))
                        .ok_or_else(|| {
                            anyhow!("only `Authorization = \"Bearer <token>\"` is supported")
                        })?;
                    transport_config = transport_config.auth_header(token.trim());
                    continue;
                }
                let key = http::HeaderName::from_bytes(key.as_bytes())
                    .with_context(|| format!("invalid header name `{key}`"))?;
                let value = http::HeaderValue::from_str(value)
                    .with_context(|| format!("invalid value for header `{key}`"))?;
                headers.insert(key, value);
            }
            let transport = StreamableHttpClientTransport::from_config(
                transport_config.custom_headers(headers),
            );
            handler
                .serve(transport)
                .await
                .map_err(|e| anyhow!("MCP handshake failed: {e}"))
        }
    }
}

/// rustls needs a process-wide crypto provider; install `ring` unless the
/// app already chose one.
fn install_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}
