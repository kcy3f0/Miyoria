//! OpenAI-compatible Chat Completions provider.
//!
//! Register [`OpenAiFactory`] with `miyoria_llm::LlmModule` to handle the
//! provider kinds `openai-compatible`, `openai`, `deepseek` and `opencode`:
//!
//! ```toml
//! [llm.providers.deepseek]
//! kind = "deepseek"
//! base_url = "https://api.deepseek.com"
//! api_key = "${DEEPSEEK_API_KEY}"
//! # optional
//! timeout_secs = 120
//! max_retries = 2
//! headers = { "X-Title" = "Miyoria" }
//! ```
//!
//! Every request identifies itself with `User-Agent: miyoria/<version>`
//! (override with `user_agent = "..."`). When `session_header` is set, the
//! request's [`ChatRequest::session`](miyoria_llm::ChatRequest::session) (a
//! stable id per conversation) is sent in that header.
//!
//! # OpenCode
//!
//! Kind `opencode` talks to OpenCode's inference endpoint
//! (`https://opencode.ai/inference/go/v1` unless `base_url` is set). It needs
//! an API key and sends the conversation id in `x-opencode-session` by
//! default, which OpenCode uses for routing and prompt caching:
//!
//! ```toml
//! [llm.providers.opencode]
//! kind = "opencode"
//! api_key = "${OPENCODE_API_KEY}"
//! # [llm.purposes] chat = ["opencode:<model id>"]
//! ```

mod provider;
mod sse;
mod wire;

use std::sync::Arc;

use miyoria_llm::{ChatProvider, ProviderConfig, ProviderFactory};

pub use provider::{OpenAiConfig, OpenAiProvider};

/// [`ProviderFactory`] for [`OpenAiProvider`].
#[derive(Clone, Copy, Debug, Default)]
pub struct OpenAiFactory;

impl OpenAiFactory {
    pub const KINDS: &'static [&'static str] =
        &["openai-compatible", "openai", "deepseek", "opencode"];
}

impl ProviderFactory for OpenAiFactory {
    fn kinds(&self) -> &[&'static str] {
        Self::KINDS
    }

    fn build(&self, name: &str, config: &ProviderConfig) -> anyhow::Result<Arc<dyn ChatProvider>> {
        let build = || OpenAiProvider::new(name, OpenAiConfig::from_provider_config(config)?);
        let provider = build().map_err(|e| e.context(format!("provider `{name}`")))?;
        Ok(Arc::new(provider))
    }
}
