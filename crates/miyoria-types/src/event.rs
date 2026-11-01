use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::{ActionId, EventId, ModuleId, TurnId};
use crate::platform::{AccountRef, ContextKey, IncomingMessage, MessageRef, PlatformId};
use crate::voice::{PlaybackState, VoiceParticipant, VoiceUtterance};

/// Every event on the bus is wrapped in an envelope.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope {
    pub id: EventId,
    pub ts: DateTime<Utc>,
    pub source: ModuleId,
    /// The event that caused this one.
    pub causation: Option<EventId>,
    /// The agent turn this event belongs to.
    pub correlation: Option<TurnId>,
    pub event: Event,
}

impl Envelope {
    pub fn new(source: ModuleId, event: Event) -> Self {
        Self {
            id: EventId::new(),
            ts: Utc::now(),
            source,
            causation: None,
            correlation: None,
            event,
        }
    }

    pub fn topic(&self) -> &str {
        self.event.topic()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleStateKind {
    Disabled,
    Starting,
    Running,
    Degraded,
    Stopping,
    Stopped,
    Failed,
}

/// Why the agent did or did not respond. Shown in the panel for debugging.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DecisionTrace {
    pub turn: TurnId,
    pub context: ContextKey,
    pub respond: bool,
    pub score: f32,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum Event {
    /// A platform connection is up. `self_account` is one of her own accounts;
    /// messages from her own accounts are never treated as input.
    PlatformReady {
        platform: PlatformId,
        self_account: AccountRef,
    },
    PlatformMessageCreated(IncomingMessage),
    /// Someone started typing (used to extend the reply debounce).
    PlatformTyping {
        context: ContextKey,
        account: AccountRef,
    },
    AgentTurnStarted {
        turn: TurnId,
        context: ContextKey,
    },
    AgentDecision(DecisionTrace),
    AgentTurnCompleted {
        turn: TurnId,
        context: ContextKey,
        text: String,
    },
    ActionCompleted {
        action: ActionId,
        turn: Option<TurnId>,
        ok: bool,
        error: Option<String>,
        /// The message created by a successful `SendMessage`.
        #[serde(default)]
        message: Option<MessageRef>,
    },
    /// She joined a voice channel (`context.kind == Voice`).
    VoiceJoined {
        context: ContextKey,
        participants: Vec<VoiceParticipant>,
    },
    VoiceLeft {
        context: ContextKey,
        reason: Option<String>,
    },
    /// Who is in the voice channel changed.
    VoiceParticipants {
        context: ContextKey,
        participants: Vec<VoiceParticipant>,
    },
    /// Someone started or stopped speaking (raw signal, before ASR).
    VoiceSpeaking {
        context: ContextKey,
        account: AccountRef,
        speaking: bool,
    },
    VoiceUtterance(VoiceUtterance),
    /// Her own speech playback.
    VoicePlayback {
        context: ContextKey,
        turn: Option<TurnId>,
        state: PlaybackState,
        text: String,
    },
    ModuleStateChanged {
        module: ModuleId,
        state: ModuleStateKind,
        reason: Option<String>,
    },
    /// Escape hatch for extensions and experimental modules.
    Custom {
        topic: String,
        payload: serde_json::Value,
    },
}

impl Event {
    /// Dotted topic used for subscription filters, e.g. `platform.message.created`.
    pub fn topic(&self) -> &str {
        match self {
            Self::PlatformReady { .. } => "platform.ready",
            Self::PlatformMessageCreated(_) => "platform.message.created",
            Self::PlatformTyping { .. } => "platform.typing",
            Self::AgentTurnStarted { .. } => "agent.turn.started",
            Self::AgentDecision(_) => "agent.decision",
            Self::AgentTurnCompleted { .. } => "agent.turn.completed",
            Self::ActionCompleted { .. } => "action.completed",
            Self::VoiceJoined { .. } => "voice.joined",
            Self::VoiceLeft { .. } => "voice.left",
            Self::VoiceParticipants { .. } => "voice.participants",
            Self::VoiceSpeaking { .. } => "voice.speaking",
            Self::VoiceUtterance(_) => "voice.utterance",
            Self::VoicePlayback { .. } => "voice.playback",
            Self::ModuleStateChanged { .. } => "system.module.state",
            Self::Custom { topic, .. } => topic,
        }
    }
}
