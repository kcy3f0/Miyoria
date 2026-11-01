//! Speech interface.
//!
//! * [`AsrProvider`] turns one utterance into text; [`TtsProvider`] turns text
//!   into a stream of PCM chunks. Both are mono, 16-bit.
//! * [`SpeechService`] holds a fallback chain of each, built from `[speech]`
//!   config through registered [`AsrFactory`] / [`TtsFactory`]s, and is
//!   provided as a service by the `speech` module.
//!
//! Third-party models (Qwen3-ASR, SenseVoice, Qwen3-TTS, GPT-SoVITS, ...)
//! usually run as separate worker processes; providers here are clients.

mod asr;
mod http;
mod module;
mod pcm;
mod tts;
pub mod wav;

use std::sync::Arc;

use async_trait::async_trait;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};

pub use asr::{
    HttpWorkerAsr, HttpWorkerAsrConfig, HttpWorkerAsrFactory, OpenAiAsr, OpenAiAsrConfig,
    OpenAiAsrFactory,
};
pub use module::{SpeechConfig, SpeechModule, default_asr_factories, default_tts_factories};
pub use tts::{
    GptSovitsConfig, GptSovitsFactory, GptSovitsTts, HttpWorkerTts, HttpWorkerTtsConfig,
    HttpWorkerTtsFactory, OpenAiTts, OpenAiTtsConfig, OpenAiTtsFactory, VllmOmniTts,
    VllmOmniTtsConfig, VllmOmniTtsFactory,
};
pub use wav::resample;

/// Mono 16-bit PCM.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AudioBuf {
    pub sample_rate: u32,
    pub samples: Vec<i16>,
}

impl AudioBuf {
    pub fn duration_ms(&self) -> u64 {
        if self.sample_rate == 0 {
            return 0;
        }
        self.samples.len() as u64 * 1000 / u64::from(self.sample_rate)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AsrHint {
    /// Expected language (`zh`, `ja`, `en`, ...); `None` = auto-detect.
    pub language: Option<String>,
    /// Vocabulary / context hint (names, game terms), if the model supports it.
    pub prompt: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
    pub emotion: Option<String>,
    /// Non-speech events (laughter, applause, BGM, ...).
    pub audio_events: Vec<String>,
}

#[async_trait]
pub trait AsrProvider: Send + Sync {
    /// Instance name from config, e.g. `"local"`.
    fn name(&self) -> &str;
    async fn transcribe(&self, audio: &AudioBuf, hint: &AsrHint) -> anyhow::Result<Transcript>;
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TtsRequest {
    pub text: String,
    pub language: Option<String>,
    /// Emotion tag from the agent (`happy`, `annoyed`, ...).
    pub emotion: Option<String>,
    /// Natural-language style instruction, if the model supports one.
    pub instruct: Option<String>,
    /// Voice / speaker id understood by the provider (e.g. a cloned voice).
    pub voice: Option<String>,
}

/// A chunk of synthesized audio. Chunks of one stream share a sample rate.
pub type AudioChunk = AudioBuf;
pub type AudioStream = BoxStream<'static, anyhow::Result<AudioChunk>>;

#[async_trait]
pub trait TtsProvider: Send + Sync {
    fn name(&self) -> &str;
    async fn synthesize(&self, request: TtsRequest) -> anyhow::Result<AudioStream>;
}

/// `[speech.asr.<name>]` / `[speech.tts.<name>]` entry.
#[derive(Clone, Debug, Deserialize)]
pub struct ProviderConfig {
    pub kind: String,
    #[serde(flatten)]
    pub settings: serde_json::Map<String, serde_json::Value>,
}

pub trait AsrFactory: Send + Sync {
    fn kinds(&self) -> &[&'static str];
    fn build(&self, name: &str, config: &ProviderConfig) -> anyhow::Result<Arc<dyn AsrProvider>>;
}

pub trait TtsFactory: Send + Sync {
    fn kinds(&self) -> &[&'static str];
    fn build(&self, name: &str, config: &ProviderConfig) -> anyhow::Result<Arc<dyn TtsProvider>>;
}

/// Fallback chains of ASR and TTS providers.
pub struct SpeechService {
    asr: Vec<Arc<dyn AsrProvider>>,
    tts: Vec<Arc<dyn TtsProvider>>,
}

impl SpeechService {
    pub fn new(asr: Vec<Arc<dyn AsrProvider>>, tts: Vec<Arc<dyn TtsProvider>>) -> Self {
        Self { asr, tts }
    }

    pub fn has_asr(&self) -> bool {
        !self.asr.is_empty()
    }

    pub fn has_tts(&self) -> bool {
        !self.tts.is_empty()
    }

    /// Tries each ASR provider in order until one succeeds.
    pub async fn transcribe(
        &self,
        audio: &AudioBuf,
        hint: &AsrHint,
    ) -> anyhow::Result<(String, Transcript)> {
        let mut last = None;
        for p in &self.asr {
            match p.transcribe(audio, hint).await {
                Ok(t) => return Ok((p.name().to_owned(), t)),
                Err(e) => {
                    tracing::warn!(provider = p.name(), error = %e, "ASR failed, trying next");
                    last = Some(e);
                }
            }
        }
        Err(last.unwrap_or_else(|| anyhow::anyhow!("no ASR provider configured")))
    }

    /// Tries each TTS provider in order until one starts a stream.
    pub async fn synthesize(&self, request: TtsRequest) -> anyhow::Result<(String, AudioStream)> {
        let mut last = None;
        for p in &self.tts {
            match p.synthesize(request.clone()).await {
                Ok(s) => return Ok((p.name().to_owned(), s)),
                Err(e) => {
                    tracing::warn!(provider = p.name(), error = %e, "TTS failed, trying next");
                    last = Some(e);
                }
            }
        }
        Err(last.unwrap_or_else(|| anyhow::anyhow!("no TTS provider configured")))
    }
}
