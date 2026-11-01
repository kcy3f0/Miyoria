//! Extension host (module `extensions`).
//!
//! Extensions are separate processes described by `miyoria.extension.toml`.
//! Each one runs as its own supervisor module `ext.<id>` and talks JSON-RPC
//! 2.0 over stdio with `Content-Length` framing
//! (`docs/protocols/extension-rpc.md`). The host proxies what an extension
//! registers into the shared registries: tools into `Arc<ToolRegistry>`,
//! commands into `Arc<CommandRegistry>`, prompt contributors into
//! `Arc<PromptContributors>`, and forwards bus events it is allowed to see.
//!
//! The app calls [`discover`] before starting the supervisor and registers
//! every returned module; [`cli`] holds the `ext` subcommand logic.

pub mod cli;
pub mod config;
pub mod extension;
pub mod host;
pub mod manifest;
pub mod protocol;
mod proxy;
pub mod rpc;
pub mod watch;

pub use config::{ExtensionSettings, HostConfig, PermissionOverride};
pub use extension::{ExtensionModule, ExtensionSpec};
pub use host::{
    CatalogEntry, DiscoveredModule, Discovery, ExtensionCatalog, ExtensionsModule, discover,
    discover_in, find_extension_dirs,
};
pub use manifest::{
    ExtensionManifest, MANIFEST_FILE, McpServerSpec, Permissions, Placement, Runtime,
};
