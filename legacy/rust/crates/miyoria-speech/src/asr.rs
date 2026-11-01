//! ASR providers: the Miyoria inference-worker protocol and OpenAI-compatible
//! `/audio/transcriptions`.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;

use crate::http::{bearer_headers, ensure_ok, join_url, parse_settings};
use crate::{AsrFactory, AsrHint, AsrProvider, AudioBuf, ProviderConfig, Transcript, wav};

const DEFAULT_TIMEOUT_SECS: u64 = 20;

fn wav_part(audio: &AudioBuf, field: &'static str) -> anyhow::Result<(&'static str, Part)> {
    let part = Part::bytes(wav::encode(audio))
        .file_name("audio.wav")
        .mime_str("audio/wav")?;
    Ok((field, part))
}

// ---------------------------------------------------------------- http-worker

/// Settings for [`HttpWorkerAsr`] (`kind = "http-worker"`).
///
/// ```toml
/// [speech.asr.local]
/// kind = "http-worker"
/// url = "http://127.0.0.1:8101"
/// timeout_secs = 20   # optional
/// ```
#[derive(Clone, Debug, Deserialize)]
pub struct HttpWorkerAsrConfig {
    /// Worker root; `POST {url}/asr`.
    pub url: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECS
}

/// ASR client for an inference worker (see `docs/protocols/voice-link.md`).
pub struct HttpWorkerAsr {
    name: String,
    url: String,
    client: reqwest::Client,
}

impl HttpWorkerAsr {
    pub fn new(name: impl Into<String>, config: HttpWorkerAsrConfig) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5).min(Duration::from_secs(config.timeout_secs)))
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()?;
        Ok(Self {
            name: name.into(),
            url: join_url(&config.url, "asr"),
            client,
        })
    }
}

#[derive(Deserialize)]
struct WorkerReply {
    text: String,
    language: Option<String>,
    emotion: Option<String>,
    #[serde(default)]
    audio_events: Vec<String>,
}

#[async_trait]
impl AsrProvider for HttpWorkerAsr {
    fn name(&self) -> &str {
        &self.name
    }

    async fn transcribe(&self, audio: &AudioBuf, hint: &AsrHint) -> anyhow::Result<Transcript> {
        let (field, part) = wav_part(audio, "audio")?;
        let mut form = Form::new().part(field, part);
        if let Some(l) = &hint.language {
            form = form.text("language", l.clone());
        }
        if let Some(p) = &hint.prompt {
            form = form.text("prompt", p.clone());
        }
        let resp = self.client.post(&self.url).multipart(form).send().await?;
        let reply: WorkerReply = ensure_ok(resp)
            .await?
            .json()
            .await
            .context("invalid ASR worker response")?;
        Ok(Transcript {
            text: reply.text,
            language: reply.language,
            emotion: reply.emotion,
            audio_events: reply.audio_events,
        })
    }
}

/// [`AsrFactory`] for `http-worker`.
#[derive(Clone, Copy, Debug, Default)]
pub struct HttpWorkerAsrFactory;

impl AsrFactory for HttpWorkerAsrFactory {
    fn kinds(&self) -> &[&'static str] {
        &["http-worker"]
    }

    fn build(&self, name: &str, config: &ProviderConfig) -> anyhow::Result<Arc<dyn AsrProvider>> {
        let cfg: HttpWorkerAsrConfig = parse_settings(config)?;
        Ok(Arc::new(HttpWorkerAsr::new(name, cfg)?))
    }
}

// --------------------------------------------------------------------- openai

/// Settings for [`OpenAiAsr`] (`kind = "openai"`).
///
/// ```toml
/// [speech.asr.groq]
/// kind = "openai"
/// base_url = "https://api.groq.com/openai/v1"
/// api_key = "${GROQ_API_KEY}"
/// model = "whisper-large-v3-turbo"
/// ```
#[derive(Clone, Debug, Deserialize)]
pub struct OpenAiAsrConfig {
    #[serde(default = "default_openai_base")]
    pub base_url: String,
    pub api_key: Option<String>,
    #[serde(default = "default_asr_model")]
    pub model: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_openai_base() -> String {
    "https://api.openai.com/v1".to_owned()
}

fn default_asr_model() -> String {
    "whisper-1".to_owned()
}

/// Client for OpenAI-compatible `POST {base_url}/audio/transcriptions`
/// (OpenAI, Groq, faster-whisper-server, ...).
pub struct OpenAiAsr {
    name: String,
    url: String,
    model: String,
    client: reqwest::Client,
}

impl OpenAiAsr {
    pub fn new(name: impl Into<String>, config: OpenAiAsrConfig) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .default_headers(bearer_headers(config.api_key.as_deref())?)
            .connect_timeout(Duration::from_secs(5).min(Duration::from_secs(config.timeout_secs)))
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()?;
        Ok(Self {
            name: name.into(),
            url: join_url(&config.base_url, "audio/transcriptions"),
            model: config.model,
            client,
        })
    }
}

#[derive(Deserialize)]
struct OpenAiReply {
    text: String,
}

#[async_trait]
impl AsrProvider for OpenAiAsr {
    fn name(&self) -> &str {
        &self.name
    }

    async fn transcribe(&self, audio: &AudioBuf, hint: &AsrHint) -> anyhow::Result<Transcript> {
        let (field, part) = wav_part(audio, "file")?;
        let mut form = Form::new()
            .part(field, part)
            .text("model", self.model.clone())
            .text("response_format", "json");
        if let Some(l) = &hint.language {
            form = form.text("language", l.clone());
        }
        if let Some(p) = &hint.prompt {
            form = form.text("prompt", p.clone());
        }
        let resp = self.client.post(&self.url).multipart(form).send().await?;
        let reply: OpenAiReply = ensure_ok(resp)
            .await?
            .json()
            .await
            .context("invalid transcription response")?;
        Ok(Transcript {
            text: reply.text,
            // The plain `json` format does not report the detected language.
            language: hint.language.clone(),
            ..Transcript::default()
        })
    }
}

/// [`AsrFactory`] for `openai`.
#[derive(Clone, Copy, Debug, Default)]
pub struct OpenAiAsrFactory;

impl AsrFactory for OpenAiAsrFactory {
    fn kinds(&self) -> &[&'static str] {
        &["openai"]
    }

    fn build(&self, name: &str, config: &ProviderConfig) -> anyhow::Result<Arc<dyn AsrProvider>> {
        let cfg: OpenAiAsrConfig = parse_settings(config)?;
        Ok(Arc::new(OpenAiAsr::new(name, cfg)?))
    }
}
