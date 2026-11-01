//! PostgreSQL backend. Queries are built at runtime, so building never needs
//! a database.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Context as _;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use miyoria_types::{AccountRef, ContextKey, ModuleId, PersonId, PlatformId, ProfileId, TurnId};
use sqlx::Row;
use sqlx::migrate::Migrator;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use ulid::Ulid;

use crate::{
    Account, AuditEntry, AuditLog, AuthScope, AuthStore, DecisionLog, DecisionRecord,
    IdentityStore, LogEntry, MemoryFilter, MemoryHit, MemoryQuery, MemoryRecord, MemoryRecordStore,
    MemoryScope, MessageLog, ModuleStateStore, NodeOverride, PeopleStore, Person, PersonaOverride,
    PersonaOverrideStore, PrunePolicy, Relationship, RelationshipDelta, RelationshipStore,
    RoleAssignment, RoleDefinition, RoleMapping, SettingsStore, clean_embedding,
    context_lookup_key, enum_from_str, enum_to_str, json_key, kind_from_str, kind_to_str,
    to_micros,
};

/// Migrations embedded from `crates/miyoria-store/migrations`.
pub static MIGRATOR: Migrator = sqlx::migrate!();

/// How often account creation retries after losing a race to a concurrent call.
const MAX_RETRIES: usize = 5;

/// Implements every storage trait on a PostgreSQL pool.
#[derive(Clone)]
pub struct PgStore {
    pool: PgPool,
}

impl PgStore {
    /// Connects and runs pending migrations.
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(Duration::from_secs(10))
            .connect(url)
            .await
            .context("cannot connect to PostgreSQL")?;
        Self::from_pool(pool).await
    }

    /// Uses an existing pool and runs pending migrations.
    pub async fn from_pool(pool: PgPool) -> anyhow::Result<Self> {
        MIGRATOR
            .run(&pool)
            .await
            .context("database migration failed")?;
        tracing::debug!("database migrations are up to date");
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

fn parse_ulid(s: &str) -> anyhow::Result<Ulid> {
    Ulid::from_string(s).with_context(|| format!("invalid ULID `{s}` in database"))
}

fn log_entry_from_row(row: &PgRow) -> anyhow::Result<LogEntry> {
    let id: String = row.try_get("id")?;
    let turn: Option<String> = row.try_get("turn_id")?;
    let kind: String = row.try_get("kind")?;
    Ok(LogEntry {
        id: parse_ulid(&id)?,
        profile: ProfileId(row.try_get("profile_id")?),
        context: ContextKey {
            platform: PlatformId(row.try_get("platform")?),
            scope: row.try_get("scope")?,
            channel: row.try_get("channel")?,
            kind: kind_from_str(&kind)?,
        },
        author: AccountRef {
            platform: PlatformId(row.try_get("author_platform")?),
            id: row.try_get("author_id")?,
        },
        author_name: row.try_get("author_name")?,
        text: row.try_get("text")?,
        is_self: row.try_get("is_self")?,
        ts: row.try_get("ts")?,
        turn: turn.as_deref().map(parse_ulid).transpose()?.map(TurnId),
    })
}

#[async_trait]
impl MessageLog for PgStore {
    async fn append(&self, entry: &LogEntry) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO message_log (id, profile_id, context_key, platform, scope, channel, kind, \
             author_platform, author_id, author_name, text, is_self, ts, turn_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
        )
        .bind(entry.id.to_string())
        .bind(entry.profile.as_str())
        .bind(context_lookup_key(&entry.context))
        .bind(entry.context.platform.as_str())
        .bind(entry.context.scope.as_deref())
        .bind(&entry.context.channel)
        .bind(kind_to_str(entry.context.kind))
        .bind(entry.author.platform.as_str())
        .bind(&entry.author.id)
        .bind(&entry.author_name)
        .bind(&entry.text)
        .bind(entry.is_self)
        .bind(entry.ts)
        .bind(entry.turn.map(|t| t.to_string()))
        .execute(&self.pool)
        .await
        .context("cannot append log entry")?;
        Ok(())
    }

    async fn recent(
        &self,
        profile: &ProfileId,
        context: &ContextKey,
        limit: usize,
    ) -> anyhow::Result<Vec<LogEntry>> {
        let rows = sqlx::query(
            "SELECT * FROM ( \
                 SELECT * FROM message_log \
                 WHERE profile_id = $1 AND context_key = $2 \
                 ORDER BY ts DESC, seq DESC LIMIT $3 \
             ) recent ORDER BY ts ASC, seq ASC",
        )
        .bind(profile.as_str())
        .bind(context_lookup_key(context))
        .bind(i64::try_from(limit).unwrap_or(i64::MAX))
        .fetch_all(&self.pool)
        .await
        .context("cannot read log entries")?;
        rows.iter().map(log_entry_from_row).collect()
    }
}

#[async_trait]
impl ModuleStateStore for PgStore {
    async fn get(&self, module: &ModuleId) -> anyhow::Result<Option<bool>> {
        Ok(
            sqlx::query_scalar("SELECT enabled FROM module_state WHERE module_id = $1")
                .bind(module.as_str())
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    async fn set(&self, module: &ModuleId, enabled: bool) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO module_state (module_id, enabled) VALUES ($1, $2) \
             ON CONFLICT (module_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()",
        )
        .bind(module.as_str())
        .bind(enabled)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn list(&self) -> anyhow::Result<BTreeMap<ModuleId, bool>> {
        let rows: Vec<(String, bool)> =
            sqlx::query_as("SELECT module_id, enabled FROM module_state")
                .fetch_all(&self.pool)
                .await?;
        Ok(rows
            .into_iter()
            .map(|(id, enabled)| (ModuleId(id), enabled))
            .collect())
    }
}

#[async_trait]
impl PersonaOverrideStore for PgStore {
    async fn set(
        &self,
        profile: &ProfileId,
        key: &str,
        body: &str,
        edited_by: &str,
    ) -> anyhow::Result<u32> {
        // Edits of one section are serialized with a transaction-scoped
        // advisory lock, so the next version number is never contended.
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("persona_overrides/{profile}/{key}"))
            .execute(&mut *tx)
            .await?;
        let version: i32 = sqlx::query_scalar(
            "INSERT INTO persona_overrides (profile_id, section_key, version, body, edited_by) \
             SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4 \
             FROM persona_overrides WHERE profile_id = $1 AND section_key = $2 \
             RETURNING version",
        )
        .bind(profile.as_str())
        .bind(key)
        .bind(body)
        .bind(edited_by)
        .fetch_one(&mut *tx)
        .await
        .context("cannot store persona override")?;
        tx.commit().await?;
        Ok(u32::try_from(version)?)
    }

    async fn current(&self, profile: &ProfileId) -> anyhow::Result<BTreeMap<String, String>> {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT DISTINCT ON (section_key) section_key, body FROM persona_overrides \
             WHERE profile_id = $1 ORDER BY section_key, version DESC",
        )
        .bind(profile.as_str())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().collect())
    }

    async fn history(
        &self,
        profile: &ProfileId,
        key: &str,
    ) -> anyhow::Result<Vec<PersonaOverride>> {
        let rows: Vec<(i32, String, String, DateTime<Utc>)> = sqlx::query_as(
            "SELECT version, body, edited_by, edited_at FROM persona_overrides \
             WHERE profile_id = $1 AND section_key = $2 ORDER BY version ASC",
        )
        .bind(profile.as_str())
        .bind(key)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|(version, body, edited_by, edited_at)| {
                Ok(PersonaOverride {
                    profile: profile.clone(),
                    key: key.to_owned(),
                    version: u32::try_from(version)?,
                    body,
                    edited_by,
                    edited_at,
                })
            })
            .collect()
    }
}

#[async_trait]
impl PeopleStore for PgStore {
    async fn upsert_account(
        &self,
        account: &AccountRef,
        display_name: &str,
    ) -> anyhow::Result<PersonId> {
        for _ in 0..MAX_RETRIES {
            let existing: Option<String> = sqlx::query_scalar(
                "UPDATE accounts SET display_name = $3, last_seen = now() \
                 WHERE platform = $1 AND account_id = $2 RETURNING person_id",
            )
            .bind(account.platform.as_str())
            .bind(&account.id)
            .bind(display_name)
            .fetch_optional(&self.pool)
            .await?;
            if let Some(id) = existing {
                return Ok(PersonId(parse_ulid(&id)?));
            }

            // First sight: create the person and the account together. If a
            // concurrent call created the account first, roll back and reuse it.
            let person = PersonId::new();
            let mut tx = self.pool.begin().await?;
            sqlx::query("INSERT INTO people (id, display_name) VALUES ($1, $2)")
                .bind(person.to_string())
                .bind(display_name)
                .execute(&mut *tx)
                .await?;
            let inserted = sqlx::query(
                "INSERT INTO accounts (platform, account_id, person_id, display_name) \
                 VALUES ($1, $2, $3, $4) ON CONFLICT (platform, account_id) DO NOTHING",
            )
            .bind(account.platform.as_str())
            .bind(&account.id)
            .bind(person.to_string())
            .bind(display_name)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if inserted == 1 {
                tx.commit().await?;
                return Ok(person);
            }
            tx.rollback().await?;
        }
        anyhow::bail!(
            "account `{}:{}` is being created concurrently; try again",
            account.platform,
            account.id
        )
    }

    async fn person_by_account(&self, account: &AccountRef) -> anyhow::Result<Option<Person>> {
        let person: Option<(String, String, DateTime<Utc>)> = sqlx::query_as(
            "SELECT p.id, p.display_name, p.created_at FROM accounts a \
             JOIN people p ON p.id = a.person_id \
             WHERE a.platform = $1 AND a.account_id = $2",
        )
        .bind(account.platform.as_str())
        .bind(&account.id)
        .fetch_optional(&self.pool)
        .await?;
        let Some((id, display_name, created_at)) = person else {
            return Ok(None);
        };
        let accounts: Vec<(String, String, String, DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
            "SELECT platform, account_id, display_name, first_seen, last_seen FROM accounts \
                 WHERE person_id = $1 ORDER BY first_seen, platform, account_id",
        )
        .bind(&id)
        .fetch_all(&self.pool)
        .await?;
        Ok(Some(Person {
            id: PersonId(parse_ulid(&id)?),
            display_name,
            created_at,
            accounts: accounts
                .into_iter()
                .map(
                    |(platform, account_id, display_name, first_seen, last_seen)| Account {
                        account: AccountRef {
                            platform: PlatformId(platform),
                            id: account_id,
                        },
                        display_name,
                        first_seen,
                        last_seen,
                    },
                )
                .collect(),
        }))
    }
}

/// Parses a JSONB column. JSONB values travel as text (`$n::jsonb` and
/// `col::text`), so sqlx's `json` feature is not needed.
fn parse_json<T: serde::de::DeserializeOwned>(s: &str, what: &str) -> anyhow::Result<T> {
    serde_json::from_str(s).with_context(|| format!("invalid {what} JSON in database"))
}

#[async_trait]
impl DecisionLog for PgStore {
    async fn append(&self, record: &DecisionRecord) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO decision_log (id, profile_id, context_key, ts, trace)              VALUES ($1, $2, $3, $4, $5::jsonb)",
        )
        .bind(record.id.to_string())
        .bind(record.profile.as_str())
        .bind(context_lookup_key(&record.trace.context))
        .bind(record.ts)
        .bind(serde_json::to_string(&record.trace)?)
        .execute(&self.pool)
        .await
        .context("cannot append decision")?;
        Ok(())
    }

    async fn recent(
        &self,
        profile: &ProfileId,
        context: Option<&ContextKey>,
        limit: usize,
    ) -> anyhow::Result<Vec<DecisionRecord>> {
        let rows: Vec<(String, DateTime<Utc>, String)> = sqlx::query_as(
            "SELECT id, ts, trace::text FROM decision_log              WHERE profile_id = $1 AND ($2::text IS NULL OR context_key = $2)              ORDER BY ts DESC, id DESC LIMIT $3",
        )
        .bind(profile.as_str())
        .bind(context.map(context_lookup_key))
        .bind(i64::try_from(limit).unwrap_or(i64::MAX))
        .fetch_all(&self.pool)
        .await
        .context("cannot read decisions")?;
        rows.into_iter()
            .map(|(id, ts, trace)| {
                Ok(DecisionRecord {
                    id: parse_ulid(&id)?,
                    profile: profile.clone(),
                    ts,
                    trace: parse_json(&trace, "decision trace")?,
                })
            })
            .collect()
    }
}

#[async_trait]
impl SettingsStore for PgStore {
    async fn get(
        &self,
        profile: &ProfileId,
        key: &str,
    ) -> anyhow::Result<Option<serde_json::Value>> {
        let value: Option<String> = sqlx::query_scalar(
            "SELECT value::text FROM profile_settings WHERE profile_id = $1 AND key = $2",
        )
        .bind(profile.as_str())
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        value
            .as_deref()
            .map(|v| parse_json(v, "setting"))
            .transpose()
    }

    async fn set(
        &self,
        profile: &ProfileId,
        key: &str,
        value: Option<serde_json::Value>,
    ) -> anyhow::Result<()> {
        match value {
            Some(value) => {
                sqlx::query(
                    "INSERT INTO profile_settings (profile_id, key, value)                      VALUES ($1, $2, $3::jsonb)                      ON CONFLICT (profile_id, key)                      DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
                )
                .bind(profile.as_str())
                .bind(key)
                .bind(serde_json::to_string(&value)?)
                .execute(&self.pool)
                .await
                .context("cannot store setting")?;
            }
            None => {
                sqlx::query("DELETE FROM profile_settings WHERE profile_id = $1 AND key = $2")
                    .bind(profile.as_str())
                    .bind(key)
                    .execute(&self.pool)
                    .await
                    .context("cannot delete setting")?;
            }
        }
        Ok(())
    }

    async fn list(
        &self,
        profile: &ProfileId,
        prefix: &str,
    ) -> anyhow::Result<BTreeMap<String, serde_json::Value>> {
        // `left()` instead of `LIKE`, so `%` and `_` in the prefix are literal.
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT key, value::text FROM profile_settings              WHERE profile_id = $1 AND left(key, char_length($2)) = $2",
        )
        .bind(profile.as_str())
        .bind(prefix)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|(key, value)| Ok((key, parse_json(&value, "setting")?)))
            .collect()
    }
}

/// Columns of `memory_records` in the order [`memory_from_row`] expects.
/// JSON and vector values travel as text.
const MEMORY_COLUMNS: &str = "id, profile_id, kind, scope::text AS scope, subjects, content, \
     tokens, embedding::text AS embedding, importance, confidence, created_at, updated_at, \
     last_accessed, access_count, source_context, due, done, superseded_by";

/// At most this many distinct query tokens are used for a text search.
const MAX_QUERY_TOKENS: usize = 64;

/// `[1,2,3]`, the text form pgvector accepts.
fn vector_literal(v: &[f32]) -> String {
    let parts: Vec<String> = v.iter().map(f32::to_string).collect();
    format!("[{}]", parts.join(","))
}

fn parse_vector(s: &str) -> anyhow::Result<Vec<f32>> {
    s.trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|x| {
            x.trim()
                .parse::<f32>()
                .with_context(|| format!("invalid embedding component `{x}` in database"))
        })
        .collect()
}

fn memory_from_row(row: &PgRow) -> anyhow::Result<MemoryRecord> {
    let id: String = row.try_get("id")?;
    let kind: String = row.try_get("kind")?;
    let scope: String = row.try_get("scope")?;
    let subjects: Vec<String> = row.try_get("subjects")?;
    let embedding: Option<String> = row.try_get("embedding")?;
    let access_count: i64 = row.try_get("access_count")?;
    let source_context: Option<String> = row.try_get("source_context")?;
    let superseded_by: Option<String> = row.try_get("superseded_by")?;
    Ok(MemoryRecord {
        id: parse_ulid(&id)?,
        profile: ProfileId(row.try_get("profile_id")?),
        kind: enum_from_str(&kind)?,
        scope: parse_json(&scope, "memory scope")?,
        subjects: subjects
            .iter()
            .map(|s| Ok(PersonId(parse_ulid(s)?)))
            .collect::<anyhow::Result<_>>()?,
        content: row.try_get("content")?,
        tokens: row.try_get("tokens")?,
        embedding: embedding.as_deref().map(parse_vector).transpose()?,
        importance: row.try_get("importance")?,
        confidence: row.try_get("confidence")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        last_accessed: row.try_get("last_accessed")?,
        access_count: u32::try_from(access_count).unwrap_or(u32::MAX),
        source_context: source_context
            .as_deref()
            .map(|s| parse_json(s, "memory source context"))
            .transpose()?,
        due: row.try_get("due")?,
        done: row.try_get("done")?,
        superseded_by: superseded_by.as_deref().map(parse_ulid).transpose()?,
    })
}

#[async_trait]
impl MemoryRecordStore for PgStore {
    async fn upsert(&self, record: &MemoryRecord) -> anyhow::Result<()> {
        let embedding = clean_embedding(record.embedding.as_deref())?;
        sqlx::query(
            "INSERT INTO memory_records (id, profile_id, kind, scope, scope_key, subjects, \
             content, tokens, embedding, importance, confidence, created_at, updated_at, \
             last_accessed, access_count, source_context, due, done, superseded_by) \
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::vector, $10, $11, $12, $13, \
             $14, $15, $16, $17, $18, $19) \
             ON CONFLICT (id) DO UPDATE SET profile_id = EXCLUDED.profile_id, \
             kind = EXCLUDED.kind, scope = EXCLUDED.scope, scope_key = EXCLUDED.scope_key, \
             subjects = EXCLUDED.subjects, content = EXCLUDED.content, \
             tokens = EXCLUDED.tokens, embedding = EXCLUDED.embedding, \
             importance = EXCLUDED.importance, confidence = EXCLUDED.confidence, \
             created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, \
             last_accessed = EXCLUDED.last_accessed, access_count = EXCLUDED.access_count, \
             source_context = EXCLUDED.source_context, due = EXCLUDED.due, \
             done = EXCLUDED.done, superseded_by = EXCLUDED.superseded_by",
        )
        .bind(record.id.to_string())
        .bind(record.profile.as_str())
        .bind(enum_to_str(&record.kind))
        .bind(serde_json::to_string(&record.scope)?)
        .bind(json_key(&record.scope))
        .bind(
            record
                .subjects
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
        )
        .bind(&record.content)
        .bind(&record.tokens)
        .bind(embedding.as_deref().map(vector_literal))
        .bind(record.importance)
        .bind(record.confidence)
        .bind(record.created_at)
        .bind(record.updated_at)
        .bind(record.last_accessed)
        .bind(i64::from(record.access_count))
        .bind(record.source_context.as_ref().map(json_key))
        .bind(record.due)
        .bind(record.done)
        .bind(record.superseded_by.map(|id| id.to_string()))
        .execute(&self.pool)
        .await
        .context("cannot store memory record")?;
        Ok(())
    }

    async fn get(&self, id: Ulid) -> anyhow::Result<Option<MemoryRecord>> {
        let row = sqlx::query(&format!(
            "SELECT {MEMORY_COLUMNS} FROM memory_records WHERE id = $1"
        ))
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await
        .context("cannot read memory record")?;
        row.as_ref().map(memory_from_row).transpose()
    }

    async fn delete(&self, id: Ulid) -> anyhow::Result<bool> {
        let done = sqlx::query("DELETE FROM memory_records WHERE id = $1")
            .bind(id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() > 0)
    }

    async fn search(&self, query: &MemoryQuery) -> anyhow::Result<Vec<MemoryHit>> {
        let embedding = clean_embedding(query.embedding.as_deref())?;
        if query.limit == 0 {
            return Ok(Vec::new());
        }
        let limit = i64::try_from(query.limit).unwrap_or(i64::MAX);
        let scopes: Vec<String> = query.scopes.iter().map(json_key).collect();
        let kinds: Option<Vec<String>> = query
            .kinds
            .as_ref()
            .map(|k| k.iter().map(enum_to_str).collect());
        let mut hits: Vec<MemoryHit> = Vec::new();

        // Full text: OR of one `plainto_tsquery` per token, so the GIN index
        // on `tsv` applies.
        let mut tokens: Vec<String> = query
            .tokens
            .iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        tokens.sort_unstable();
        tokens.dedup();
        tokens.truncate(MAX_QUERY_TOKENS);
        if !tokens.is_empty() {
            let tsquery = (0..tokens.len())
                .map(|i| format!("plainto_tsquery('simple', ${})", i + 5))
                .collect::<Vec<_>>()
                .join(" || ");
            let sql = format!(
                "SELECT {MEMORY_COLUMNS}, ts_rank(tsv, {tsquery})::real AS score \
                 FROM memory_records \
                 WHERE profile_id = $1 AND scope_key = ANY($2) \
                 AND ($3::text[] IS NULL OR kind = ANY($3)) \
                 AND superseded_by IS NULL AND tsv @@ ({tsquery}) \
                 ORDER BY score DESC, created_at DESC, id COLLATE \"C\" DESC LIMIT $4"
            );
            let mut q = sqlx::query(&sql)
                .bind(query.profile.as_str())
                .bind(&scopes)
                .bind(&kinds)
                .bind(limit);
            for token in &tokens {
                q = q.bind(token);
            }
            let rows = q
                .fetch_all(&self.pool)
                .await
                .context("memory text search failed")?;
            for row in &rows {
                hits.push(MemoryHit {
                    record: memory_from_row(row)?,
                    text_score: row.try_get("score")?,
                    vector_score: None,
                });
            }
        }

        // Nearest neighbours among rows with the query's dimension. Exact
        // scan: there is no ANN index yet. The CASE keeps the distance from
        // being evaluated on rows of another dimension.
        if let Some(embedding) = embedding {
            let dims = i32::try_from(embedding.len()).context("embedding too long")?;
            let sql = format!(
                "SELECT {MEMORY_COLUMNS}, \
                 CASE WHEN vector_dims(embedding) = $5 THEN embedding <=> $4::vector END AS dist \
                 FROM memory_records \
                 WHERE profile_id = $1 AND scope_key = ANY($2) \
                 AND ($3::text[] IS NULL OR kind = ANY($3)) \
                 AND superseded_by IS NULL AND embedding IS NOT NULL \
                 AND vector_dims(embedding) = $5 \
                 ORDER BY dist ASC, created_at DESC, id COLLATE \"C\" DESC LIMIT $6"
            );
            let rows = sqlx::query(&sql)
                .bind(query.profile.as_str())
                .bind(&scopes)
                .bind(&kinds)
                .bind(vector_literal(&embedding))
                .bind(dims)
                .bind(limit)
                .fetch_all(&self.pool)
                .await
                .context("memory vector search failed")?;
            for row in &rows {
                let record = memory_from_row(row)?;
                let dist: Option<f64> = row.try_get("dist")?;
                let score = dist
                    .map(|d| 1.0 - d)
                    .filter(|s| s.is_finite())
                    .map_or(0.0, |s| s as f32);
                match hits.iter_mut().find(|h| h.record.id == record.id) {
                    Some(hit) => hit.vector_score = Some(score),
                    None => hits.push(MemoryHit {
                        record,
                        text_score: 0.0,
                        vector_score: Some(score),
                    }),
                }
            }
        }
        Ok(hits)
    }

    async fn list(
        &self,
        profile: &ProfileId,
        filter: &MemoryFilter,
    ) -> anyhow::Result<Vec<MemoryRecord>> {
        let rows = sqlx::query(&format!(
            "SELECT {MEMORY_COLUMNS} FROM memory_records \
             WHERE profile_id = $1 \
             AND ($2::text IS NULL OR $2 = ANY(subjects)) \
             AND ($3::text IS NULL OR scope_key = $3) \
             AND ($4::text IS NULL OR kind = $4) \
             AND ($5::timestamptz IS NULL OR created_at < $5) \
             AND ($6 OR superseded_by IS NULL) \
             ORDER BY created_at DESC, id COLLATE \"C\" DESC LIMIT $7"
        ))
        .bind(profile.as_str())
        .bind(filter.subject.map(|p| p.to_string()))
        .bind(filter.scope.as_ref().map(json_key))
        .bind(filter.kind.as_ref().map(enum_to_str))
        .bind(filter.before)
        .bind(filter.include_superseded)
        .bind(i64::try_from(filter.limit).unwrap_or(i64::MAX))
        .fetch_all(&self.pool)
        .await
        .context("cannot list memory records")?;
        rows.iter().map(memory_from_row).collect()
    }

    async fn touch(&self, ids: &[Ulid], at: DateTime<Utc>) -> anyhow::Result<()> {
        let ids: Vec<String> = ids.iter().map(ToString::to_string).collect();
        sqlx::query(
            "UPDATE memory_records SET access_count = access_count + 1, last_accessed = $2 \
             WHERE id = ANY($1)",
        )
        .bind(&ids)
        .bind(at)
        .execute(&self.pool)
        .await
        .context("cannot record memory access")?;
        Ok(())
    }

    async fn due_followups(
        &self,
        profile: &ProfileId,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Vec<MemoryRecord>> {
        let rows = sqlx::query(&format!(
            "SELECT {MEMORY_COLUMNS} FROM memory_records \
             WHERE profile_id = $1 AND kind = 'followup' AND NOT done \
             AND superseded_by IS NULL AND due <= $2 \
             ORDER BY due ASC, id COLLATE \"C\" ASC"
        ))
        .bind(profile.as_str())
        .bind(now)
        .fetch_all(&self.pool)
        .await
        .context("cannot read due followups")?;
        rows.iter().map(memory_from_row).collect()
    }

    async fn prune(&self, profile: &ProfileId, policy: &PrunePolicy) -> anyhow::Result<u64> {
        let done = sqlx::query(
            "DELETE FROM memory_records \
             WHERE profile_id = $1 AND kind = 'episode' AND created_at < $2 \
             AND importance <= $3 AND (last_accessed IS NULL OR last_accessed < $4)",
        )
        .bind(profile.as_str())
        .bind(policy.created_before)
        .bind(policy.max_importance)
        .bind(policy.not_accessed_since)
        .execute(&self.pool)
        .await
        .context("cannot prune memory records")?;
        Ok(done.rows_affected())
    }

    async fn delete_by_subject(
        &self,
        profile: &ProfileId,
        person: PersonId,
    ) -> anyhow::Result<u64> {
        let done = sqlx::query(
            "DELETE FROM memory_records \
             WHERE profile_id = $1 AND ($2 = ANY(subjects) OR scope_key = $3)",
        )
        .bind(profile.as_str())
        .bind(person.to_string())
        .bind(json_key(&MemoryScope::Person { person }))
        .execute(&self.pool)
        .await
        .context("cannot delete memories about a person")?;
        Ok(done.rows_affected())
    }
}

fn relationship_from_row(row: &PgRow) -> anyhow::Result<Relationship> {
    let person: String = row.try_get("person_id")?;
    let interactions: i64 = row.try_get("interactions")?;
    Ok(Relationship {
        profile: ProfileId(row.try_get("profile_id")?),
        person: PersonId(parse_ulid(&person)?),
        affinity: row.try_get("affinity")?,
        trust: row.try_get("trust")?,
        familiarity: row.try_get("familiarity")?,
        tags: row.try_get("tags")?,
        notes: row.try_get("notes")?,
        call_name: row.try_get("call_name")?,
        interactions: u32::try_from(interactions).unwrap_or(u32::MAX),
        last_interaction: row.try_get("last_interaction")?,
        updated_at: row.try_get("updated_at")?,
    })
}

#[async_trait]
impl RelationshipStore for PgStore {
    async fn get(
        &self,
        profile: &ProfileId,
        person: PersonId,
    ) -> anyhow::Result<Option<Relationship>> {
        let row =
            sqlx::query("SELECT * FROM relationships WHERE profile_id = $1 AND person_id = $2")
                .bind(profile.as_str())
                .bind(person.to_string())
                .fetch_optional(&self.pool)
                .await
                .context("cannot read relationship")?;
        row.as_ref().map(relationship_from_row).transpose()
    }

    async fn upsert(&self, r: &Relationship) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO relationships (profile_id, person_id, affinity, trust, familiarity, \
             tags, notes, call_name, interactions, last_interaction, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) \
             ON CONFLICT (profile_id, person_id) DO UPDATE SET affinity = EXCLUDED.affinity, \
             trust = EXCLUDED.trust, familiarity = EXCLUDED.familiarity, tags = EXCLUDED.tags, \
             notes = EXCLUDED.notes, call_name = EXCLUDED.call_name, \
             interactions = EXCLUDED.interactions, \
             last_interaction = EXCLUDED.last_interaction, updated_at = EXCLUDED.updated_at",
        )
        .bind(r.profile.as_str())
        .bind(r.person.to_string())
        .bind(r.affinity)
        .bind(r.trust)
        .bind(r.familiarity)
        .bind(&r.tags)
        .bind(&r.notes)
        .bind(r.call_name.as_deref())
        .bind(i64::from(r.interactions))
        .bind(r.last_interaction)
        .bind(r.updated_at)
        .execute(&self.pool)
        .await
        .context("cannot store relationship")?;
        Ok(())
    }

    async fn list(&self, profile: &ProfileId) -> anyhow::Result<Vec<Relationship>> {
        let rows = sqlx::query(
            "SELECT * FROM relationships WHERE profile_id = $1 \
             ORDER BY person_id COLLATE \"C\"",
        )
        .bind(profile.as_str())
        .fetch_all(&self.pool)
        .await
        .context("cannot list relationships")?;
        rows.iter().map(relationship_from_row).collect()
    }

    async fn delete(&self, profile: &ProfileId, person: PersonId) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM relationship_deltas WHERE profile_id = $1 AND person_id = $2")
            .bind(profile.as_str())
            .bind(person.to_string())
            .execute(&mut *tx)
            .await?;
        let done =
            sqlx::query("DELETE FROM relationships WHERE profile_id = $1 AND person_id = $2")
                .bind(profile.as_str())
                .bind(person.to_string())
                .execute(&mut *tx)
                .await?;
        tx.commit().await?;
        Ok(done.rows_affected() > 0)
    }

    async fn record_delta(
        &self,
        profile: &ProfileId,
        person: PersonId,
        delta: &RelationshipDelta,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO relationship_deltas (profile_id, person_id, at, affinity, trust, \
             familiarity, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(profile.as_str())
        .bind(person.to_string())
        .bind(delta.at)
        .bind(delta.affinity)
        .bind(delta.trust)
        .bind(delta.familiarity)
        .bind(&delta.reason)
        .execute(&self.pool)
        .await
        .context("cannot record relationship delta")?;
        Ok(())
    }

    async fn deltas_since(
        &self,
        profile: &ProfileId,
        person: PersonId,
        since: DateTime<Utc>,
    ) -> anyhow::Result<Vec<RelationshipDelta>> {
        let rows: Vec<(DateTime<Utc>, f32, f32, f32, String)> = sqlx::query_as(
            "SELECT at, affinity, trust, familiarity, reason FROM relationship_deltas \
             WHERE profile_id = $1 AND person_id = $2 AND at >= $3 ORDER BY at, seq",
        )
        .bind(profile.as_str())
        .bind(person.to_string())
        .bind(since)
        .fetch_all(&self.pool)
        .await
        .context("cannot read relationship deltas")?;
        Ok(rows
            .into_iter()
            .map(
                |(at, affinity, trust, familiarity, reason)| RelationshipDelta {
                    at,
                    affinity,
                    trust,
                    familiarity,
                    reason,
                },
            )
            .collect())
    }
}

#[async_trait]
impl IdentityStore for PgStore {
    async fn link_account(&self, account: &AccountRef, person: PersonId) -> anyhow::Result<()> {
        // A new account row has no name yet; its id stands in until the
        // account is seen.
        let result = sqlx::query(
            "INSERT INTO accounts (platform, account_id, person_id, display_name) \
             VALUES ($1, $2, $3, $2) \
             ON CONFLICT (platform, account_id) DO UPDATE SET person_id = EXCLUDED.person_id",
        )
        .bind(account.platform.as_str())
        .bind(&account.id)
        .bind(person.to_string())
        .execute(&self.pool)
        .await;
        match result {
            Ok(_) => Ok(()),
            Err(sqlx::Error::Database(e)) if e.is_foreign_key_violation() => {
                anyhow::bail!("unknown person `{person}`")
            }
            Err(e) => Err(e).context("cannot link account"),
        }
    }

    async fn merge_people(&self, keep: PersonId, absorb: PersonId) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        // Rows are locked in id order, so concurrent merges cannot deadlock.
        let found: Vec<String> =
            sqlx::query_scalar("SELECT id FROM people WHERE id = ANY($1) ORDER BY id FOR UPDATE")
                .bind(vec![keep.to_string(), absorb.to_string()])
                .fetch_all(&mut *tx)
                .await?;
        for person in [keep, absorb] {
            if !found.contains(&person.to_string()) {
                anyhow::bail!("unknown person `{person}`");
            }
        }
        if keep == absorb {
            return Ok(());
        }
        sqlx::query("UPDATE accounts SET person_id = $1 WHERE person_id = $2")
            .bind(keep.to_string())
            .bind(absorb.to_string())
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM people WHERE id = $1")
            .bind(absorb.to_string())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn accounts_of(&self, person: PersonId) -> anyhow::Result<Vec<Account>> {
        let rows: Vec<(String, String, String, DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
            "SELECT platform, account_id, display_name, first_seen, last_seen FROM accounts \
             WHERE person_id = $1 ORDER BY first_seen, platform, account_id",
        )
        .bind(person.to_string())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(
                |(platform, account_id, display_name, first_seen, last_seen)| Account {
                    account: AccountRef {
                        platform: PlatformId(platform),
                        id: account_id,
                    },
                    display_name,
                    first_seen,
                    last_seen,
                },
            )
            .collect())
    }

    async fn set_person_name(&self, person: PersonId, display_name: &str) -> anyhow::Result<()> {
        let done = sqlx::query("UPDATE people SET display_name = $2 WHERE id = $1")
            .bind(person.to_string())
            .bind(display_name)
            .execute(&self.pool)
            .await?;
        if done.rows_affected() == 0 {
            anyhow::bail!("unknown person `{person}`");
        }
        Ok(())
    }

    async fn create_link_code(
        &self,
        code: &str,
        account: &AccountRef,
        expires_at: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO link_codes (code, platform, account_id, expires_at) \
             VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO UPDATE SET \
             platform = EXCLUDED.platform, account_id = EXCLUDED.account_id, \
             expires_at = EXCLUDED.expires_at",
        )
        .bind(code)
        .bind(account.platform.as_str())
        .bind(&account.id)
        .bind(expires_at)
        .execute(&self.pool)
        .await
        .context("cannot store link code")?;
        Ok(())
    }

    async fn consume_link_code(
        &self,
        code: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Option<AccountRef>> {
        let row: Option<(String, String, DateTime<Utc>)> = sqlx::query_as(
            "DELETE FROM link_codes WHERE code = $1 RETURNING platform, account_id, expires_at",
        )
        .bind(code)
        .fetch_optional(&self.pool)
        .await
        .context("cannot consume link code")?;
        Ok(row
            .filter(|(_, _, expires_at)| *expires_at > to_micros(now))
            .map(|(platform, id, _)| AccountRef {
                platform: PlatformId(platform),
                id,
            }))
    }
}

fn assignment_from_row(
    (platform, account_id, role, scope, granted_by, at): (
        String,
        String,
        String,
        String,
        String,
        DateTime<Utc>,
    ),
) -> anyhow::Result<RoleAssignment> {
    Ok(RoleAssignment {
        account: AccountRef {
            platform: PlatformId(platform),
            id: account_id,
        },
        role,
        scope: parse_json(&scope, "auth scope")?,
        granted_by,
        at,
    })
}

const ASSIGNMENT_COLUMNS: &str = "platform, account_id, role, scope, granted_by, at";
const ASSIGNMENT_ORDER: &str = "at, platform COLLATE \"C\", account_id COLLATE \"C\", \
     role COLLATE \"C\", scope COLLATE \"C\"";

#[async_trait]
impl AuthStore for PgStore {
    async fn roles(&self) -> anyhow::Result<Vec<RoleDefinition>> {
        let rows: Vec<(String, i32, Vec<String>, Vec<String>, bool)> = sqlx::query_as(
            "SELECT name, rank, grants, denies, builtin FROM roles \
             ORDER BY rank DESC, name COLLATE \"C\"",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(name, rank, grants, denies, builtin)| RoleDefinition {
                name,
                rank,
                grants,
                denies,
                builtin,
            })
            .collect())
    }

    async fn upsert_role(&self, role: &RoleDefinition) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO roles (name, rank, grants, denies, builtin) VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (name) DO UPDATE SET rank = EXCLUDED.rank, grants = EXCLUDED.grants, \
             denies = EXCLUDED.denies, builtin = EXCLUDED.builtin",
        )
        .bind(&role.name)
        .bind(role.rank)
        .bind(&role.grants)
        .bind(&role.denies)
        .bind(role.builtin)
        .execute(&self.pool)
        .await
        .context("cannot store role")?;
        Ok(())
    }

    async fn delete_role(&self, name: &str) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let builtin: Option<bool> =
            sqlx::query_scalar("SELECT builtin FROM roles WHERE name = $1 FOR UPDATE")
                .bind(name)
                .fetch_optional(&mut *tx)
                .await?;
        match builtin {
            None => return Ok(false),
            Some(true) => anyhow::bail!("role `{name}` is built in"),
            Some(false) => {}
        }
        for table in [
            "role_assignments",
            "role_mappings",
            "node_overrides",
            "roles",
        ] {
            let column = if table == "roles" { "name" } else { "role" };
            sqlx::query(&format!("DELETE FROM {table} WHERE {column} = $1"))
                .bind(name)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    async fn assignments_for(&self, account: &AccountRef) -> anyhow::Result<Vec<RoleAssignment>> {
        let rows: Vec<(String, String, String, String, String, DateTime<Utc>)> =
            sqlx::query_as(&format!(
                "SELECT {ASSIGNMENT_COLUMNS} FROM role_assignments \
                 WHERE platform = $1 AND account_id = $2 ORDER BY {ASSIGNMENT_ORDER}"
            ))
            .bind(account.platform.as_str())
            .bind(&account.id)
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter().map(assignment_from_row).collect()
    }

    async fn all_assignments(&self) -> anyhow::Result<Vec<RoleAssignment>> {
        let rows: Vec<(String, String, String, String, String, DateTime<Utc>)> =
            sqlx::query_as(&format!(
                "SELECT {ASSIGNMENT_COLUMNS} FROM role_assignments ORDER BY {ASSIGNMENT_ORDER}"
            ))
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter().map(assignment_from_row).collect()
    }

    async fn assign(&self, assignment: &RoleAssignment) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO role_assignments (platform, account_id, role, scope, granted_by, at) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (platform, account_id, role, scope) \
             DO UPDATE SET granted_by = EXCLUDED.granted_by, at = EXCLUDED.at",
        )
        .bind(assignment.account.platform.as_str())
        .bind(&assignment.account.id)
        .bind(&assignment.role)
        .bind(json_key(&assignment.scope))
        .bind(&assignment.granted_by)
        .bind(assignment.at)
        .execute(&self.pool)
        .await
        .context("cannot store role assignment")?;
        Ok(())
    }

    async fn revoke(
        &self,
        account: &AccountRef,
        role: &str,
        scope: &AuthScope,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "DELETE FROM role_assignments \
             WHERE platform = $1 AND account_id = $2 AND role = $3 AND scope = $4",
        )
        .bind(account.platform.as_str())
        .bind(&account.id)
        .bind(role)
        .bind(json_key(scope))
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    async fn mappings(
        &self,
        platform: &PlatformId,
        guild: &str,
    ) -> anyhow::Result<Vec<RoleMapping>> {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT platform_role, role FROM role_mappings \
             WHERE platform = $1 AND guild = $2 ORDER BY platform_role COLLATE \"C\"",
        )
        .bind(platform.as_str())
        .bind(guild)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(platform_role, role)| RoleMapping {
                platform: platform.clone(),
                guild: guild.to_owned(),
                platform_role,
                role,
            })
            .collect())
    }

    async fn set_mapping(&self, mapping: &RoleMapping) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO role_mappings (platform, guild, platform_role, role) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (platform, guild, platform_role) DO UPDATE SET role = EXCLUDED.role",
        )
        .bind(mapping.platform.as_str())
        .bind(&mapping.guild)
        .bind(&mapping.platform_role)
        .bind(&mapping.role)
        .execute(&self.pool)
        .await
        .context("cannot store role mapping")?;
        Ok(())
    }

    async fn remove_mapping(
        &self,
        platform: &PlatformId,
        guild: &str,
        platform_role: &str,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "DELETE FROM role_mappings \
             WHERE platform = $1 AND guild = $2 AND platform_role = $3",
        )
        .bind(platform.as_str())
        .bind(guild)
        .bind(platform_role)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    async fn overrides(&self) -> anyhow::Result<Vec<NodeOverride>> {
        let rows: Vec<(String, String, String, bool)> = sqlx::query_as(
            "SELECT scope, role, node, allow FROM node_overrides \
             ORDER BY scope COLLATE \"C\", role COLLATE \"C\", node COLLATE \"C\"",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|(scope, role, node, allow)| {
                Ok(NodeOverride {
                    scope: parse_json(&scope, "auth scope")?,
                    role,
                    node,
                    allow,
                })
            })
            .collect()
    }

    async fn set_override(&self, o: &NodeOverride) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO node_overrides (scope, role, node, allow) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (scope, role, node) DO UPDATE SET allow = EXCLUDED.allow",
        )
        .bind(json_key(&o.scope))
        .bind(&o.role)
        .bind(&o.node)
        .bind(o.allow)
        .execute(&self.pool)
        .await
        .context("cannot store node override")?;
        Ok(())
    }

    async fn remove_override(
        &self,
        scope: &AuthScope,
        role: &str,
        node: &str,
    ) -> anyhow::Result<bool> {
        let done =
            sqlx::query("DELETE FROM node_overrides WHERE scope = $1 AND role = $2 AND node = $3")
                .bind(json_key(scope))
                .bind(role)
                .bind(node)
                .execute(&self.pool)
                .await?;
        Ok(done.rows_affected() > 0)
    }
}

#[async_trait]
impl AuditLog for PgStore {
    async fn append(&self, entry: &AuditEntry) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO audit_log (id, at, actor, action, target, detail, ok) \
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)",
        )
        .bind(entry.id.to_string())
        .bind(entry.at)
        .bind(&entry.actor)
        .bind(&entry.action)
        .bind(&entry.target)
        .bind(serde_json::to_string(&entry.detail)?)
        .bind(entry.ok)
        .execute(&self.pool)
        .await
        .context("cannot append audit entry")?;
        Ok(())
    }

    async fn recent(&self, limit: usize, actor: Option<&str>) -> anyhow::Result<Vec<AuditEntry>> {
        let rows: Vec<(String, DateTime<Utc>, String, String, String, String, bool)> =
            sqlx::query_as(
                "SELECT id, at, actor, action, target, detail::text, ok FROM audit_log \
                 WHERE ($2::text IS NULL OR actor = $2) \
                 ORDER BY at DESC, id COLLATE \"C\" DESC LIMIT $1",
            )
            .bind(i64::try_from(limit).unwrap_or(i64::MAX))
            .bind(actor)
            .fetch_all(&self.pool)
            .await
            .context("cannot read audit log")?;
        rows.into_iter()
            .map(|(id, at, actor, action, target, detail, ok)| {
                Ok(AuditEntry {
                    id: parse_ulid(&id)?,
                    at,
                    actor,
                    action,
                    target,
                    detail: parse_json(&detail, "audit detail")?,
                    ok,
                })
            })
            .collect()
    }
}
