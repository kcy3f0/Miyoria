//! Admin API (module `api`): an HTTP + SSE server for the CLI and the admin
//! panel, plus a typed [`client::ApiClient`].
//!
//! ```toml
//! [modules.api]
//! bind = "127.0.0.1:7878"
//! token = "${MIYORIA_API_TOKEN}"
//! # Built panel served at `/` (skipped when missing). `MIYORIA_PANEL_DIR` overrides.
//! panel_dir = "apps/panel/dist"
//! ```
//!
//! Every `/api` route except `GET /api/health` requires
//! `Authorization: Bearer <token>`; panel files at `/` never do. Unknown
//! `/api/*` routes answer `404 {"error":"no such endpoint"}`. Errors are
//! `{"error": "..."}`; a missing service (its module is stopped) is `503`.
//! Changes are recorded in the `dyn AuditLog` (actor `"api"`) when there is one.
//!
//! The module looks these services up per request:
//!
//! | Service | Used by |
//! |---|---|
//! | [`SupervisorHandle`](miyoria_kernel::SupervisorHandle) | `/api/modules*`, `/api/extensions*`, `/api/mcp/*` |
//! | [`LlmRouter`](miyoria_llm::LlmRouter) | `/api/llm/*` |
//! | [`PersonaHandle`](miyoria_agent::PersonaHandle), `dyn PersonaOverrideStore` | `/api/persona*` |
//! | `dyn` [`DecisionLog`](miyoria_store::DecisionLog) | `/api/decisions` |
//! | [`ProfileId`](miyoria_types::ProfileId) (active profile) | profile-scoped routes |
//! | `dyn RelationshipStore`, `dyn IdentityStore`, `dyn PeopleStore` (optional), [`Social`](miyoria_social::Social) (changes) | `/api/people*` |
//! | [`MemoryEngine`](miyoria_memory::MemoryEngine) or `dyn MemoryRecordStore` | `/api/memory*` |
//! | [`AuthService`](miyoria_auth::AuthService) (changes), `dyn AuthStore` | `/api/auth/*` |
//! | [`ExtensionCatalog`](miyoria_ext_host::ExtensionCatalog) | `/api/extensions*` |
//! | [`McpStatus`](miyoria_mcp::McpStatus), `ToolRegistry` (descriptions) | `/api/mcp*` |
//! | [`RequestQueue`](miyoria_queue::RequestQueue) | `/api/queue*` |
//! | [`StageLink`](miyoria_stage::StageLink) | `/api/stage*` |
//! | `dyn VoiceSink` | `POST /api/stage/say` |
//! | `dyn AuditLog` (optional) | every change |
//!
//! Routes (shapes in [`types`]; the panel's `API-PLAN.md` has examples):
//!
//! * `GET /api/health` → `{ status, version }`
//! * `GET /api/modules`, `POST /api/modules/{id}/enable|disable|restart`
//! * `GET /api/decisions?limit=50&context=<json ContextKey>` (newest first)
//! * `GET /api/llm/usage`, `GET /api/llm/cost`
//! * `GET /api/persona`, `PUT /api/persona/{key}`, `GET /api/persona/{key}/history`
//! * `GET /api/people?q=&limit=&cursor=`, `GET|PATCH /api/people/{id}`, `POST /api/people/{id}/adjust`
//! * `GET /api/memory?q=&kind=&subject=&before=&include_superseded=&limit=`, `PATCH|DELETE /api/memory/{id}`
//! * `GET /api/auth/roles`, `GET|PUT|DELETE /api/auth/roles/{name}`,
//!   `GET|POST|DELETE /api/auth/assignments`, `GET|PUT|DELETE /api/auth/mappings`
//! * `GET /api/extensions`, `POST /api/extensions/{id}/enable|disable|restart`
//! * `GET /api/mcp`, `POST /api/mcp/{name}/restart`
//! * `GET /api/queue`, `POST /api/queue/{id}/skip|move`, `POST /api/queue/pause|resume`
//! * `GET /api/stage`, `POST /api/stage/scene|expression|stream|say`
//! * `GET /api/voice`
//! * `GET /api/events?topics=platform.*,agent.*` (Server-Sent Events of bus envelopes)

pub mod client;
mod memory;
mod monitor;
mod ops;
mod panel;
mod people;
mod roles;
mod server;
pub mod types;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::net::TcpListener;
use tracing::{debug, info, warn};

use crate::monitor::Monitor;

pub use client::{ApiClient, ClientError};
pub use panel::PANEL_DIR_ENV;

/// `[modules.api]` config section.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct ApiConfig {
    /// Listen address. Default `127.0.0.1:7878`.
    pub bind: String,
    /// Bearer token every protected request must present. Required.
    pub token: String,
    /// Built admin panel to serve at `/`, relative to the working
    /// directory. Default `apps/panel/dist`; [`PANEL_DIR_ENV`] overrides it,
    /// empty disables it, and a directory without `index.html` is skipped.
    pub panel_dir: String,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            bind: ApiModule::DEFAULT_BIND.to_owned(),
            token: String::new(),
            panel_dir: ApiModule::DEFAULT_PANEL_DIR.to_owned(),
        }
    }
}

/// Module `api`: serves the admin API until stopped.
pub struct ApiModule {
    manifest: ModuleManifest,
    local_addr: Mutex<Option<SocketAddr>>,
}

impl Default for ApiModule {
    fn default() -> Self {
        Self::new()
    }
}

impl ApiModule {
    pub const ID: &'static str = "api";
    pub const DEFAULT_BIND: &'static str = "127.0.0.1:7878";
    pub const DEFAULT_PANEL_DIR: &'static str = "apps/panel/dist";

    pub fn new() -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Admin API")
                .description("HTTP + SSE API for the CLI and the admin panel"),
            local_addr: Mutex::new(None),
        }
    }

    /// The address the server is bound to while running (useful with port 0).
    pub fn local_addr(&self) -> Option<SocketAddr> {
        *self.local_addr.lock()
    }
}

#[async_trait]
impl Module for ApiModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: ApiConfig = ctx.config()?;
        let token = config.token.trim();
        if token.is_empty() {
            anyhow::bail!(
                "`[modules.api] token` is empty: set the MIYORIA_API_TOKEN environment variable \
                 (with `token = \"${{MIYORIA_API_TOKEN}}\"`) or run `miyoria init`"
            );
        }
        let listener = TcpListener::bind(config.bind.as_str())
            .await
            .with_context(|| format!("cannot bind admin API to `{}`", config.bind))?;
        let addr = listener.local_addr()?;
        if !addr.ip().is_loopback() {
            warn!(%addr, "admin API is reachable from the network over plain HTTP");
        }
        *self.local_addr.lock() = Some(addr);
        info!(%addr, "admin API listening");

        let panel_dir = panel::pick_dir(std::env::var(PANEL_DIR_ENV).ok(), &config.panel_dir);
        match &panel_dir {
            Some(dir) => info!(dir = %dir.display(), "serving the admin panel at /"),
            None => debug!("no built admin panel found; not serving one"),
        }

        let monitor = Arc::new(Monitor::default());
        let sub = ctx.subscribe(monitor::topics());
        {
            let monitor = monitor.clone();
            let cancel = ctx.cancellation().clone();
            ctx.spawn("monitor", async move {
                monitor.run(sub, cancel).await;
                Ok(())
            });
        }

        let app = server::router(ctx.clone(), token, monitor, panel_dir);
        let shutdown = ctx.cancellation().clone().cancelled_owned();
        ctx.spawn("server", async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(shutdown)
                .await
                .context("admin API server failed")
        });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        *self.local_addr.lock() = None;
        Ok(())
    }
}
