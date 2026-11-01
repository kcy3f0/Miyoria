use async_trait::async_trait;
use miyoria_types::ModuleId;
use serde::{Deserialize, Serialize};

use crate::context::ModuleContext;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModuleManifest {
    pub id: ModuleId,
    pub name: String,
    pub description: String,
    /// Must be running for this module to start. Disabling one of these stops
    /// this module too.
    pub requires: Vec<ModuleId>,
    /// Started first when present, but their absence only degrades this module.
    pub optional: Vec<ModuleId>,
    /// JSON Schema of the module's config section (`[modules.<id>]`).
    pub config_schema: Option<serde_json::Value>,
}

impl ModuleManifest {
    pub fn new(id: impl Into<ModuleId>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            requires: Vec::new(),
            optional: Vec::new(),
            config_schema: None,
        }
    }

    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = description.into();
        self
    }

    pub fn requires(mut self, id: impl Into<ModuleId>) -> Self {
        self.requires.push(id.into());
        self
    }

    pub fn optional(mut self, id: impl Into<ModuleId>) -> Self {
        self.optional.push(id.into());
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", content = "reason", rename_all = "snake_case")]
pub enum Health {
    Healthy,
    Degraded(String),
    Unhealthy(String),
}

/// A subsystem managed by the supervisor.
///
/// `start` must return quickly: long-running work goes into tasks spawned with
/// [`ModuleContext::spawn`], which the supervisor tracks and cancels on stop.
/// A spawned task that returns an error or panics marks the module as failed
/// and triggers a restart with backoff.
#[async_trait]
pub trait Module: Send + Sync + 'static {
    fn manifest(&self) -> &ModuleManifest;

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()>;

    /// Called before the module's tasks are cancelled. Default: nothing.
    async fn stop(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn health(&self) -> Health {
        Health::Healthy
    }
}
