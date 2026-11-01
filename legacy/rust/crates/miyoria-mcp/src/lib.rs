//! MCP integration (module `mcp`).
//!
//! **Client.** Every server in `[mcp.servers.<name>]` is connected over stdio
//! or Streamable HTTP (concurrently, in the background; a server that fails to
//! start never fails the module). Its allowed tools are registered in the
//! shared `Arc<ToolRegistry>` as `mcp_<server>_<tool>`, requiring the server's
//! permission node (default `tools.mcp.<server>`) from the user who triggered
//! the turn. The tool list follows `tools/list_changed`, dead servers are
//! reconnected with backoff and their tools unregistered meanwhile, and
//! everything is unregistered on stop. [`McpStatus`] (service
//! `Arc<McpStatus>`) reports each server's state for the API and panel.
//!
//! **Server (optional).** With `[mcp.server] enabled = true` a bearer-token
//! protected Streamable HTTP endpoint at `http://<bind>/mcp` exposes read-only
//! inspection tools (`status`, `list_modules`, `list_tools`,
//! `recent_decisions`) to external agents. It cannot send messages or change
//! anything.
//!
//! See [`config`] for the configuration reference.

mod client;
pub mod config;
mod module;
pub mod policy;
mod server;
pub mod status;

pub use config::{ExposeConfig, McpConfig, ServerConfig, Transport};
pub use module::McpModule;
pub use status::{ExposeStatus, McpStatus, ServerState, ServerStatus};
