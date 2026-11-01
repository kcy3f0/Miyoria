use std::fmt;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// `"discord"`, later `"twitch"`, `"youtube"`, `"cli"` ...
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PlatformId(pub String);

impl PlatformId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PlatformId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// An account on a platform. Platform user ids are globally unique per
/// platform, so the bot and self accounts on Discord resolve the same person
/// to the same `AccountRef`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AccountRef {
    pub platform: PlatformId,
    pub id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextKind {
    Channel,
    Thread,
    Dm,
    Voice,
}

/// Identifies one conversation context. It is independent of which connection
/// (bot or self account) observed it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ContextKey {
    pub platform: PlatformId,
    /// Guild / server id. `None` for DMs.
    pub scope: Option<String>,
    pub channel: String,
    pub kind: ContextKind,
}

impl fmt::Display for ContextKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Voice contexts get their own key: on Discord a voice channel's text
        // chat has the same channel id as the voice channel itself.
        let voice = if self.kind == ContextKind::Voice {
            "voice:"
        } else {
            ""
        };
        match &self.scope {
            Some(scope) => write!(f, "{}:{}:{voice}{}", self.platform, scope, self.channel),
            None => write!(f, "{}:dm:{voice}{}", self.platform, self.channel),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MessageRef {
    pub context: ContextKey,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Author {
    pub account: AccountRef,
    pub display_name: String,
    pub is_bot: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub url: String,
    pub filename: String,
    pub content_type: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncomingMessage {
    pub id: MessageRef,
    pub author: Author,
    pub text: String,
    /// The message @-mentions one of her accounts.
    pub mentions_self: bool,
    /// The message replies to one of her messages.
    pub reply_to_self: bool,
    pub attachments: Vec<Attachment>,
    pub ts: DateTime<Utc>,
}

impl IncomingMessage {
    pub fn context(&self) -> &ContextKey {
        &self.id.context
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutgoingMessage {
    pub text: String,
    pub reply_to: Option<MessageRef>,
}

/// Registry of platform sinks, keyed by platform. Created by the app at boot
/// and provided as a service; platform modules register their sink on start
/// and unregister on stop.
#[derive(Default)]
pub struct PlatformSinks {
    sinks:
        std::sync::RwLock<std::collections::HashMap<PlatformId, std::sync::Arc<dyn PlatformSink>>>,
}

impl PlatformSinks {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, sink: std::sync::Arc<dyn PlatformSink>) {
        self.sinks
            .write()
            .expect("platform sinks lock poisoned")
            .insert(sink.platform(), sink);
    }

    pub fn unregister(&self, platform: &PlatformId) {
        self.sinks
            .write()
            .expect("platform sinks lock poisoned")
            .remove(platform);
    }

    pub fn get(&self, platform: &str) -> Option<std::sync::Arc<dyn PlatformSink>> {
        self.sinks
            .read()
            .expect("platform sinks lock poisoned")
            .get(&PlatformId::new(platform))
            .cloned()
    }
}

/// Implemented by platform adapters so the scheduler can execute output
/// actions without knowing which platform (or which account) it talks to.
#[async_trait]
pub trait PlatformSink: Send + Sync {
    fn platform(&self) -> PlatformId;
    async fn send(
        &self,
        context: &ContextKey,
        message: OutgoingMessage,
    ) -> anyhow::Result<MessageRef>;
    async fn react(&self, message: &MessageRef, emoji: &str) -> anyhow::Result<()>;
    async fn typing(&self, context: &ContextKey) -> anyhow::Result<()>;
}
