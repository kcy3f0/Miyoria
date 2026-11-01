//! Live status of the MCP client connections, for the API / panel.

use std::collections::BTreeMap;

use parking_lot::RwLock;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerState {
    /// `enabled = false` in config.
    Disabled,
    /// Connecting for the first time or reconnecting.
    Connecting,
    Connected,
    /// The last attempt failed or the connection dropped; retrying with backoff.
    Failed,
}

/// Status of one configured server.
#[derive(Clone, Debug, Serialize)]
pub struct ServerStatus {
    pub name: String,
    /// `"stdio"` or `"http"`.
    pub transport: String,
    pub state: ServerState,
    pub connected: bool,
    /// Registry names of the tools currently registered from this server.
    pub tools: Vec<String>,
    /// Tools the server offers, before allow / deny filtering.
    pub remote_tool_count: usize,
    /// Permission node required to use the tools, if any.
    pub permission: Option<String>,
    pub last_error: Option<String>,
    /// How many times the connection was (re)established after the first.
    pub reconnects: u32,
}

impl ServerStatus {
    pub(crate) fn new(name: &str, transport: &str, permission: Option<String>) -> Self {
        Self {
            name: name.to_owned(),
            transport: transport.to_owned(),
            state: ServerState::Connecting,
            connected: false,
            tools: Vec::new(),
            remote_tool_count: 0,
            permission,
            last_error: None,
            reconnects: 0,
        }
    }
}

/// State of the optional MCP server Miyoria exposes.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ExposeStatus {
    pub enabled: bool,
    /// Address actually listened on.
    pub listening: Option<String>,
    pub error: Option<String>,
}

/// Service `Arc<McpStatus>`: what the MCP module is connected to.
#[derive(Default)]
pub struct McpStatus {
    servers: RwLock<BTreeMap<String, ServerStatus>>,
    expose: RwLock<ExposeStatus>,
}

impl McpStatus {
    pub fn new() -> Self {
        Self::default()
    }

    /// All configured servers, ordered by name.
    pub fn servers(&self) -> Vec<ServerStatus> {
        self.servers.read().values().cloned().collect()
    }

    pub fn server(&self, name: &str) -> Option<ServerStatus> {
        self.servers.read().get(name).cloned()
    }

    pub fn connected_count(&self) -> usize {
        self.servers.read().values().filter(|s| s.connected).count()
    }

    /// All registered tool names across servers.
    pub fn tool_names(&self) -> Vec<String> {
        self.servers
            .read()
            .values()
            .flat_map(|s| s.tools.iter().cloned())
            .collect()
    }

    /// The exposed MCP server's state.
    pub fn expose(&self) -> ExposeStatus {
        self.expose.read().clone()
    }

    pub(crate) fn insert(&self, status: ServerStatus) {
        self.servers.write().insert(status.name.clone(), status);
    }

    pub(crate) fn update(&self, name: &str, f: impl FnOnce(&mut ServerStatus)) {
        if let Some(s) = self.servers.write().get_mut(name) {
            f(s);
            s.connected = s.state == ServerState::Connected;
        }
    }

    pub(crate) fn set_expose(&self, status: ExposeStatus) {
        *self.expose.write() = status;
    }

    /// Servers that are enabled but not connected.
    pub(crate) fn unavailable(&self) -> Vec<String> {
        self.servers
            .read()
            .values()
            .filter(|s| s.state != ServerState::Disabled && !s.connected)
            .map(|s| s.name.clone())
            .collect()
    }
}
