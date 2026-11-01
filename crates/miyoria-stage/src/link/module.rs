use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;
use miyoria_commands::CommandRegistry;
use miyoria_kernel::{Health, Module, ModuleContext, ModuleManifest, TopicFilter};
use parking_lot::Mutex;
use tokio::net::TcpListener;
use tracing::{debug, info, warn};

use super::forward::{EMOTION_TOPIC, Forwarder};
use super::{StageLink, StageLinkConfig, commands, conn};

#[derive(Default)]
struct Running {
    link: Option<Arc<StageLink>>,
    registry: Option<Arc<CommandRegistry>>,
}

/// Module `stage.link`: serves the Stage Link WebSocket endpoint
/// (`ws://<bind>/stage-link`), forwards `agent.emotion`,
/// `agent.turn.completed` and `voice.playback` to the Stage node and provides
/// `Arc<StageLink>`. Registers the `stream` commands when
/// `Arc<CommandRegistry>` is available.
pub struct StageLinkModule {
    manifest: ModuleManifest,
    local_addr: Mutex<Option<SocketAddr>>,
    running: Mutex<Running>,
}

impl Default for StageLinkModule {
    fn default() -> Self {
        Self::new()
    }
}

impl StageLinkModule {
    pub const ID: &'static str = "stage.link";
    pub const DEFAULT_BIND: &'static str = "127.0.0.1:7882";

    pub fn new() -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Stage Link")
                .description("WebSocket link to the Stage node (VTube Studio, OBS, overlay)")
                .optional("commands"),
            local_addr: Mutex::new(None),
            running: Mutex::new(Running::default()),
        }
    }

    /// The address the server is bound to while running (useful with port 0).
    pub fn local_addr(&self) -> Option<SocketAddr> {
        *self.local_addr.lock()
    }
}

#[async_trait]
impl Module for StageLinkModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: StageLinkConfig = ctx.config()?;
        if config.token.trim().is_empty() {
            anyhow::bail!(
                "`[modules.\"stage.link\"] token` is empty: set the STAGE_LINK_TOKEN environment \
                 variable (with `token = \"${{STAGE_LINK_TOKEN}}\"`)"
            );
        }
        let listener = TcpListener::bind(config.bind.as_str())
            .await
            .with_context(|| format!("cannot bind stage link to `{}`", config.bind))?;
        let addr = listener.local_addr()?;
        if !addr.ip().is_loopback() {
            warn!(%addr, "stage link is reachable from the network over plain WebSocket");
        }
        *self.local_addr.lock() = Some(addr);
        info!(%addr, "stage link listening");

        let link = Arc::new(StageLink::new(
            ctx.id().clone(),
            ctx.bus().clone(),
            &config,
            ctx.cancellation().clone(),
        ));
        ctx.provide(link.clone());

        let mut events = ctx.subscribe(TopicFilter::new([
            EMOTION_TOPIC,
            "agent.turn.completed",
            "voice.playback",
        ]));
        let cancel = ctx.cancellation().clone();
        let forward_link = link.clone();
        let mut forwarder = Forwarder::new(config.subtitle_text_turns);
        ctx.spawn("forward", async move {
            loop {
                let env = tokio::select! {
                    () = cancel.cancelled() => return Ok(()),
                    env = events.recv() => match env {
                        Some(env) => env,
                        None => return Ok(()),
                    },
                };
                for msg in forwarder.on_event(&env.event) {
                    if !forward_link.send(&msg) && forward_link.is_connected() {
                        debug!("stage node queue full, dropping a message");
                    }
                }
            }
        });

        let registry = ctx.services().get::<CommandRegistry>();
        if let Some(registry) = &registry {
            commands::register(registry, link.clone())?;
        }
        *self.running.lock() = Running {
            link: Some(link.clone()),
            registry,
        };

        let app = conn::router(link);
        let shutdown = ctx.cancellation().clone().cancelled_owned();
        ctx.spawn("server", async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(shutdown)
                .await
                .context("stage link server failed")
        });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        *self.local_addr.lock() = None;
        let running = std::mem::take(&mut *self.running.lock());
        if let Some(registry) = running.registry {
            commands::unregister(&registry);
        }
        if let Some(link) = running.link {
            link.close_all();
        }
        Ok(())
    }

    async fn health(&self) -> Health {
        match &self.running.lock().link {
            Some(link) if !link.is_connected() => {
                Health::Degraded("stage node not connected".into())
            }
            _ => Health::Healthy,
        }
    }
}
