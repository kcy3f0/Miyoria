use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::{PersonId, ProfileId, TurnId};
use crate::platform::{AccountRef, ContextKey};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Participant {
    pub account: AccountRef,
    pub display_name: String,
    /// Resolved by the social module when known.
    pub person: Option<PersonId>,
}

/// What the agent is about to answer, for modules that add per-turn context
/// (memories, relationships, mood, game state, ...).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PromptRequest {
    pub profile: ProfileId,
    pub turn: TurnId,
    pub context: ContextKey,
    pub participants: Vec<Participant>,
    /// Authors of the input of this turn (subset of `participants`).
    pub speakers: Vec<AccountRef>,
    /// The new input of this turn, e.g. `"Owen: 你明天要幹嘛"` lines joined.
    pub query: String,
    /// A few recent lines before the input, oldest first.
    pub recent: Vec<String>,
    pub voice: bool,
    pub now: DateTime<Utc>,
}

/// A block appended to the per-turn situation message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptSection {
    /// Stable id, e.g. `"memory"`.
    pub key: String,
    /// Heading shown to the model (Traditional Chinese), e.g. `"你記得的事"`.
    pub title: String,
    pub body: String,
    /// Lower comes first.
    pub order: i32,
}

#[async_trait]
pub trait PromptContributor: Send + Sync {
    /// Unique name (used to unregister).
    fn key(&self) -> &str;
    /// Must be fast; the agent applies a timeout and skips slow contributors.
    async fn contribute(&self, request: &PromptRequest) -> anyhow::Result<Vec<PromptSection>>;
}

/// Registry of prompt contributors. Created by the app at boot and provided
/// as a service; modules register on start and unregister on stop.
#[derive(Default)]
pub struct PromptContributors {
    items: RwLock<BTreeMap<String, Arc<dyn PromptContributor>>>,
}

impl PromptContributors {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, contributor: Arc<dyn PromptContributor>) {
        self.items
            .write()
            .expect("prompt contributors lock poisoned")
            .insert(contributor.key().to_owned(), contributor);
    }

    pub fn unregister(&self, key: &str) {
        self.items
            .write()
            .expect("prompt contributors lock poisoned")
            .remove(key);
    }

    pub fn all(&self) -> Vec<Arc<dyn PromptContributor>> {
        self.items
            .read()
            .expect("prompt contributors lock poisoned")
            .values()
            .cloned()
            .collect()
    }
}
