use std::sync::Arc;

use async_trait::async_trait;
use miyoria_commands::CommandRegistry;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest};
use miyoria_store::SettingsStore;
use miyoria_types::SocialSignals;
use parking_lot::Mutex;
use tracing::{info, warn};

use crate::commands::register_commands;
use crate::config::QueueConfig;
use crate::queue::RequestQueue;

struct Running {
    queue: Arc<RequestQueue>,
    registry: Option<(Arc<CommandRegistry>, Vec<String>)>,
}

/// Module `queue`: provides `Arc<RequestQueue>`, restores and snapshots its
/// state, publishes `queue.*` events and registers the queue commands.
///
/// Uses the optional services `dyn SettingsStore` (persistence),
/// `dyn SocialSignals` (affinity weighting) and `CommandRegistry` (commands,
/// module `commands`). Config: see [`QueueConfig`].
pub struct QueueModule {
    manifest: ModuleManifest,
    running: Mutex<Option<Running>>,
}

impl Default for QueueModule {
    fn default() -> Self {
        Self::new()
    }
}

impl QueueModule {
    pub const ID: &'static str = "queue";

    pub fn new() -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Request queue")
                .description("Fair request queue with voting mode")
                .optional("commands")
                .optional("social"),
            running: Mutex::new(None),
        }
    }
}

#[async_trait]
impl Module for QueueModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: QueueConfig = ctx.config()?;
        let bus = ctx.bus().clone();
        let id = ctx.id().clone();
        let queue = Arc::new(
            RequestQueue::new(config)
                .with_social(ctx.services().get::<dyn SocialSignals>())
                .with_store(ctx.services().get::<dyn SettingsStore>())
                .with_publisher(Arc::new(move |event| bus.publish(&id, event, None))),
        );
        match queue.restore().await {
            Ok(true) => info!("restored the request queue"),
            Ok(false) => {}
            Err(e) => warn!(error = %e, "could not restore the request queue; starting empty"),
        }

        let registry = match ctx.services().get::<CommandRegistry>() {
            Some(registry) => {
                let paths = register_commands(&registry, &queue)?;
                Some((registry, paths))
            }
            None => None,
        };

        ctx.provide(queue.clone());
        let runner = queue.clone();
        let cancel = ctx.cancellation().clone();
        ctx.spawn("queue", async move {
            runner.run(cancel).await;
            Ok(())
        });
        *self.running.lock() = Some(Running { queue, registry });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        let running = self.running.lock().take();
        if let Some(running) = running {
            if let Some((registry, paths)) = &running.registry {
                for path in paths {
                    registry.unregister(path);
                }
            }
            running.queue.persist().await?;
        }
        Ok(())
    }
}
