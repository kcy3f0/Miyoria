//! Voice pipeline.
//!
//! * Module `voice.link` ([`VoiceLinkModule`]) serves the Voice Link
//!   WebSocket (`docs/protocols/voice-link.md`) the self voice node connects
//!   to, and provides `Arc<`[`VoiceLink`]`>`: join / leave, participants,
//!   playback and captured audio.
//!
//!   ```toml
//!   [modules."voice.link"]
//!   bind = "127.0.0.1:7879"
//!   token = "${VOICE_LINK_TOKEN}"
//!   ```
//!
//! * Module `voice` ([`VoiceModule`]) listens (consent filter → [`Segmenter`]
//!   with an energy [`Vad`] → ASR → Traditional Chinese → `VoiceUtterance`)
//!   and speaks (provides `dyn VoiceSink`: TTS → playback, with barge-in).
//!   It registers `join`, `leave` and `voice consent <on|off>`.
//!
//! Latency measurements are published as `Custom { topic: "voice.latency" }`
//! with `stage` = `asr` (`asr_ms`, `transcribe_ms`) or `tts`
//! (`first_audio_ms`).

mod barge;
pub mod commands;
pub mod config;
pub mod consent;
pub mod link;
mod listen;
mod module;
pub mod protocol;
pub mod segment;
mod sink;
pub mod text;
pub mod vad;

pub use barge::BargeIn;
pub use config::{BargeInMode, VoiceConfig, VoiceProfile};
pub use consent::{Consent, ConsentPolicy, consent_key};
pub use link::{
    AudioEvent, Playback, Stoppable, StreamInfo, VoiceLink, VoiceLinkConfig, VoiceLinkModule,
    voice_context,
};
pub use module::VoiceModule;
pub use segment::{Segmenter, SegmenterConfig, Utterance};
pub use vad::{EnergyVad, EnergyVadConfig, Vad};

/// Topic of latency measurements.
pub const LATENCY_TOPIC: &str = "voice.latency";
