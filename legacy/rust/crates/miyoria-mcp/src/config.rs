//! Configuration: `[mcp.servers.<name>]` and `[mcp.server]`.
//!
//! The app reads the top-level `mcp` section and hands it to
//! [`McpModule::new`](crate::McpModule::new).
//!
//! ```toml
//! [mcp.servers.files]
//! transport = "stdio"
//! command = "npx"
//! args = ["-y", "@modelcontextprotocol/server-filesystem", "C:/data"]
//! tools_allow = ["read_*", "list_*"]
//! tools_deny = ["*delete*"]
//! permission = "tools.mcp.files"
//! timeout_ms = 30000
//! max_result_chars = 8000
//!
//! [mcp.servers.search]
//! transport = "http"
//! url = "https://example.com/mcp"
//! headers = { Authorization = "Bearer ${SEARCH_TOKEN}" }
//!
//! [mcp.server]
//! enabled = false
//! bind = "127.0.0.1:7881"
//! token = "${MIYORIA_MCP_TOKEN}"
//! ```

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context as _, bail};
use serde::Deserialize;

/// The whole `[mcp]` section.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct McpConfig {
    /// MCP servers Miyoria connects to, by name.
    pub servers: BTreeMap<String, ServerConfig>,
    /// The optional MCP server Miyoria exposes to external agents.
    pub server: ExposeConfig,
    /// First delay before reconnecting to a failed server; doubles up to
    /// `reconnect_max_ms`.
    pub reconnect_initial_ms: u64,
    pub reconnect_max_ms: u64,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            servers: BTreeMap::new(),
            server: ExposeConfig::default(),
            reconnect_initial_ms: 1_000,
            reconnect_max_ms: 60_000,
        }
    }
}

impl McpConfig {
    /// Parses the `mcp` section from JSON (`Config::section("mcp")`); `null`
    /// means defaults.
    pub fn from_value(value: &serde_json::Value) -> anyhow::Result<Self> {
        if value.is_null() {
            return Ok(Self::default());
        }
        serde_json::from_value(value.clone()).context("invalid `mcp` config section")
    }

    pub(crate) fn reconnect_initial(&self) -> Duration {
        Duration::from_millis(self.reconnect_initial_ms.max(1))
    }

    pub(crate) fn reconnect_max(&self) -> Duration {
        Duration::from_millis(self.reconnect_max_ms.max(self.reconnect_initial_ms).max(1))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    /// Spawn `command` and talk over its stdin/stdout.
    Stdio,
    /// Streamable HTTP at `url`.
    Http,
}

impl Transport {
    pub fn as_str(self) -> &'static str {
        match self {
            Transport::Stdio => "stdio",
            Transport::Http => "http",
        }
    }
}

/// One `[mcp.servers.<name>]` table.
#[derive(Clone, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub enabled: bool,
    /// `"stdio"` or `"http"`. Inferred from `url` / `command` when omitted.
    pub transport: Option<Transport>,

    /// stdio: program to run (resolved through `PATH`, so `npx` works on Windows).
    pub command: Option<String>,
    pub args: Vec<String>,
    /// Extra environment variables for the child process.
    pub env: BTreeMap<String, String>,
    pub cwd: Option<PathBuf>,

    /// http: Streamable HTTP endpoint.
    pub url: Option<String>,
    /// http: extra request headers. `Authorization = "Bearer <token>"` is
    /// supported; other authorization schemes are not.
    pub headers: BTreeMap<String, String>,

    /// Only tools matching one of these patterns are offered (`*` and `?`
    /// wildcards, matched against the server's own tool name). Empty = all.
    pub tools_allow: Vec<String>,
    /// Tools matching any of these patterns are never offered; wins over allow.
    pub tools_deny: Vec<String>,
    /// Permission node the triggering user needs to use this server's tools.
    /// Default `tools.mcp.<server>`; an empty string disables the check.
    pub permission: Option<String>,
    /// Per-call timeout.
    pub timeout_ms: u64,
    /// Timeout for connecting and listing tools.
    pub connect_timeout_ms: u64,
    /// Tool results longer than this many characters are cut (0 = no limit).
    pub max_result_chars: usize,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            transport: None,
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: None,
            url: None,
            headers: BTreeMap::new(),
            tools_allow: Vec::new(),
            tools_deny: Vec::new(),
            permission: None,
            timeout_ms: 30_000,
            connect_timeout_ms: 20_000,
            max_result_chars: 8_000,
        }
    }
}

// Env values and headers usually carry secrets, so only their names are shown.
impl fmt::Debug for ServerConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerConfig")
            .field("enabled", &self.enabled)
            .field("transport", &self.transport)
            .field("command", &self.command)
            .field("args", &self.args)
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("cwd", &self.cwd)
            .field("url", &self.url)
            .field("headers", &self.headers.keys().collect::<Vec<_>>())
            .field("tools_allow", &self.tools_allow)
            .field("tools_deny", &self.tools_deny)
            .field("permission", &self.permission)
            .field("timeout_ms", &self.timeout_ms)
            .field("max_result_chars", &self.max_result_chars)
            .finish_non_exhaustive()
    }
}

impl ServerConfig {
    /// The transport, inferred when not set explicitly.
    pub fn effective_transport(&self) -> Transport {
        self.transport
            .unwrap_or(if self.url.is_some() && self.command.is_none() {
                Transport::Http
            } else {
                Transport::Stdio
            })
    }

    /// The permission node required from the triggering user, if any.
    pub fn permission_node(&self, server: &str) -> Option<String> {
        match self.permission.as_deref().map(str::trim) {
            None => Some(format!("tools.mcp.{server}")),
            Some("") => None,
            Some(node) => Some(node.to_owned()),
        }
    }

    pub fn call_timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms.max(1))
    }

    pub fn connect_timeout(&self) -> Duration {
        Duration::from_millis(self.connect_timeout_ms.max(1))
    }

    /// Checks that the server's name and transport fields are usable.
    pub fn validate(&self, name: &str) -> anyhow::Result<()> {
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            bail!("server name `{name}` must be ASCII letters, digits, `_` or `-`");
        }
        match self.effective_transport() {
            Transport::Stdio => {
                if self.command.as_deref().is_none_or(|c| c.trim().is_empty()) {
                    bail!("stdio transport needs `command`");
                }
            }
            Transport::Http => {
                let url = self.url.as_deref().unwrap_or_default();
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    bail!("http transport needs `url` starting with http:// or https://");
                }
            }
        }
        Ok(())
    }
}

/// `[mcp.server]`: the MCP server Miyoria itself exposes (read-only tools).
#[derive(Clone, Deserialize)]
#[serde(default)]
pub struct ExposeConfig {
    pub enabled: bool,
    pub bind: String,
    /// Bearer token clients must send. Required when enabled.
    pub token: String,
    /// Extra `Host` header values to accept besides loopback names (needed
    /// when binding a non-loopback address).
    pub allowed_hosts: Vec<String>,
}

impl Default for ExposeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: "127.0.0.1:7881".to_owned(),
            token: String::new(),
            allowed_hosts: Vec::new(),
        }
    }
}

impl fmt::Debug for ExposeConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExposeConfig")
            .field("enabled", &self.enabled)
            .field("bind", &self.bind)
            .field("token", &"<redacted>")
            .field("allowed_hosts", &self.allowed_hosts)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_toml_like_json() {
        let cfg = McpConfig::from_value(&serde_json::json!({
            "servers": {
                "files": {"transport": "stdio", "command": "npx", "args": ["-y", "x"],
                          "tools_deny": ["*delete*"]},
                "web": {"url": "https://h/mcp", "headers": {"Authorization": "Bearer t"}},
                "off": {"enabled": false, "command": "x"}
            },
            "server": {"enabled": true, "token": "s"}
        }))
        .unwrap();
        assert_eq!(cfg.servers.len(), 3);
        assert_eq!(cfg.servers["files"].effective_transport(), Transport::Stdio);
        assert_eq!(cfg.servers["web"].effective_transport(), Transport::Http);
        assert!(!cfg.servers["off"].enabled);
        assert_eq!(cfg.servers["files"].timeout_ms, 30_000);
        assert!(cfg.server.enabled);
        assert_eq!(cfg.server.bind, "127.0.0.1:7881");
        assert!(
            McpConfig::from_value(&serde_json::Value::Null)
                .unwrap()
                .servers
                .is_empty()
        );
    }

    #[test]
    fn permission_default_and_override() {
        let mut s = ServerConfig::default();
        assert_eq!(
            s.permission_node("files").as_deref(),
            Some("tools.mcp.files")
        );
        s.permission = Some("tools.custom".into());
        assert_eq!(s.permission_node("files").as_deref(), Some("tools.custom"));
        s.permission = Some(String::new());
        assert_eq!(s.permission_node("files"), None);
    }

    #[test]
    fn validation() {
        let stdio = ServerConfig {
            command: Some("x".into()),
            ..Default::default()
        };
        assert!(stdio.validate("ok-1_a").is_ok());
        assert!(stdio.validate("bad name").is_err());
        assert!(stdio.validate("").is_err());
        assert!(ServerConfig::default().validate("a").is_err());
        let http = ServerConfig {
            transport: Some(Transport::Http),
            url: Some("ftp://x".into()),
            ..Default::default()
        };
        assert!(http.validate("a").is_err());
    }

    #[test]
    fn debug_hides_secrets() {
        let mut s = ServerConfig::default();
        s.headers
            .insert("Authorization".into(), "Bearer sekrit".into());
        s.env.insert("KEY".into(), "sekrit".into());
        assert!(!format!("{s:?}").contains("sekrit"));
        let e = ExposeConfig {
            token: "sekrit".into(),
            ..Default::default()
        };
        assert!(!format!("{e:?}").contains("sekrit"));
    }
}
