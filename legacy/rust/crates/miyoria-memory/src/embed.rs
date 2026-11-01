//! Text embeddings. Optional: the default provider is [`NoEmbedder`].

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use async_trait::async_trait;
use serde::Deserialize;

use crate::config::EmbeddingConfig;

#[async_trait]
pub trait Embedder: Send + Sync {
    /// Provider name for logs, e.g. `"openai-compatible"`.
    fn name(&self) -> &str;

    /// `false` when this embedder never produces vectors.
    fn enabled(&self) -> bool {
        true
    }

    /// One vector per input text, in order.
    async fn embed(&self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>>;
}

/// No embeddings; retrieval falls back to full text, recency and importance.
pub struct NoEmbedder;

#[async_trait]
impl Embedder for NoEmbedder {
    fn name(&self) -> &str {
        "none"
    }

    fn enabled(&self) -> bool {
        false
    }

    async fn embed(&self, _texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        Ok(Vec::new())
    }
}

/// `POST {base_url}/embeddings` in the OpenAI format (OpenAI, Ollama, LM
/// Studio, SiliconFlow, vLLM, ...).
pub struct OpenAiCompatibleEmbedder {
    client: reqwest::Client,
    url: String,
    api_key: Option<String>,
    model: String,
    dimensions: Option<u32>,
    batch_size: usize,
}

impl OpenAiCompatibleEmbedder {
    pub fn new(config: &EmbeddingConfig) -> anyhow::Result<Self> {
        if config.base_url.trim().is_empty() {
            anyhow::bail!("[memory.embedding] base_url is required for `openai-compatible`");
        }
        if config.model.trim().is_empty() {
            anyhow::bail!("[memory.embedding] model is required for `openai-compatible`");
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_secs.max(1)))
            .build()
            .context("building the embedding HTTP client")?;
        Ok(Self {
            client,
            url: format!("{}/embeddings", config.base_url.trim_end_matches('/')),
            api_key: config.api_key.clone().filter(|k| !k.is_empty()),
            model: config.model.clone(),
            dimensions: config.dimensions,
            batch_size: config.batch_size.max(1),
        })
    }

    async fn embed_batch(&self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        #[derive(Deserialize)]
        struct Item {
            #[serde(default)]
            index: Option<usize>,
            embedding: Vec<f32>,
        }
        #[derive(Deserialize)]
        struct Response {
            data: Vec<Item>,
        }

        let mut body = serde_json::json!({ "model": self.model, "input": texts });
        if let Some(d) = self.dimensions {
            body["dimensions"] = d.into();
        }
        let mut request = self.client.post(&self.url).json(&body);
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        let response = request.send().await.context("embedding request failed")?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let text: String = text.chars().take(300).collect();
            anyhow::bail!("embedding request failed with {status}: {text}");
        }
        let parsed: Response = response
            .json()
            .await
            .context("invalid embedding response")?;
        if parsed.data.len() != texts.len() {
            anyhow::bail!(
                "embedding response has {} vectors for {} inputs",
                parsed.data.len(),
                texts.len()
            );
        }
        let mut out = vec![Vec::new(); texts.len()];
        for (pos, item) in parsed.data.into_iter().enumerate() {
            let index = item.index.unwrap_or(pos);
            let slot = out
                .get_mut(index)
                .ok_or_else(|| anyhow::anyhow!("embedding index {index} out of range"))?;
            *slot = item.embedding;
        }
        if out
            .iter()
            .any(|v| v.is_empty() || v.iter().any(|x| !x.is_finite()))
        {
            anyhow::bail!("embedding response contains an empty or invalid vector");
        }
        Ok(out)
    }
}

#[async_trait]
impl Embedder for OpenAiCompatibleEmbedder {
    fn name(&self) -> &str {
        "openai-compatible"
    }

    async fn embed(&self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        let mut out = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(self.batch_size) {
            out.extend(self.embed_batch(chunk).await?);
        }
        Ok(out)
    }
}

/// Builds the embedder selected by `[memory.embedding] provider`.
pub fn build_embedder(config: &EmbeddingConfig) -> anyhow::Result<Arc<dyn Embedder>> {
    match config.provider.trim() {
        "" | "none" => Ok(Arc::new(NoEmbedder)),
        "openai-compatible" | "openai" | "ollama" => {
            Ok(Arc::new(OpenAiCompatibleEmbedder::new(config)?))
        }
        other => anyhow::bail!(
            "unknown [memory.embedding] provider `{other}` (expected `none` or `openai-compatible`)"
        ),
    }
}

/// Cosine similarity; 0 for empty or mismatched vectors.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}
