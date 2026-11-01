//! Persistence for Miyoria.
//!
//! Each storage area is an object-safe async trait so callers never depend on
//! a backend. Two backends implement all of them: [`MemoryStore`] (tests and
//! quick local runs) and [`PgStore`] (PostgreSQL + pgvector, with embedded
//! migrations). [`Store`] bundles one handle per area.
//!
//! Data that belongs to one character is keyed by [`ProfileId`]. Module state
//! and people are shared by all profiles.

mod memory;
mod postgres;

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, SubsecRound, Utc};
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, IncomingMessage, ModuleId, PersonId, ProfileId, TurnId,
};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

pub use memory::MemoryStore;
pub use postgres::{MIGRATOR, PgStore};

/// One entry of the conversation log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: Ulid,
    pub profile: ProfileId,
    pub context: ContextKey,
    pub author: AccountRef,
    pub author_name: String,
    pub text: String,
    /// Written by one of her own accounts.
    pub is_self: bool,
    /// Stored with microsecond precision.
    pub ts: DateTime<Utc>,
    /// The agent turn that produced or consumed this entry.
    pub turn: Option<TurnId>,
}

impl LogEntry {
    /// Builds an entry from a platform message, with a fresh id and no turn.
    pub fn from_incoming(profile: ProfileId, message: &IncomingMessage, is_self: bool) -> Self {
        Self {
            id: Ulid::new(),
            profile,
            context: message.context().clone(),
            author: message.author.account.clone(),
            author_name: message.author.display_name.clone(),
            text: message.text.clone(),
            is_self,
            ts: message.ts,
            turn: None,
        }
    }
}

/// Append-only conversation log per profile and context.
#[async_trait]
pub trait MessageLog: Send + Sync {
    /// Appends an entry. Entry ids must be unique.
    async fn append(&self, entry: &LogEntry) -> anyhow::Result<()>;

    /// The most recent `limit` entries of a context, oldest first. Entries
    /// with equal timestamps keep their append order.
    async fn recent(
        &self,
        profile: &ProfileId,
        context: &ContextKey,
        limit: usize,
    ) -> anyhow::Result<Vec<LogEntry>>;
}

/// Persisted runtime enabled / disabled flag per module.
#[async_trait]
pub trait ModuleStateStore: Send + Sync {
    /// `None` when the flag was never set (the config default applies).
    async fn get(&self, module: &ModuleId) -> anyhow::Result<Option<bool>>;
    async fn set(&self, module: &ModuleId, enabled: bool) -> anyhow::Result<()>;
    async fn list(&self) -> anyhow::Result<BTreeMap<ModuleId, bool>>;
}

/// One version of a persona section override.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonaOverride {
    pub profile: ProfileId,
    /// Persona section, e.g. `"identity"` or `"style"`.
    pub key: String,
    /// Starts at 1 and increases by 1 per edit of the same section.
    pub version: u32,
    pub body: String,
    /// Who made the edit, e.g. `"panel:owen"` or `"discord:1234"`.
    pub edited_by: String,
    pub edited_at: DateTime<Utc>,
}

/// Runtime edits of persona sections, with full version history.
#[async_trait]
pub trait PersonaOverrideStore: Send + Sync {
    /// Stores a new version of a section and returns its version number.
    async fn set(
        &self,
        profile: &ProfileId,
        key: &str,
        body: &str,
        edited_by: &str,
    ) -> anyhow::Result<u32>;

    /// Latest body of every overridden section of a profile.
    async fn current(&self, profile: &ProfileId) -> anyhow::Result<BTreeMap<String, String>>;

    /// Every version of one section, oldest first.
    async fn history(&self, profile: &ProfileId, key: &str)
    -> anyhow::Result<Vec<PersonaOverride>>;
}

/// A platform account linked to a person.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub account: AccountRef,
    /// Most recently seen display name.
    pub display_name: String,
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
}

/// A cross-platform person with their accounts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    pub id: PersonId,
    /// Display name of the account the person was first seen with.
    pub display_name: String,
    pub created_at: DateTime<Utc>,
    /// Ordered by first sight.
    pub accounts: Vec<Account>,
}

/// People and their platform accounts. Linking accounts comes later.
#[async_trait]
pub trait PeopleStore: Send + Sync {
    /// Records that an account was seen, creating a person on first sight.
    /// Returns the person the account belongs to.
    async fn upsert_account(
        &self,
        account: &AccountRef,
        display_name: &str,
    ) -> anyhow::Result<PersonId>;

    async fn person_by_account(&self, account: &AccountRef) -> anyhow::Result<Option<Person>>;
}

/// One handle per storage area, all backed by the same backend.
#[derive(Clone)]
pub struct Store {
    pub messages: Arc<dyn MessageLog>,
    pub module_state: Arc<dyn ModuleStateStore>,
    pub persona_overrides: Arc<dyn PersonaOverrideStore>,
    pub people: Arc<dyn PeopleStore>,
}

impl Store {
    /// A fresh, empty in-memory store.
    pub fn memory() -> Self {
        Self::from_backend(Arc::new(MemoryStore::new()))
    }

    /// Connects to PostgreSQL and runs pending migrations.
    pub async fn postgres(url: &str) -> anyhow::Result<Self> {
        Ok(Self::from_backend(Arc::new(PgStore::connect(url).await?)))
    }

    /// `memory://` (or `memory:`) selects the in-memory backend; anything else
    /// is treated as a PostgreSQL URL.
    pub async fn from_url(url: &str) -> anyhow::Result<Self> {
        if url.starts_with("memory:") {
            Ok(Self::memory())
        } else {
            Self::postgres(url).await
        }
    }

    /// Uses one backend for every area.
    pub fn from_backend<B>(backend: Arc<B>) -> Self
    where
        B: MessageLog + ModuleStateStore + PersonaOverrideStore + PeopleStore + 'static,
    {
        Self {
            messages: backend.clone(),
            module_state: backend.clone(),
            persona_overrides: backend.clone(),
            people: backend,
        }
    }
}

/// Canonical lookup key of a context. `ContextKey`'s `Display` drops the kind
/// and is ambiguous, so the JSON form is used instead.
pub(crate) fn context_lookup_key(context: &ContextKey) -> String {
    serde_json::to_string(context).expect("ContextKey serializes")
}

pub(crate) fn kind_to_str(kind: ContextKind) -> String {
    match serde_json::to_value(kind) {
        Ok(serde_json::Value::String(s)) => s,
        _ => unreachable!("ContextKind serializes to a string"),
    }
}

pub(crate) fn kind_from_str(s: &str) -> anyhow::Result<ContextKind> {
    serde_json::from_value(serde_json::Value::String(s.to_owned()))
        .map_err(|e| anyhow::anyhow!("unknown context kind `{s}`: {e}"))
}

/// Timestamps are stored with microsecond precision, like PostgreSQL.
pub(crate) fn to_micros(ts: DateTime<Utc>) -> DateTime<Utc> {
    ts.trunc_subsecs(6)
}
