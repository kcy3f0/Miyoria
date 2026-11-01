use std::future::Future;
use std::sync::Arc;

use futures::FutureExt;
use miyoria_types::{Event, ModuleId, TurnId};
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::{Instrument, error, info_span};

use crate::bus::{EventBus, Subscription, TopicFilter};
use crate::services::ServiceRegistry;

pub(crate) struct Failure {
    pub module: ModuleId,
    pub generation: u64,
    pub error: String,
}

/// Everything a module may use to interact with the rest of the system.
#[derive(Clone)]
pub struct ModuleContext {
    pub(crate) id: ModuleId,
    pub(crate) generation: u64,
    pub(crate) bus: EventBus,
    pub(crate) services: Arc<ServiceRegistry>,
    pub(crate) config: serde_json::Value,
    pub(crate) cancel: CancellationToken,
    pub(crate) tracker: TaskTracker,
    pub(crate) failures: mpsc::UnboundedSender<Failure>,
}

impl ModuleContext {
    pub fn id(&self) -> &ModuleId {
        &self.id
    }

    pub fn bus(&self) -> &EventBus {
        &self.bus
    }

    pub fn services(&self) -> &ServiceRegistry {
        &self.services
    }

    /// Cancelled when the module is being stopped.
    pub fn cancellation(&self) -> &CancellationToken {
        &self.cancel
    }

    /// Raw config section `[modules.<id>]` (without `enabled`).
    pub fn raw_config(&self) -> &serde_json::Value {
        &self.config
    }

    /// Deserializes the module's config section. Missing sections deserialize
    /// from an empty object, so `#[serde(default)]` structs work.
    pub fn config<T: DeserializeOwned>(&self) -> anyhow::Result<T> {
        let value = if self.config.is_null() {
            serde_json::Value::Object(Default::default())
        } else {
            self.config.clone()
        };
        serde_json::from_value(value)
            .map_err(|e| anyhow::anyhow!("invalid config for module `{}`: {e}", self.id))
    }

    pub fn publish(&self, event: Event) {
        self.bus.publish(&self.id, event, None);
    }

    pub fn publish_in_turn(&self, event: Event, turn: TurnId) {
        self.bus.publish(&self.id, event, Some(turn));
    }

    pub fn subscribe(&self, filter: TopicFilter) -> Subscription {
        self.bus.subscribe(filter)
    }

    pub fn provide<T>(&self, service: Arc<T>)
    where
        T: ?Sized + Send + Sync + 'static,
    {
        self.services.provide(&self.id, service);
    }

    /// Spawns a supervised task. If it returns an error or panics, the module
    /// is marked failed and restarted. The task should watch
    /// [`cancellation`](Self::cancellation) to exit promptly on stop.
    pub fn spawn<F>(&self, name: &'static str, fut: F)
    where
        F: Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        let failures = self.failures.clone();
        let module = self.id.clone();
        let generation = self.generation;
        let span = info_span!("task", module = %module, task = name);
        self.tracker.spawn(
            async move {
                let outcome = std::panic::AssertUnwindSafe(fut).catch_unwind().await;
                let error = match outcome {
                    Ok(Ok(())) => return,
                    Ok(Err(e)) => format!("task `{name}` failed: {e:#}"),
                    Err(panic) => {
                        let msg = panic
                            .downcast_ref::<&str>()
                            .map(|s| (*s).to_owned())
                            .or_else(|| panic.downcast_ref::<String>().cloned())
                            .unwrap_or_else(|| "unknown panic".to_owned());
                        format!("task `{name}` panicked: {msg}")
                    }
                };
                error!(%error, "module task ended abnormally");
                let _ = failures.send(Failure {
                    module,
                    generation,
                    error,
                });
            }
            .instrument(span),
        );
    }
}
