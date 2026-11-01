use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest};
use serde::Deserialize;

use crate::router::LlmRouter;
use crate::types::{ChatProvider, ModelRef};

/// `[llm]` config section.
///
/// ```toml
/// [llm.providers.deepseek]
/// kind = "openai-compatible"
/// base_url = "https://api.deepseek.com"
/// api_key = "${DEEPSEEK_API_KEY}"
///
/// [llm.purposes]
/// chat = ["deepseek:deepseek-chat"]
/// ```
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct LlmConfig {
    pub providers: HashMap<String, ProviderConfig>,
    pub purposes: HashMap<String, Vec<ModelRef>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ProviderConfig {
    pub kind: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    /// Provider-specific settings.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Builds providers of one `kind`. Provider crates export a factory; the app
/// registers them with [`LlmModule::new`].
pub trait ProviderFactory: Send + Sync {
    fn kinds(&self) -> &[&'static str];
    fn build(&self, name: &str, config: &ProviderConfig) -> anyhow::Result<Arc<dyn ChatProvider>>;
}

/// Module `llm`: provides [`LlmRouter`] as a service.
pub struct LlmModule {
    manifest: ModuleManifest,
    config: LlmConfig,
    factories: Vec<Box<dyn ProviderFactory>>,
    /// Purpose overrides from the active profile.
    overrides: HashMap<String, Vec<ModelRef>>,
}

impl LlmModule {
    pub const ID: &'static str = "llm";

    pub fn new(config: LlmConfig, factories: Vec<Box<dyn ProviderFactory>>) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "LLM")
                .description("Model providers and purpose-based routing"),
            config,
            factories,
            overrides: HashMap::new(),
        }
    }

    pub fn with_purpose_overrides(mut self, overrides: HashMap<String, Vec<ModelRef>>) -> Self {
        self.overrides = overrides;
        self
    }

    pub fn build_router(&self) -> anyhow::Result<LlmRouter> {
        let mut providers = HashMap::new();
        for (name, cfg) in &self.config.providers {
            let factory = self
                .factories
                .iter()
                .find(|f| f.kinds().contains(&cfg.kind.as_str()))
                .ok_or_else(|| anyhow::anyhow!("provider `{name}`: unknown kind `{}`", cfg.kind))?;
            providers.insert(name.clone(), factory.build(name, cfg)?);
        }
        let router = LlmRouter::new(providers, self.config.purposes.clone());
        router.set_purposes(self.overrides.clone());
        Ok(router)
    }
}

#[async_trait]
impl Module for LlmModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        ctx.provide(Arc::new(self.build_router()?));
        Ok(())
    }
}
