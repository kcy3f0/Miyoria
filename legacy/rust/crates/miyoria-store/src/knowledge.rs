//! Long-term memory records (episodes, facts, her own notes, followups).

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use miyoria_types::{AccountRef, ContextKey, PersonId, PlatformId, ProfileId};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    /// Something that happened ("昨晚大家一起打 Minecraft,Owen 掉進岩漿").
    Episode,
    /// A fact about a person or the world ("Owen 喜歡拉麵").
    Fact,
    /// Her own experiences, opinions and promises.
    SelfNote,
    /// Something to bring up later; has `due`.
    Followup,
}

/// Privacy scope: where a memory may be recalled.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MemoryScope {
    /// Anywhere (her own general knowledge and self notes).
    Global,
    /// Anywhere in one guild / server.
    Guild { platform: PlatformId, guild: String },
    /// Only in one channel (or voice channel).
    Channel { context: ContextKey },
    /// Only in the DM with this account.
    Dm { account: AccountRef },
    /// Anywhere this person is present (e.g. their name, how to address them).
    Person { person: PersonId },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: Ulid,
    pub profile: ProfileId,
    pub kind: MemoryKind,
    pub scope: MemoryScope,
    /// People the memory is about.
    pub subjects: Vec<PersonId>,
    pub content: String,
    /// Space-separated search tokens (already segmented, e.g. with jieba).
    pub tokens: String,
    pub embedding: Option<Vec<f32>>,
    /// 0..1
    pub importance: f32,
    /// 0..1
    pub confidence: f32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_accessed: Option<DateTime<Utc>>,
    pub access_count: u32,
    /// Where it was learned.
    pub source_context: Option<ContextKey>,
    /// Followups: earliest time to bring it up.
    pub due: Option<DateTime<Utc>>,
    /// Followups: already brought up.
    pub done: bool,
    /// Replaced by a newer record (kept for history, never recalled).
    pub superseded_by: Option<Ulid>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryQuery {
    pub profile: ProfileId,
    /// Only records in one of these scopes are returned. `Person` scopes for
    /// present people must be listed explicitly too.
    pub scopes: Vec<MemoryScope>,
    /// `None` = every kind.
    pub kinds: Option<Vec<MemoryKind>>,
    /// Full-text tokens (OR-ed).
    pub tokens: Vec<String>,
    /// Nearest-neighbour search when set (cosine).
    pub embedding: Option<Vec<f32>>,
    pub limit: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryHit {
    pub record: MemoryRecord,
    /// Full-text relevance, 0 when it only matched by vector.
    pub text_score: f32,
    /// Cosine similarity, `None` when no embedding was searched / stored.
    pub vector_score: Option<f32>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MemoryFilter {
    pub subject: Option<PersonId>,
    pub scope: Option<MemoryScope>,
    pub kind: Option<MemoryKind>,
    /// Only records created before this time (pagination).
    pub before: Option<DateTime<Utc>>,
    pub include_superseded: bool,
    pub limit: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PrunePolicy {
    /// Only episodes created before this time are candidates.
    pub created_before: DateTime<Utc>,
    /// ... with importance at most this ...
    pub max_importance: f32,
    /// ... and not accessed since this time.
    pub not_accessed_since: DateTime<Utc>,
}

#[async_trait]
pub trait MemoryRecordStore: Send + Sync {
    async fn upsert(&self, record: &MemoryRecord) -> anyhow::Result<()>;

    async fn get(&self, id: Ulid) -> anyhow::Result<Option<MemoryRecord>>;

    async fn delete(&self, id: Ulid) -> anyhow::Result<bool>;

    /// Union of full-text hits and nearest neighbours, restricted to
    /// `query.scopes`, never superseded records, at most `limit` of each kind
    /// of match. Ranking beyond that is the caller's job.
    async fn search(&self, query: &MemoryQuery) -> anyhow::Result<Vec<MemoryHit>>;

    /// Newest first.
    async fn list(
        &self,
        profile: &ProfileId,
        filter: &MemoryFilter,
    ) -> anyhow::Result<Vec<MemoryRecord>>;

    /// Records access (bumps `access_count`, sets `last_accessed`).
    async fn touch(&self, ids: &[Ulid], at: DateTime<Utc>) -> anyhow::Result<()>;

    /// Followups with `due <= now` and `done == false`, oldest due first.
    async fn due_followups(
        &self,
        profile: &ProfileId,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Vec<MemoryRecord>>;

    /// Deletes forgettable episodes; returns how many.
    async fn prune(&self, profile: &ProfileId, policy: &PrunePolicy) -> anyhow::Result<u64>;

    /// Deletes everything about a person (they asked her to forget them).
    async fn delete_by_subject(&self, profile: &ProfileId, person: PersonId)
    -> anyhow::Result<u64>;
}
