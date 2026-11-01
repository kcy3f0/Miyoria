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
    Account, LogEntry, MessageLog, ModuleStateStore, PeopleStore, Person, PersonaOverride,
    PersonaOverrideStore, context_lookup_key, kind_from_str, kind_to_str,
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
