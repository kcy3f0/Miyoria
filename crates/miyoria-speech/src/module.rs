//! The `speech` module: builds providers from config and provides
//! [`SpeechService`].

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest};
use serde::Deserialize;

use crate::asr::{HttpWorkerAsrFactory, OpenAiAsrFactory};
use crate::tts::{GptSovitsFactory, HttpWorkerTtsFactory, OpenAiTtsFactory};
use crate::{AsrFactory, ProviderConfig, SpeechService, TtsFactory};

/// Top-level `[speech]` config section (not under `[modules.*]`; the app
/// passes it in, like `[llm]`).
///
/// ```toml
/// [speech.asr.local]
/// kind = "http-worker"
/// url = "http://127.0.0.1:8101"
///
/// [speech.asr.groq]
/// kind = "openai"
/// base_url = "https://api.groq.com/openai/v1"
/// api_key = "${GROQ_API_KEY}"
/// model = "whisper-large-v3-turbo"
///
/// [speech.tts.qwen]
/// kind = "http-worker"
/// url = "http://127.0.0.1:8102"
/// voice = "deepseek-chan"
///
/// [speech]
/// asr_chain = ["local", "groq"]   # default: all configured, in name order
/// tts_chain = ["qwen"]
/// ```
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SpeechConfig {
    pub asr: BTreeMap<String, ProviderConfig>,
    pub tts: BTreeMap<String, ProviderConfig>,
    /// Provider names in fallback order; `None` = every configured provider.
    pub asr_chain: Option<Vec<String>>,
    pub tts_chain: Option<Vec<String>>,
}

/// Module `speech`: provides `Arc<SpeechService>`.
pub struct SpeechModule {
    manifest: ModuleManifest,
    config: SpeechConfig,
    asr_factories: Vec<Box<dyn AsrFactory>>,
    tts_factories: Vec<Box<dyn TtsFactory>>,
}

/// All built-in ASR factories: `http-worker`, `openai`.
pub fn default_asr_factories() -> Vec<Box<dyn AsrFactory>> {
    vec![Box::new(HttpWorkerAsrFactory), Box::new(OpenAiAsrFactory)]
}

/// All built-in TTS factories: `http-worker`, `openai`, `gpt-sovits`.
pub fn default_tts_factories() -> Vec<Box<dyn TtsFactory>> {
    vec![
        Box::new(HttpWorkerTtsFactory),
        Box::new(OpenAiTtsFactory),
        Box::new(GptSovitsFactory),
    ]
}

impl SpeechModule {
    pub const ID: &'static str = "speech";

    pub fn new(
        config: SpeechConfig,
        asr_factories: Vec<Box<dyn AsrFactory>>,
        tts_factories: Vec<Box<dyn TtsFactory>>,
    ) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Speech")
                .description("ASR / TTS providers with fallback chains"),
            config,
            asr_factories,
            tts_factories,
        }
    }

    /// Registers every built-in provider kind.
    pub fn with_default_factories(config: SpeechConfig) -> Self {
        Self::new(config, default_asr_factories(), default_tts_factories())
    }

    /// Builds every configured provider and assembles the chains.
    pub fn build_service(&self) -> anyhow::Result<SpeechService> {
        let asr = build_chain(
            "asr",
            &self.config.asr,
            self.config.asr_chain.as_deref(),
            |name, cfg| {
                let f = self
                    .asr_factories
                    .iter()
                    .find(|f| f.kinds().contains(&cfg.kind.as_str()));
                f.ok_or_else(|| anyhow::anyhow!("unknown ASR kind `{}`", cfg.kind))?
                    .build(name, cfg)
            },
        )?;
        let tts = build_chain(
            "tts",
            &self.config.tts,
            self.config.tts_chain.as_deref(),
            |name, cfg| {
                let f = self
                    .tts_factories
                    .iter()
                    .find(|f| f.kinds().contains(&cfg.kind.as_str()));
                f.ok_or_else(|| anyhow::anyhow!("unknown TTS kind `{}`", cfg.kind))?
                    .build(name, cfg)
            },
        )?;
        Ok(SpeechService::new(asr, tts))
    }
}

/// Builds all providers of one family (so config errors surface even for
/// providers outside the chain), then picks the chain order.
fn build_chain<P: ?Sized>(
    family: &str,
    configs: &BTreeMap<String, ProviderConfig>,
    chain: Option<&[String]>,
    build: impl Fn(&str, &ProviderConfig) -> anyhow::Result<Arc<P>>,
) -> anyhow::Result<Vec<Arc<P>>> {
    let mut built = BTreeMap::new();
    for (name, cfg) in configs {
        let provider = build(name, cfg).with_context(|| format!("speech.{family}.{name}"))?;
        built.insert(name.as_str(), provider);
    }
    match chain {
        None => Ok(built.into_values().collect()),
        Some(names) => names
            .iter()
            .map(|n| {
                built
                    .get(n.as_str())
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("speech.{family}_chain: unknown provider `{n}`"))
            })
            .collect(),
    }
}

#[async_trait]
impl Module for SpeechModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let service = self.build_service()?;
        tracing::info!(
            asr = service.has_asr(),
            tts = service.has_tts(),
            "speech ready"
        );
        ctx.provide(Arc::new(service));
        Ok(())
    }
}
