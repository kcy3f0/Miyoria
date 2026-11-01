//! Shared test helpers.

mod consolidation;
mod embedder;
mod module;
mod retrieval;
mod units;

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Duration, TimeZone, Utc};
use miyoria_llm::{ChatProvider, LlmRouter, MockProvider};
use miyoria_store::{
    LogEntry, MemoryKind, MemoryRecordStore, MemoryScope, MemoryStore, MessageLog, PeopleStore,
};
use miyoria_types::{AccountRef, ContextKey, ContextKind, PersonId, PlatformId, ProfileId};
use parking_lot::Mutex;
use ulid::Ulid;

use crate::config::MemoryConfig;
use crate::embed::Embedder;
use crate::engine::{MemoryEngine, NewMemory};

pub fn profile() -> ProfileId {
    ProfileId::from("deepseek-chan")
}

pub fn acct(id: &str) -> AccountRef {
    AccountRef {
        platform: PlatformId::new("discord"),
        id: id.to_owned(),
    }
}

pub fn guild_ctx(guild: &str, channel: &str) -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: Some(guild.to_owned()),
        channel: channel.to_owned(),
        kind: ContextKind::Channel,
    }
}

pub fn dm_ctx(channel: &str) -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: None,
        channel: channel.to_owned(),
        kind: ContextKind::Dm,
    }
}

pub fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 1, 12, 0, 0).unwrap()
}

/// Router whose `summarizer` purpose goes to `summarizer` and `chat` to a
/// provider that always fails (so a wrong purpose is noticed).
pub fn router(summarizer: Arc<MockProvider>) -> Arc<LlmRouter> {
    let mut providers: HashMap<String, Arc<dyn ChatProvider>> = HashMap::new();
    providers.insert("sum".into(), summarizer);
    providers.insert(
        "chat".into(),
        Arc::new(MockProvider::new("chat").fail("chat must not be used")),
    );
    let mut purposes = HashMap::new();
    purposes.insert("summarizer".into(), vec!["sum:m".parse().unwrap()]);
    purposes.insert("chat".into(), vec!["chat:m".parse().unwrap()]);
    Arc::new(LlmRouter::new(providers, purposes))
}

pub struct Env {
    pub store: Arc<MemoryStore>,
    pub engine: Arc<MemoryEngine>,
}

pub fn env_with(
    config: MemoryConfig,
    llm: Option<Arc<MockProvider>>,
    embedder: Option<Arc<dyn Embedder>>,
) -> Env {
    let store = Arc::new(MemoryStore::new());
    let mut engine = MemoryEngine::new(profile(), config, store.clone())
        .with_people(Some(store.clone() as Arc<dyn PeopleStore>))
        .with_messages(Some(store.clone() as Arc<dyn MessageLog>))
        .with_settings(Some(store.clone() as Arc<dyn miyoria_store::SettingsStore>))
        .with_router(llm.map(router));
    if let Some(e) = embedder {
        engine = engine.with_embedder(e);
    }
    Env {
        store,
        engine: Arc::new(engine),
    }
}

pub fn env() -> Env {
    env_with(MemoryConfig::default(), None, None)
}

impl Env {
    pub async fn person(&self, account: &AccountRef, name: &str) -> PersonId {
        self.store.upsert_account(account, name).await.unwrap()
    }

    pub async fn log(
        &self,
        context: &ContextKey,
        author: &AccountRef,
        name: &str,
        text: &str,
        ts: DateTime<Utc>,
        is_self: bool,
    ) {
        self.store
            .append(&LogEntry {
                id: Ulid::new(),
                profile: profile(),
                context: context.clone(),
                author: author.clone(),
                author_name: name.to_owned(),
                text: text.to_owned(),
                is_self,
                ts,
                turn: None,
            })
            .await
            .unwrap();
    }

    pub async fn rec(&self, id: Ulid) -> Option<miyoria_store::MemoryRecord> {
        MemoryRecordStore::get(&*self.store, id).await.unwrap()
    }

    pub async fn setting(&self, key: &str) -> Option<serde_json::Value> {
        miyoria_store::SettingsStore::get(&*self.store, &profile(), key)
            .await
            .unwrap()
    }

    /// Every live (not superseded) record.
    pub async fn all(&self) -> Vec<miyoria_store::MemoryRecord> {
        MemoryRecordStore::list(
            &*self.store,
            &profile(),
            &miyoria_store::MemoryFilter {
                limit: 1000,
                ..Default::default()
            },
        )
        .await
        .unwrap()
    }

    pub async fn add(
        &self,
        kind: MemoryKind,
        scope: MemoryScope,
        subjects: Vec<PersonId>,
        content: &str,
        importance: f32,
        at: DateTime<Utc>,
    ) -> Ulid {
        match self
            .engine
            .store(
                NewMemory {
                    kind,
                    scope,
                    subjects,
                    content: content.to_owned(),
                    importance,
                    confidence: 0.8,
                    source_context: None,
                    due: None,
                },
                at,
            )
            .await
            .unwrap()
        {
            crate::engine::Stored::Inserted(id) | crate::engine::Stored::Reinforced(id) => id,
            crate::engine::Stored::Superseded { new, .. } => new,
        }
    }
}

pub fn days(n: i64) -> Duration {
    Duration::days(n)
}

/// Embedder returning fixed vectors per text (zero vector otherwise).
#[derive(Default)]
pub struct TableEmbedder {
    pub table: Mutex<HashMap<String, Vec<f32>>>,
}

impl TableEmbedder {
    pub fn with(self, text: &str, v: &[f32]) -> Self {
        self.table.lock().insert(text.to_owned(), v.to_vec());
        self
    }
}

#[async_trait]
impl Embedder for TableEmbedder {
    fn name(&self) -> &str {
        "table"
    }

    async fn embed(&self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        let table = self.table.lock();
        Ok(texts
            .iter()
            .map(|t| {
                table
                    .get(t)
                    .cloned()
                    .unwrap_or_else(|| vec![0.0, 0.0, 0.01])
            })
            .collect())
    }
}
