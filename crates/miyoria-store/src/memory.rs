//! In-memory backend. Nothing survives a restart.

use std::collections::{BTreeMap, HashMap, HashSet};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use miyoria_types::{AccountRef, ContextKey, ModuleId, PersonId, ProfileId};
use parking_lot::Mutex;
use ulid::Ulid;

use crate::{
    Account, LogEntry, MessageLog, ModuleStateStore, PeopleStore, Person, PersonaOverride,
    PersonaOverrideStore, context_lookup_key, to_micros,
};

/// Implements every storage trait in process memory.
#[derive(Default)]
pub struct MemoryStore {
    messages: Mutex<Messages>,
    modules: Mutex<BTreeMap<ModuleId, bool>>,
    overrides: Mutex<HashMap<(ProfileId, String), Vec<PersonaOverride>>>,
    people: Mutex<People>,
}

#[derive(Default)]
struct Messages {
    ids: HashSet<Ulid>,
    /// Sorted by timestamp; equal timestamps keep append order.
    by_context: HashMap<(ProfileId, String), Vec<LogEntry>>,
}

struct PersonRecord {
    display_name: String,
    created_at: DateTime<Utc>,
}

#[derive(Default)]
struct People {
    people: HashMap<PersonId, PersonRecord>,
    accounts: HashMap<AccountRef, (PersonId, Account)>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl MessageLog for MemoryStore {
    async fn append(&self, entry: &LogEntry) -> anyhow::Result<()> {
        let mut messages = self.messages.lock();
        if !messages.ids.insert(entry.id) {
            anyhow::bail!("log entry `{}` already exists", entry.id);
        }
        let mut entry = entry.clone();
        entry.ts = to_micros(entry.ts);
        let list = messages
            .by_context
            .entry((entry.profile.clone(), context_lookup_key(&entry.context)))
            .or_default();
        let at = list.partition_point(|e| e.ts <= entry.ts);
        list.insert(at, entry);
        Ok(())
    }

    async fn recent(
        &self,
        profile: &ProfileId,
        context: &ContextKey,
        limit: usize,
    ) -> anyhow::Result<Vec<LogEntry>> {
        let messages = self.messages.lock();
        let Some(list) = messages
            .by_context
            .get(&(profile.clone(), context_lookup_key(context)))
        else {
            return Ok(Vec::new());
        };
        Ok(list[list.len().saturating_sub(limit)..].to_vec())
    }
}

#[async_trait]
impl ModuleStateStore for MemoryStore {
    async fn get(&self, module: &ModuleId) -> anyhow::Result<Option<bool>> {
        Ok(self.modules.lock().get(module).copied())
    }

    async fn set(&self, module: &ModuleId, enabled: bool) -> anyhow::Result<()> {
        self.modules.lock().insert(module.clone(), enabled);
        Ok(())
    }

    async fn list(&self) -> anyhow::Result<BTreeMap<ModuleId, bool>> {
        Ok(self.modules.lock().clone())
    }
}

#[async_trait]
impl PersonaOverrideStore for MemoryStore {
    async fn set(
        &self,
        profile: &ProfileId,
        key: &str,
        body: &str,
        edited_by: &str,
    ) -> anyhow::Result<u32> {
        let mut overrides = self.overrides.lock();
        let versions = overrides
            .entry((profile.clone(), key.to_owned()))
            .or_default();
        let version = versions.last().map_or(1, |v| v.version + 1);
        versions.push(PersonaOverride {
            profile: profile.clone(),
            key: key.to_owned(),
            version,
            body: body.to_owned(),
            edited_by: edited_by.to_owned(),
            edited_at: to_micros(Utc::now()),
        });
        Ok(version)
    }

    async fn current(&self, profile: &ProfileId) -> anyhow::Result<BTreeMap<String, String>> {
        Ok(self
            .overrides
            .lock()
            .iter()
            .filter(|((p, _), _)| p == profile)
            .filter_map(|((_, key), versions)| {
                versions.last().map(|v| (key.clone(), v.body.clone()))
            })
            .collect())
    }

    async fn history(
        &self,
        profile: &ProfileId,
        key: &str,
    ) -> anyhow::Result<Vec<PersonaOverride>> {
        Ok(self
            .overrides
            .lock()
            .get(&(profile.clone(), key.to_owned()))
            .cloned()
            .unwrap_or_default())
    }
}

#[async_trait]
impl PeopleStore for MemoryStore {
    async fn upsert_account(
        &self,
        account: &AccountRef,
        display_name: &str,
    ) -> anyhow::Result<PersonId> {
        let mut people = self.people.lock();
        let now = to_micros(Utc::now());
        if let Some((person, info)) = people.accounts.get_mut(account) {
            info.display_name = display_name.to_owned();
            info.last_seen = now;
            return Ok(*person);
        }
        let person = PersonId::new();
        people.people.insert(
            person,
            PersonRecord {
                display_name: display_name.to_owned(),
                created_at: now,
            },
        );
        people.accounts.insert(
            account.clone(),
            (
                person,
                Account {
                    account: account.clone(),
                    display_name: display_name.to_owned(),
                    first_seen: now,
                    last_seen: now,
                },
            ),
        );
        Ok(person)
    }

    async fn person_by_account(&self, account: &AccountRef) -> anyhow::Result<Option<Person>> {
        let people = self.people.lock();
        let Some((id, _)) = people.accounts.get(account) else {
            return Ok(None);
        };
        let Some(record) = people.people.get(id) else {
            return Ok(None);
        };
        let mut accounts: Vec<Account> = people
            .accounts
            .values()
            .filter(|(p, _)| p == id)
            .map(|(_, a)| a.clone())
            .collect();
        accounts.sort_by(|a, b| {
            (a.first_seen, &a.account.platform, &a.account.id).cmp(&(
                b.first_seen,
                &b.account.platform,
                &b.account.id,
            ))
        });
        Ok(Some(Person {
            id: *id,
            display_name: record.display_name.clone(),
            created_at: record.created_at,
            accounts,
        }))
    }
}
