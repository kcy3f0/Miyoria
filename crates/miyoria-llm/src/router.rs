use std::collections::HashMap;
use std::sync::Arc;

use futures::StreamExt;
use parking_lot::RwLock;
use serde::Serialize;
use tracing::warn;

use crate::types::{
    ChatProvider, ChatRequest, ChatResponse, ChatStream, ModelRef, StreamEvent, Usage,
};

#[derive(Clone, Debug, Default, Serialize)]
pub struct UsageRecord {
    pub calls: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_prompt_tokens: u64,
}

impl UsageRecord {
    fn add(&mut self, usage: &Usage) {
        self.calls += 1;
        self.prompt_tokens += u64::from(usage.prompt_tokens);
        self.completion_tokens += u64::from(usage.completion_tokens);
        self.cached_prompt_tokens += u64::from(usage.cached_prompt_tokens.unwrap_or(0));
    }
}

/// Routes requests by purpose to a chain of models, falling back to the next
/// model if one fails before producing any output.
pub struct LlmRouter {
    providers: HashMap<String, Arc<dyn ChatProvider>>,
    purposes: RwLock<HashMap<String, Vec<ModelRef>>>,
    usage: Arc<RwLock<HashMap<String, UsageRecord>>>,
}

impl LlmRouter {
    pub fn new(
        providers: HashMap<String, Arc<dyn ChatProvider>>,
        purposes: HashMap<String, Vec<ModelRef>>,
    ) -> Self {
        Self {
            providers,
            purposes: RwLock::new(purposes),
            usage: Arc::default(),
        }
    }

    /// Overrides purposes, e.g. with the active profile's `[llm.purposes]`.
    pub fn set_purposes(&self, overrides: HashMap<String, Vec<ModelRef>>) {
        self.purposes.write().extend(overrides);
    }

    pub fn chain(&self, purpose: &str) -> Vec<ModelRef> {
        let purposes = self.purposes.read();
        purposes
            .get(purpose)
            .or_else(|| purposes.get("chat"))
            .cloned()
            .unwrap_or_default()
    }

    pub fn has_purpose(&self, purpose: &str) -> bool {
        !self.chain(purpose).is_empty()
    }

    /// Usage per `provider:model` since startup.
    pub fn usage(&self) -> HashMap<String, UsageRecord> {
        self.usage.read().clone()
    }

    /// Streams a response for `purpose` (falls back to `chat` if the purpose
    /// is not configured). `request.model` is overwritten.
    pub async fn stream(&self, purpose: &str, request: ChatRequest) -> anyhow::Result<ChatStream> {
        let chain = self.chain(purpose);
        if chain.is_empty() {
            anyhow::bail!("no model configured for purpose `{purpose}` (and no `chat` fallback)");
        }
        let mut last_err = None;
        for model in chain {
            let Some(provider) = self.providers.get(&model.provider) else {
                warn!(%model, "unknown provider in model chain");
                last_err = Some(anyhow::anyhow!("unknown provider `{}`", model.provider));
                continue;
            };
            let mut req = request.clone();
            req.model.clone_from(&model.model);
            match provider.stream(req).await {
                Ok(mut stream) => {
                    // Only fall back if the model fails before its first event.
                    match stream.next().await {
                        Some(Err(e)) => {
                            warn!(%model, error = %e, "model failed, trying next in chain");
                            last_err = Some(e);
                        }
                        first => {
                            return Ok(self.track(model.to_string(), first, stream));
                        }
                    }
                }
                Err(e) => {
                    warn!(%model, error = %e, "model failed, trying next in chain");
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("all models failed")))
    }

    pub async fn complete(
        &self,
        purpose: &str,
        request: ChatRequest,
    ) -> anyhow::Result<ChatResponse> {
        ChatResponse::collect(self.stream(purpose, request).await?).await
    }

    fn track(
        &self,
        key: String,
        first: Option<anyhow::Result<StreamEvent>>,
        rest: ChatStream,
    ) -> ChatStream {
        let usage = self.usage.clone();
        futures::stream::iter(first)
            .chain(rest)
            .inspect(move |ev| {
                if let Ok(StreamEvent::Done { usage: Some(u), .. }) = ev {
                    usage.write().entry(key.clone()).or_default().add(u);
                }
            })
            .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::MockProvider;
    use crate::types::ChatMessage;

    fn router(primary: MockProvider) -> LlmRouter {
        let mut providers: HashMap<String, Arc<dyn ChatProvider>> = HashMap::new();
        providers.insert("a".into(), Arc::new(primary));
        providers.insert("b".into(), Arc::new(MockProvider::new("b").reply("from b")));
        let mut purposes = HashMap::new();
        purposes.insert(
            "chat".into(),
            vec!["a:m1".parse().unwrap(), "b:m2".parse().unwrap()],
        );
        LlmRouter::new(providers, purposes)
    }

    fn req() -> ChatRequest {
        ChatRequest {
            messages: vec![ChatMessage::user("hi")],
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn uses_first_model_and_falls_back_on_error() {
        let r = router(MockProvider::new("a").reply("from a"));
        assert_eq!(r.complete("fast", req()).await.unwrap().text, "from a");

        let r = router(MockProvider::new("a").fail("down"));
        assert_eq!(r.complete("chat", req()).await.unwrap().text, "from b");
        assert_eq!(r.usage()["b:m2"].calls, 1);
    }
}
