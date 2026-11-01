use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::TurnId;
use crate::platform::{AccountRef, Author, ContextKey};

/// Someone in a voice channel she is in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceParticipant {
    pub account: AccountRef,
    pub display_name: String,
    /// One of her own accounts.
    pub is_self: bool,
    pub muted: bool,
    pub deafened: bool,
}

/// One finished, transcribed utterance of one speaker.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoiceUtterance {
    pub id: String,
    /// `ContextKind::Voice`; `scope` = guild, `channel` = voice channel.
    pub context: ContextKey,
    pub speaker: Author,
    pub text: String,
    pub language: Option<String>,
    /// Emotion tag from the ASR model, if it reports one (e.g. SenseVoice).
    pub emotion: Option<String>,
    /// Non-speech events detected in the audio (laughter, applause, ...).
    pub audio_events: Vec<String>,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    /// Time from end of speech to transcript.
    pub asr_ms: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackState {
    Started,
    Finished,
    /// Stopped early, e.g. because someone started talking over her.
    Interrupted,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeakOutcome {
    Completed,
    Interrupted,
}

/// Provided by the voice module. The scheduler executes `ActionPayload::Speak`
/// through it; the call returns once playback finished or was interrupted.
#[async_trait]
pub trait VoiceSink: Send + Sync {
    async fn speak(
        &self,
        context: &ContextKey,
        text: &str,
        emotion: Option<&str>,
        turn: Option<TurnId>,
    ) -> anyhow::Result<SpeakOutcome>;
}
