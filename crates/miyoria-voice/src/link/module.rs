use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest, TopicFilter};
use miyoria_types::Event;
use parking_lot::Mutex;
use tokio::net::TcpListener;
use tracing::{info, warn};

use super::{VoiceLink, VoiceLinkConfig, conn};

/// Module `voice.link`: serves the Voice Link WebSocket endpoint
/// (`ws://<bind>/voice-link`) and provides `Arc<VoiceLink>`.
pub struct VoiceLinkModule {
    manifest: ModuleManifest,
    local_addr: Mutex<Option<SocketAddr>>,
    link: Mutex<Option<Arc<VoiceLink>>>,
}

impl Default for VoiceLinkModule {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceLinkModule {
    pub const ID: &'static str = "voice.link";
    pub const DEFAULT_BIND: &'static str = "127.0.0.1:7879";

    pub fn new() -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Voice Link")
                .description("WebSocket link to the self voice node (Discord voice I/O)"),
            local_addr: Mutex::new(None),
            link: Mutex::new(None),
        }
    }

    /// The address the server is bound to while running (useful with port 0).
    pub fn local_addr(&self) -> Option<SocketAddr> {
        *self.local_addr.lock()
    }
}

#[async_trait]
impl Module for VoiceLinkModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: VoiceLinkConfig = ctx.config()?;
        if config.token.trim().is_empty() {
            anyhow::bail!(
                "`[modules.\"voice.link\"] token` is empty: set the VOICE_LINK_TOKEN environment \
                 variable (with `token = \"${{VOICE_LINK_TOKEN}}\"`)"
            );
        }
        let listener = TcpListener::bind(config.bind.as_str())
            .await
            .with_context(|| format!("cannot bind voice link to `{}`", config.bind))?;
        let addr = listener.local_addr()?;
        if !addr.ip().is_loopback() {
            warn!(%addr, "voice link is reachable from the network over plain WebSocket");
        }
        *self.local_addr.lock() = Some(addr);
        info!(%addr, "voice link listening");

        let link = Arc::new(VoiceLink::new(
            ctx.id().clone(),
            ctx.bus().clone(),
            &config,
            ctx.cancellation().clone(),
        ));
        *self.link.lock() = Some(link.clone());
        ctx.provide(link.clone());

        // Remember her other accounts (e.g. the bot account) for `is_self`.
        let mut ready = ctx.subscribe(TopicFilter::new(["platform.ready"]));
        let cancel = ctx.cancellation().clone();
        let tracked = link.clone();
        ctx.spawn("self-accounts", async move {
            loop {
                tokio::select! {
                    () = cancel.cancelled() => return Ok(()),
                    env = ready.recv() => match env {
                        Some(env) => {
                            if let Event::PlatformReady { self_account, .. } = &env.event {
                                tracked.add_self_account(self_account.clone());
                            }
                        }
                        None => return Ok(()),
                    },
                }
            }
        });

        let app = conn::router(link);
        let shutdown = ctx.cancellation().clone().cancelled_owned();
        ctx.spawn("server", async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(shutdown)
                .await
                .context("voice link server failed")
        });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        *self.local_addr.lock() = None;
        if let Some(link) = self.link.lock().take() {
            link.close_all();
        }
        Ok(())
    }
}
