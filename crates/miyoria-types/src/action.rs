use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::{ActionId, TurnId};
use crate::platform::{ContextKey, MessageRef, OutgoingMessage};

/// Output lane. Actions in the same lane run one at a time, in priority order.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LaneKey(pub String);

impl LaneKey {
    pub fn text(context: &ContextKey) -> Self {
        Self(format!("text:{context}"))
    }

    pub fn voice(platform: &str, scope: &str) -> Self {
        Self(format!("voice:{platform}:{scope}"))
    }

    pub fn avatar() -> Self {
        Self("avatar".to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for LaneKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Lower value = more urgent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    /// System / admin output.
    System = 0,
    /// Direct reply to someone who addressed her.
    Direct = 1,
    /// Explicit user / viewer request.
    Request = 2,
    /// Something she decided to say on her own.
    Initiative = 3,
    /// Filler, idle chatter.
    Idle = 4,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActionPayload {
    SendMessage {
        context: ContextKey,
        message: OutgoingMessage,
    },
    React {
        message: MessageRef,
        emoji: String,
    },
    Typing {
        context: ContextKey,
    },
}

impl ActionPayload {
    pub fn platform(&self) -> &str {
        match self {
            Self::SendMessage { context, .. } | Self::Typing { context } => {
                context.platform.as_str()
            }
            Self::React { message, .. } => message.context.platform.as_str(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Action {
    pub id: ActionId,
    pub lane: LaneKey,
    pub priority: Priority,
    pub created_at: DateTime<Utc>,
    /// The action is dropped if it has not started within this time.
    #[serde(with = "duration_ms")]
    pub ttl: Duration,
    /// Queued actions with the same key are replaced by the newest one.
    pub coalesce_key: Option<String>,
    pub turn: Option<TurnId>,
    pub payload: ActionPayload,
}

impl Action {
    pub fn new(lane: LaneKey, priority: Priority, payload: ActionPayload) -> Self {
        Self {
            id: ActionId::new(),
            lane,
            priority,
            created_at: Utc::now(),
            ttl: Duration::from_secs(120),
            coalesce_key: None,
            turn: None,
            payload,
        }
    }

    pub fn with_ttl(mut self, ttl: Duration) -> Self {
        self.ttl = ttl;
        self
    }

    pub fn with_turn(mut self, turn: TurnId) -> Self {
        self.turn = Some(turn);
        self
    }

    pub fn with_coalesce_key(mut self, key: impl Into<String>) -> Self {
        self.coalesce_key = Some(key.into());
        self
    }

    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        let age = now.signed_duration_since(self.created_at);
        age.to_std().is_ok_and(|age| age > self.ttl)
    }
}

/// Provided by the scheduler. Everything that wants to produce output submits
/// actions here instead of calling platforms directly.
#[async_trait]
pub trait ActionSink: Send + Sync {
    async fn submit(&self, action: Action) -> anyhow::Result<()>;

    /// Drops queued (not yet started) actions of a turn, e.g. when the agent
    /// regenerates a reply because new messages arrived.
    async fn cancel_turn(&self, turn: TurnId) -> anyhow::Result<()>;
}

mod duration_ms {
    use std::time::Duration;

    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(d: &Duration, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u64(u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Duration, D::Error> {
        Ok(Duration::from_millis(u64::deserialize(d)?))
    }
}
