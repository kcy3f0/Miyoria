//! Admin API (module `api`): an HTTP + SSE server for the CLI and the admin
//! panel, plus a typed [`client::ApiClient`].
//!
//! ```toml
//! [modules.api]
//! bind = "127.0.0.1:7878"
//! token = "${MIYORIA_API_TOKEN}"
//! ```
//!
//! Every route except `GET /api/health` requires `Authorization: Bearer <token>`.
//!
//! The module looks these services up per request; a missing one yields
//! `503 Service Unavailable`:
//!
//! | Service | Used by |
//! |---|---|
//! | [`SupervisorHandle`](miyoria_kernel::SupervisorHandle) | `/api/modules*` |
//! | [`LlmRouter`](miyoria_llm::LlmRouter) | `/api/llm/usage` |
//! | [`PersonaHandle`](miyoria_agent::PersonaHandle) | `/api/persona*` |
//! | `dyn` [`DecisionLog`](miyoria_store::DecisionLog) | `/api/decisions` |
//! | `dyn` [`PersonaOverrideStore`](miyoria_store::PersonaOverrideStore) | `/api/persona*` |
//! | [`ProfileId`](miyoria_types::ProfileId) (active profile) | `/api/decisions`, `/api/persona*` |
//!
//! Routes:
//!
//! * `GET /api/health` → `{ status, version }`
//! * `GET /api/modules`, `POST /api/modules/{id}/enable|disable|restart`
//! * `GET /api/decisions?limit=50&context=<json ContextKey>` (newest first)
//! * `GET /api/llm/usage`
//! * `GET /api/persona`, `PUT /api/persona/{key}`, `GET /api/persona/{key}/history`
//! * `GET /api/events?topics=platform.*,agent.*` (Server-Sent Events of bus envelopes)

pub mod client;
mod server;
pub mod types;

use std::net::SocketAddr;

use anyhow::Context;
use async_trait::async_trait;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::net::TcpListener;
use tracing::{info, warn};

pub use client::{ApiClient, ClientError};

/// `[modules.api]` config section.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct ApiConfig {
    /// Listen address. Default `127.0.0.1:7878`.
    pub bind: String,
    /// Bearer token every protected request must present. Required.
    pub token: String,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            bind: ApiModule::DEFAULT_BIND.to_owned(),
            token: String::new(),
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

        let app = server::router(ctx.clone(), token);
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
