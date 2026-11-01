//! Relationships and cross-platform identity.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use miyoria_types::{AccountRef, PersonId, ProfileId};
use serde::{Deserialize, Serialize};

use crate::Account;

/// How one profile (character) feels about one person.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Relationship {
    pub profile: ProfileId,
    pub person: PersonId,
    /// -100..100
    pub affinity: f32,
    /// 0..100
    pub trust: f32,
    /// 0..100
    pub familiarity: f32,
    /// e.g. `owner`, `friend`, `regular`, `troll`, `blocked`.
    pub tags: Vec<String>,
    /// Her impression of the person, maintained by the LLM.
    pub notes: String,
    /// How she addresses them.
    pub call_name: Option<String>,
    pub interactions: u32,
    pub last_interaction: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

/// One change, kept for history and for daily caps.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationshipDelta {
    pub at: DateTime<Utc>,
    pub affinity: f32,
    pub trust: f32,
    pub familiarity: f32,
    /// e.g. `"appraisal: praise"`, `"admin: reset"`.
    pub reason: String,
}

#[async_trait]
pub trait RelationshipStore: Send + Sync {
    async fn get(
        &self,
        profile: &ProfileId,
        person: PersonId,
    ) -> anyhow::Result<Option<Relationship>>;

    async fn upsert(&self, relationship: &Relationship) -> anyhow::Result<()>;

    async fn list(&self, profile: &ProfileId) -> anyhow::Result<Vec<Relationship>>;

    async fn delete(&self, profile: &ProfileId, person: PersonId) -> anyhow::Result<bool>;

    async fn record_delta(
        &self,
        profile: &ProfileId,
        person: PersonId,
        delta: &RelationshipDelta,
    ) -> anyhow::Result<()>;

    /// Oldest first.
    async fn deltas_since(
        &self,
        profile: &ProfileId,
        person: PersonId,
        since: DateTime<Utc>,
    ) -> anyhow::Result<Vec<RelationshipDelta>>;
}

/// Linking several platform accounts to one person.
#[async_trait]
pub trait IdentityStore: Send + Sync {
    /// Moves `account` to `person` (creating the account row if needed).
    async fn link_account(&self, account: &AccountRef, person: PersonId) -> anyhow::Result<()>;

    /// Moves every account of `absorb` to `keep` and deletes `absorb`.
    /// Callers must merge per-profile data (relationships, memories) first.
    async fn merge_people(&self, keep: PersonId, absorb: PersonId) -> anyhow::Result<()>;

    async fn accounts_of(&self, person: PersonId) -> anyhow::Result<Vec<Account>>;

    async fn set_person_name(&self, person: PersonId, display_name: &str) -> anyhow::Result<()>;

    /// Stores a one-time code issued to `account`, valid until `expires_at`.
    async fn create_link_code(
        &self,
        code: &str,
        account: &AccountRef,
        expires_at: DateTime<Utc>,
    ) -> anyhow::Result<()>;

    /// Returns the issuing account and deletes the code, if still valid.
    async fn consume_link_code(
        &self,
        code: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Option<AccountRef>>;
}
