//! TTS providers: the Miyoria inference-worker protocol, OpenAI-compatible
//! `/audio/speech`, vLLM-Omni (true streaming for Qwen3-TTS) and GPT-SoVITS
//! (api_v2).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::header::CONTENT_TYPE;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::http::{bearer_headers, ensure_ok, join_url, parse_settings};
use crate::pcm::{pcm_stream, rate_from_content_type};
use crate::{AudioStream, ProviderConfig, TtsFactory, TtsProvider, TtsRequest};

const DEFAULT_TIMEOUT_SECS: u64 = 30;

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECS
}

/// The timeout applies while waiting for response headers and between body
/// chunks (not to the whole stream), so long utterances are fine.
fn stream_client(
    timeout_secs: u64,
    headers: reqwest::header::HeaderMap,
) -> anyhow::Result<reqwest::Client> {
    let timeout = Duration::from_secs(timeout_secs);
    Ok(reqwest::Client::builder()
        .default_headers(headers)
        .connect_timeout(Duration::from_secs(5).min(timeout))
        .read_timeout(timeout)
        .build()?)
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.trim().is_empty())
}

// ---------------------------------------------------------------- http-worker

/// Settings for [`HttpWorkerTts`] (`kind = "http-worker"`).
///
/// ```toml
/// [speech.tts.qwen]
/// kind = "http-worker"
/// url = "http://127.0.0.1:8102"
/// voice = "deepseek-chan"   # optional default voice
/// timeout_secs = 30         # optional, idle timeout
/// ```
#[derive(Clone, Debug, Deserialize)]
pub struct HttpWorkerTtsConfig {
    /// Worker root; `POST {url}/tts`.
    pub url: String,
    /// Used when the request names no voice.
    pub voice: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

/// TTS client for an inference worker (see `docs/protocols/voice-link.md`).
pub struct HttpWorkerTts {
    name: String,
    url: String,
    voice: Option<String>,
    client: reqwest::Client,
}

impl HttpWorkerTts {
    pub fn new(name: impl Into<String>, config: HttpWorkerTtsConfig) -> anyhow::Result<Self> {
        Ok(Self {
            name: name.into(),
            url: join_url(&config.url, "tts"),
            voice: non_empty(config.voice),
            client: stream_client(config.timeout_secs, Default::default())?,
        })
    }
}

#[derive(Serialize)]
struct WorkerBody<'a> {
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    emotion: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instruct: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    voice: Option<&'a str>,
}

#[async_trait]
impl TtsProvider for HttpWorkerTts {
    fn name(&self) -> &str {
        &self.name
    }

    async fn synthesize(&self, request: TtsRequest) -> anyhow::Result<AudioStream> {
        let body = WorkerBody {
            text: &request.text,
            language: request.language.as_deref(),
            emotion: request.emotion.as_deref(),
            instruct: request.instruct.as_deref(),
            voice: request.voice.as_deref().or(self.voice.as_deref()),
        };
        let resp = self.client.post(&self.url).json(&body).send().await?;
        let resp = ensure_ok(resp).await?;
        let header = |name: &str| resp.headers().get(name).and_then(|v| v.to_str().ok());
        let rate = header("x-sample-rate")
            .and_then(|v| v.trim().parse().ok())
            .or_else(|| header(CONTENT_TYPE.as_str()).and_then(rate_from_content_type))
            .ok_or_else(|| anyhow::anyhow!("TTS worker sent no sample rate"))?;
        Ok(pcm_stream(resp.bytes_stream(), rate))
    }
}

/// [`TtsFactory`] for `http-worker`.
#[derive(Clone, Copy, Debug, Default)]
pub struct HttpWorkerTtsFactory;

impl TtsFactory for HttpWorkerTtsFactory {
    fn kinds(&self) -> &[&'static str] {
        &["http-worker"]
    }

    fn build(&self, name: &str, config: &ProviderConfig) -> anyhow::Result<Arc<dyn TtsProvider>> {
        let cfg: HttpWorkerTtsConfig = parse_settings(config)?;
        Ok(Arc::new(HttpWorkerTts::new(name, cfg)?))
    }
}

// --------------------------------------------------------------------- openai

/// Sample rate of OpenAI's `pcm` response format.
const OPENAI_PCM_RATE: u32 = 24_000;

/// Settings for [`OpenAiTts`] (`kind = "openai"`).
///
/// ```toml
/// [speech.tts.cloud]
/// kind = "openai"
/// api_key = "${OPENAI_API_KEY}"
/// model = "tts-1"
/// voice = "nova"
/// ```
#[derive(Clone, Debug, Deserialize)]
pub struct OpenAiTtsConfig {
    #[serde(default = "default_openai_base")]
    pub base_url: String,
    pub api_key: Option<String>,
    #[serde(default = "default_tts_model")]
    pub model: String,
    /// Used when the request names no voice.
    #[serde(default = "default_voice")]
    pub voice: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_openai_base() -> String {
    "https://api.openai.com/v1".to_owned()
}

fn default_tts_model() -> String {
    "tts-1".to_owned()
}

fn default_voice() -> String {
    "alloy".to_owned()
}

/// Client for OpenAI-compatible `POST {base_url}/audio/speech`, requesting
/// `pcm` (24 kHz s16le mono) and streaming it.
pub struct OpenAiTts {
    name: String,
    url: String,
    model: String,
    voice: String,
    client: reqwest::Client,
}

impl OpenAiTts {
    pub fn new(name: impl Into<String>, config: OpenAiTtsConfig) -> anyhow::Result<Self> {
        Ok(Self {
            name: name.into(),
            url: join_url(&config.base_url, "audio/speech"),
            model: config.model,
            voice: config.voice,
            client: stream_client(
                config.timeout_secs,
                bearer_headers(config.api_key.as_deref())?,
            )?,
        })
    }
}

#[async_trait]
impl TtsProvider for OpenAiTts {
    fn name(&self) -> &str {
        &self.name
    }

    async fn synthesize(&self, request: TtsRequest) -> anyhow::Result<AudioStream> {
        let body = json!({
            "model": self.model,
            "input": request.text,
            "voice": request.voice.as_deref().unwrap_or(&self.voice),
            "response_format": "pcm",
        });
        let resp = self.client.post(&self.url).json(&body).send().await?;
        let resp = ensure_ok(resp).await?;
        Ok(pcm_stream(resp.bytes_stream(), OPENAI_PCM_RATE))
    }
}

/// [`TtsFactory`] for `openai`.
#[derive(Clone, Copy, Debug, Default)]
pub struct OpenAiTtsFactory;

impl TtsFactory for OpenAiTtsFactory {
    fn kinds(&self) -> &[&'static str] {
        &["openai"]
    }

    fn build(&self, name: &str, config: &ProviderConfig) -> anyhow::Result<Arc<dyn TtsProvider>> {
        let cfg: OpenAiTtsConfig = parse_settings(config)?;
        Ok(Arc::new(OpenAiTts::new(name, cfg)?))
    }
}

// ------------------------------------------------------------------ vllm-omni

/// Native rate of Qwen3-TTS, used when the server sends no rate header.
const VLLM_OMNI_DEFAULT_RATE: u32 = 24_000;

/// Settings for [`VllmOmniTts`] (`kind = "vllm-omni"`).
///
/// vLLM-Omni serves Qwen3-TTS (and CosyVoice3, Fish Speech, ...) with real
/// streaming: audio arrives per decoded codec chunk instead of per sentence.
///
/// ```toml
/// [speech.tts.qwen]
/// kind = "vllm-omni"
/// base_url = "http://127.0.0.1:8091/v1"
/// voice = "deepseek-chan"        # uploaded with POST /v1/audio/voices
/// language = "Chinese"           # default "Auto"
/// # instructions = true          # send emotion instructions (CustomVoice / VoiceDesign only)
/// # initial_codec_chunk_frames = 4
/// # extra = { seed = 7 }         # extra request fields, merged last
/// ```
#[derive(Clone, Debug, Deserialize)]
pub struct VllmOmniTtsConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    /// Must match the served model when set; omitted otherwise.
    pub model: Option<String>,
    /// Used when the request names no voice.
    pub voice: Option<String>,
    #[serde(default = "default_vllm_language")]
    pub language: String,
    /// `CustomVoice` / `VoiceDesign` / `Base`; inferred by the server when unset.
    pub task_type: Option<String>,
    /// Forward `TtsRequest::instruct` as `instructions`. Qwen3-TTS only honours
    /// them for CustomVoice / VoiceDesign, not for cloned (Base) voices.
    #[serde(default)]
    pub instructions: bool,
    /// Smaller first chunk = earlier first audio.
    pub initial_codec_chunk_frames: Option<u32>,
    #[serde(default)]
    pub extra: Map<String, Value>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_vllm_language() -> String {
    "Auto".to_owned()
}

/// Client for vLLM-Omni `POST {base_url}/audio/speech` with
/// `stream_format = "audio"` (raw PCM bytes as they are decoded).
pub struct VllmOmniTts {
    name: String,
    url: String,
    config: VllmOmniTtsConfig,
    client: reqwest::Client,
}

impl VllmOmniTts {
    pub fn new(name: impl Into<String>, config: VllmOmniTtsConfig) -> anyhow::Result<Self> {
        Ok(Self {
            name: name.into(),
            url: join_url(&config.base_url, "audio/speech"),
            client: stream_client(
                config.timeout_secs,
                bearer_headers(config.api_key.as_deref())?,
            )?,
            config,
        })
    }

    fn body(&self, request: &TtsRequest) -> Value {
        let c = &self.config;
        let mut body = Map::new();
        body.insert("input".into(), json!(request.text));
        body.insert("response_format".into(), json!("pcm"));
        body.insert("stream".into(), json!(true));
        body.insert("stream_format".into(), json!("audio"));
        body.insert(
            "language".into(),
            json!(request.language.as_deref().unwrap_or(&c.language)),
        );
        if let Some(voice) = request.voice.as_deref().or(c.voice.as_deref()) {
            body.insert("voice".into(), json!(voice));
        }
        if let Some(model) = &c.model {
            body.insert("model".into(), json!(model));
        }
        if let Some(task) = &c.task_type {
            body.insert("task_type".into(), json!(task));
        }
        if c.instructions
            && let Some(instruct) = request.instruct.as_deref().filter(|s| !s.trim().is_empty())
        {
            body.insert("instructions".into(), json!(instruct));
        }
        if let Some(frames) = c.initial_codec_chunk_frames {
            body.insert("initial_codec_chunk_frames".into(), json!(frames));
        }
        body.extend(c.extra.clone());
        Value::Object(body)
    }
}

#[async_trait]
impl TtsProvider for VllmOmniTts {
    fn name(&self) -> &str {
        &self.name
    }

    async fn synthesize(&self, request: TtsRequest) -> anyhow::Result<AudioStream> {
        let resp = self
            .client
            .post(&self.url)
            .json(&self.body(&request))
            .send()
            .await?;
        let resp = ensure_ok(resp).await?;
        let rate = resp
            .headers()
            .get("x-audio-sample-rate")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(VLLM_OMNI_DEFAULT_RATE);
        let channels = resp
            .headers()
            .get("x-audio-channels")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u32>().ok())
            .unwrap_or(1);
        if channels != 1 {
            anyhow::bail!("vLLM-Omni returned {channels}-channel audio; only mono is supported");
        }
        Ok(pcm_stream(resp.bytes_stream(), rate))
    }
}

/// [`TtsFactory`] for `vllm-omni`.
#[derive(Clone, Copy, Debug, Default)]
pub struct VllmOmniTtsFactory;

impl TtsFactory for VllmOmniTtsFactory {
    fn kinds(&self) -> &[&'static str] {
        &["vllm-omni"]
    }

    fn build(&self, name: &str, config: &ProviderConfig) -> anyhow::Result<Arc<dyn TtsProvider>> {
        let cfg: VllmOmniTtsConfig = parse_settings(config)?;
        Ok(Arc::new(VllmOmniTts::new(name, cfg)?))
    }
}

// ----------------------------------------------------------------- gpt-sovits

/// Settings for [`GptSovitsTts`] (`kind = "gpt-sovits"`).
///
/// ```toml
/// [speech.tts.sovits]
/// kind = "gpt-sovits"
/// url = "http://127.0.0.1:9880"
/// ref_audio_path = "refs/miyoria.wav"   # path as seen by the GPT-SoVITS server
/// prompt_text = "reference transcript"
/// prompt_lang = "zh"
/// text_lang = "zh"                      # default
/// sample_rate = 32000                   # default; must match the model
/// # params = { speed_factor = 1.1 }     # extra api_v2 fields, merged last
/// ```
#[derive(Clone, Debug, Deserialize)]
pub struct GptSovitsConfig {
    pub url: String,
    pub ref_audio_path: String,
    #[serde(default)]
    pub prompt_text: String,
    #[serde(default = "default_lang")]
    pub prompt_lang: String,
    #[serde(default = "default_lang")]
    pub text_lang: String,
    /// Raw output has no header, so the rate cannot be detected.
    #[serde(default = "default_sovits_rate")]
    pub sample_rate: u32,
    /// Extra `/tts` body fields (`top_k`, `speed_factor`, ...), merged last.
    #[serde(default)]
    pub params: Map<String, Value>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_lang() -> String {
    "zh".to_owned()
}

fn default_sovits_rate() -> u32 {
    32_000
}

/// Best-effort GPT-SoVITS (api_v2) client: `POST {url}/tts` with
/// `media_type = "raw"` and `streaming_mode = true`, which yields headerless
/// s16le mono PCM at the model's rate. The request's `emotion`, `instruct` and
/// `voice` are ignored (one reference voice per provider); `language` is
/// mapped to a GPT-SoVITS code when it is a known name.
pub struct GptSovitsTts {
    name: String,
    url: String,
    config: GptSovitsConfig,
    client: reqwest::Client,
}

impl GptSovitsTts {
    pub fn new(name: impl Into<String>, config: GptSovitsConfig) -> anyhow::Result<Self> {
        Ok(Self {
            name: name.into(),
            url: join_url(&config.url, "tts"),
            client: stream_client(config.timeout_secs, Default::default())?,
            config,
        })
    }
}

/// Maps names like `Chinese` / `ja` to the codes GPT-SoVITS understands;
/// `None` for anything unknown (the configured default is used).
fn sovits_lang(language: &str) -> Option<&'static str> {
    Some(match language.trim().to_ascii_lowercase().as_str() {
        "zh" | "chinese" | "mandarin" => "zh",
        "ja" | "japanese" => "ja",
        "en" | "english" => "en",
        "ko" | "korean" => "ko",
        "yue" | "cantonese" => "yue",
        "auto" => "auto",
        _ => return None,
    })
}

#[async_trait]
impl TtsProvider for GptSovitsTts {
    fn name(&self) -> &str {
        &self.name
    }

    async fn synthesize(&self, request: TtsRequest) -> anyhow::Result<AudioStream> {
        let c = &self.config;
        let text_lang = request
            .language
            .as_deref()
            .and_then(sovits_lang)
            .unwrap_or(&c.text_lang);
        let mut body = json!({
            "text": request.text,
            "text_lang": text_lang,
            "ref_audio_path": c.ref_audio_path,
            "prompt_text": c.prompt_text,
            "prompt_lang": c.prompt_lang,
            "media_type": "raw",
            "streaming_mode": true,
        });
        if let Some(obj) = body.as_object_mut() {
            obj.extend(c.params.clone());
        }
        let resp = self.client.post(&self.url).json(&body).send().await?;
        let resp = ensure_ok(resp).await?;
        Ok(pcm_stream(resp.bytes_stream(), c.sample_rate))
    }
}

/// [`TtsFactory`] for `gpt-sovits`.
#[derive(Clone, Copy, Debug, Default)]
pub struct GptSovitsFactory;

impl TtsFactory for GptSovitsFactory {
    fn kinds(&self) -> &[&'static str] {
        &["gpt-sovits"]
    }

    fn build(&self, name: &str, config: &ProviderConfig) -> anyhow::Result<Arc<dyn TtsProvider>> {
        let cfg: GptSovitsConfig = parse_settings(config)?;
        Ok(Arc::new(GptSovitsTts::new(name, cfg)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_mapping() {
        assert_eq!(sovits_lang("Japanese"), Some("ja"));
        assert_eq!(sovits_lang(" zh "), Some("zh"));
        assert_eq!(sovits_lang("klingon"), None);
    }
}
