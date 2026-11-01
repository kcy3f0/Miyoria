//! In-memory backend. Nothing survives a restart.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::ops::Bound;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use miyoria_types::{AccountRef, ContextKey, ModuleId, PersonId, PlatformId, ProfileId};
use parking_lot::Mutex;
use ulid::Ulid;

use crate::{
    Account, AuditEntry, AuditLog, AuthScope, AuthStore, DecisionLog, DecisionRecord,
    IdentityStore, LogEntry, MemoryFilter, MemoryHit, MemoryKind, MemoryQuery, MemoryRecord,
    MemoryRecordStore, MemoryScope, MessageLog, ModuleStateStore, NodeOverride, PeopleStore,
    Person, PersonaOverride, PersonaOverrideStore, PrunePolicy, Relationship, RelationshipDelta,
    RelationshipStore, RoleAssignment, RoleDefinition, RoleMapping, SettingsStore, clean_embedding,
    context_lookup_key, json_key, to_micros,
};

/// Decisions kept per profile; older ones are dropped.
const MAX_DECISIONS: usize = 10_000;

/// Implements every storage trait in process memory.
#[derive(Default)]
pub struct MemoryStore {
    messages: Mutex<Messages>,
    modules: Mutex<BTreeMap<ModuleId, bool>>,
    overrides: Mutex<HashMap<(ProfileId, String), Vec<PersonaOverride>>>,
    people: Mutex<People>,
    decisions: Mutex<Decisions>,
    settings: Mutex<HashMap<ProfileId, BTreeMap<String, serde_json::Value>>>,
    memories: Mutex<HashMap<Ulid, MemoryRecord>>,
    relationships: Mutex<Relationships>,
    link_codes: Mutex<HashMap<String, (AccountRef, DateTime<Utc>)>>,
    auth: Mutex<Auth>,
    audit: Mutex<Vec<AuditEntry>>,
}

#[derive(Default)]
struct Relationships {
    current: HashMap<(ProfileId, PersonId), Relationship>,
    /// In insertion order.
    deltas: HashMap<(ProfileId, PersonId), Vec<RelationshipDelta>>,
}

#[derive(Default)]
struct Auth {
    roles: BTreeMap<String, RoleDefinition>,
    /// Keyed by (account, role, scope key).
    assignments: HashMap<(AccountRef, String, String), RoleAssignment>,
    /// Keyed by (platform, guild, platform role).
    mappings: BTreeMap<(String, String, String), RoleMapping>,
    /// Keyed by (scope key, role, node).
    overrides: BTreeMap<(String, String, String), NodeOverride>,
}

#[derive(Default)]
struct Messages {
    ids: HashSet<Ulid>,
    /// Sorted by timestamp; equal timestamps keep append order.
    by_context: HashMap<(ProfileId, String), Vec<LogEntry>>,
}

#[derive(Default)]
struct Decisions {
    ids: HashSet<Ulid>,
    /// Sorted by `(ts, id)`, at most [`MAX_DECISIONS`] per profile.
    by_profile: HashMap<ProfileId, VecDeque<DecisionRecord>>,
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

#[async_trait]
impl DecisionLog for MemoryStore {
    async fn append(&self, record: &DecisionRecord) -> anyhow::Result<()> {
        let mut decisions = self.decisions.lock();
        if !decisions.ids.insert(record.id) {
            anyhow::bail!("decision `{}` already exists", record.id);
        }
        let mut record = record.clone();
        record.ts = to_micros(record.ts);
        let list = decisions
            .by_profile
            .entry(record.profile.clone())
            .or_default();
        let at = list.partition_point(|d| (d.ts, d.id) <= (record.ts, record.id));
        list.insert(at, record);
        let dropped: Vec<Ulid> = list
            .drain(..list.len().saturating_sub(MAX_DECISIONS))
            .map(|d| d.id)
            .collect();
        for id in dropped {
            decisions.ids.remove(&id);
        }
        Ok(())
    }

    async fn recent(
        &self,
        profile: &ProfileId,
        context: Option<&ContextKey>,
        limit: usize,
    ) -> anyhow::Result<Vec<DecisionRecord>> {
        let decisions = self.decisions.lock();
        let Some(list) = decisions.by_profile.get(profile) else {
            return Ok(Vec::new());
        };
        Ok(list
            .iter()
            .rev()
            .filter(|d| context.is_none_or(|c| &d.trace.context == c))
            .take(limit)
            .cloned()
            .collect())
    }
}

#[async_trait]
impl SettingsStore for MemoryStore {
    async fn get(
        &self,
        profile: &ProfileId,
        key: &str,
    ) -> anyhow::Result<Option<serde_json::Value>> {
        Ok(self
            .settings
            .lock()
            .get(profile)
            .and_then(|settings| settings.get(key))
            .cloned())
    }

    async fn set(
        &self,
        profile: &ProfileId,
        key: &str,
        value: Option<serde_json::Value>,
    ) -> anyhow::Result<()> {
        let mut settings = self.settings.lock();
        match value {
            Some(value) => {
                settings
                    .entry(profile.clone())
                    .or_default()
                    .insert(key.to_owned(), value);
            }
            None => {
                if let Some(profile_settings) = settings.get_mut(profile) {
                    profile_settings.remove(key);
                    if profile_settings.is_empty() {
                        settings.remove(profile);
                    }
                }
            }
        }
        Ok(())
    }

    async fn list(
        &self,
        profile: &ProfileId,
        prefix: &str,
    ) -> anyhow::Result<BTreeMap<String, serde_json::Value>> {
        let settings = self.settings.lock();
        let Some(settings) = settings.get(profile) else {
            return Ok(BTreeMap::new());
        };
        Ok(settings
            .range::<str, _>((Bound::Included(prefix), Bound::Unbounded))
            .take_while(|(key, _)| key.starts_with(prefix))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect())
    }
}

/// Cosine similarity; 0 when either vector has no length.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let (mut dot, mut na, mut nb) = (0.0_f64, 0.0_f64, 0.0_f64);
    for (x, y) in a.iter().zip(b) {
        let (x, y) = (f64::from(*x), f64::from(*y));
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    (dot / (na.sqrt() * nb.sqrt())) as f32
}

fn normalize_record(record: &MemoryRecord) -> anyhow::Result<MemoryRecord> {
    let mut record = record.clone();
    record.embedding = clean_embedding(record.embedding.as_deref())?;
    record.created_at = to_micros(record.created_at);
    record.updated_at = to_micros(record.updated_at);
    record.last_accessed = record.last_accessed.map(to_micros);
    record.due = record.due.map(to_micros);
    Ok(record)
}

/// Newest first, ties broken by id.
fn newest_first(a: &MemoryRecord, b: &MemoryRecord) -> std::cmp::Ordering {
    (b.created_at, b.id).cmp(&(a.created_at, a.id))
}

#[async_trait]
impl MemoryRecordStore for MemoryStore {
    async fn upsert(&self, record: &MemoryRecord) -> anyhow::Result<()> {
        let record = normalize_record(record)?;
        self.memories.lock().insert(record.id, record);
        Ok(())
    }

    async fn get(&self, id: Ulid) -> anyhow::Result<Option<MemoryRecord>> {
        Ok(self.memories.lock().get(&id).cloned())
    }

    async fn delete(&self, id: Ulid) -> anyhow::Result<bool> {
        Ok(self.memories.lock().remove(&id).is_some())
    }

    async fn search(&self, query: &MemoryQuery) -> anyhow::Result<Vec<MemoryHit>> {
        let embedding = clean_embedding(query.embedding.as_deref())?;
        if query.limit == 0 {
            return Ok(Vec::new());
        }
        let memories = self.memories.lock();
        let mut candidates: Vec<&MemoryRecord> = memories
            .values()
            .filter(|r| {
                r.profile == query.profile
                    && r.superseded_by.is_none()
                    && query.scopes.contains(&r.scope)
                    && query.kinds.as_ref().is_none_or(|k| k.contains(&r.kind))
            })
            .collect();
        candidates.sort_by(|a, b| newest_first(a, b));

        // Text: fraction of the query tokens that the record contains.
        let wanted: BTreeSet<String> = query
            .tokens
            .iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        let mut text: Vec<(f32, &MemoryRecord)> = Vec::new();
        if !wanted.is_empty() {
            for record in &candidates {
                let have: BTreeSet<String> = record
                    .tokens
                    .split_whitespace()
                    .map(str::to_lowercase)
                    .collect();
                let matched = wanted.iter().filter(|t| have.contains(*t)).count();
                if matched > 0 {
                    text.push((matched as f32 / wanted.len() as f32, record));
                }
            }
            // Stable sort keeps newest first among equal scores.
            text.sort_by(|a, b| b.0.total_cmp(&a.0));
            text.truncate(query.limit);
        }

        let mut hits: Vec<MemoryHit> = text
            .into_iter()
            .map(|(score, record)| MemoryHit {
                record: record.clone(),
                text_score: score,
                vector_score: None,
            })
            .collect();

        // Vector: brute-force cosine among records of the same dimension.
        if let Some(embedding) = embedding {
            let mut nearest: Vec<(f32, &MemoryRecord)> = candidates
                .iter()
                .filter_map(|r| {
                    let e = r.embedding.as_deref()?;
                    (e.len() == embedding.len()).then(|| (cosine(e, &embedding), *r))
                })
                .collect();
            nearest.sort_by(|a, b| b.0.total_cmp(&a.0));
            nearest.truncate(query.limit);
            for (score, record) in nearest {
                match hits.iter_mut().find(|h| h.record.id == record.id) {
                    Some(hit) => hit.vector_score = Some(score),
                    None => hits.push(MemoryHit {
                        record: record.clone(),
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
        let memories = self.memories.lock();
        let mut records: Vec<MemoryRecord> = memories
            .values()
            .filter(|r| {
                &r.profile == profile
                    && filter.subject.is_none_or(|s| r.subjects.contains(&s))
                    && filter.scope.as_ref().is_none_or(|s| &r.scope == s)
                    && filter.kind.is_none_or(|k| r.kind == k)
                    && filter.before.is_none_or(|b| r.created_at < b)
                    && (filter.include_superseded || r.superseded_by.is_none())
            })
            .cloned()
            .collect();
        records.sort_by(newest_first);
        records.truncate(filter.limit);
        Ok(records)
    }

    async fn touch(&self, ids: &[Ulid], at: DateTime<Utc>) -> anyhow::Result<()> {
        let at = to_micros(at);
        let mut memories = self.memories.lock();
        for id in ids.iter().collect::<HashSet<_>>() {
            if let Some(record) = memories.get_mut(id) {
                record.access_count = record.access_count.saturating_add(1);
                record.last_accessed = Some(at);
            }
        }
        Ok(())
    }

    async fn due_followups(
        &self,
        profile: &ProfileId,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Vec<MemoryRecord>> {
        let now = to_micros(now);
        let memories = self.memories.lock();
        let mut due: Vec<MemoryRecord> = memories
            .values()
            .filter(|r| {
                &r.profile == profile
                    && r.kind == MemoryKind::Followup
                    && !r.done
                    && r.superseded_by.is_none()
                    && r.due.is_some_and(|d| d <= now)
            })
            .cloned()
            .collect();
        due.sort_by_key(|r| (r.due, r.id));
        Ok(due)
    }

    async fn prune(&self, profile: &ProfileId, policy: &PrunePolicy) -> anyhow::Result<u64> {
        let created_before = to_micros(policy.created_before);
        let not_accessed_since = to_micros(policy.not_accessed_since);
        let mut memories = self.memories.lock();
        let before = memories.len();
        memories.retain(|_, r| {
            let forgettable = &r.profile == profile
                && r.kind == MemoryKind::Episode
                && r.created_at < created_before
                && r.importance <= policy.max_importance
                && r.last_accessed.is_none_or(|a| a < not_accessed_since);
            !forgettable
        });
        Ok((before - memories.len()) as u64)
    }

    async fn delete_by_subject(
        &self,
        profile: &ProfileId,
        person: PersonId,
    ) -> anyhow::Result<u64> {
        let mut memories = self.memories.lock();
        let before = memories.len();
        memories.retain(|_, r| {
            let about = r.subjects.contains(&person)
                || matches!(r.scope, MemoryScope::Person { person: p } if p == person);
            !(&r.profile == profile && about)
        });
        Ok((before - memories.len()) as u64)
    }
}

#[async_trait]
impl RelationshipStore for MemoryStore {
    async fn get(
        &self,
        profile: &ProfileId,
        person: PersonId,
    ) -> anyhow::Result<Option<Relationship>> {
        Ok(self
            .relationships
            .lock()
            .current
            .get(&(profile.clone(), person))
            .cloned())
    }

    async fn upsert(&self, relationship: &Relationship) -> anyhow::Result<()> {
        let mut relationship = relationship.clone();
        relationship.last_interaction = relationship.last_interaction.map(to_micros);
        relationship.updated_at = to_micros(relationship.updated_at);
        self.relationships.lock().current.insert(
            (relationship.profile.clone(), relationship.person),
            relationship,
        );
        Ok(())
    }

    async fn list(&self, profile: &ProfileId) -> anyhow::Result<Vec<Relationship>> {
        let mut list: Vec<Relationship> = self
            .relationships
            .lock()
            .current
            .values()
            .filter(|r| &r.profile == profile)
            .cloned()
            .collect();
        list.sort_by_key(|r| r.person);
        Ok(list)
    }

    async fn delete(&self, profile: &ProfileId, person: PersonId) -> anyhow::Result<bool> {
        let mut relationships = self.relationships.lock();
        let key = (profile.clone(), person);
        relationships.deltas.remove(&key);
        Ok(relationships.current.remove(&key).is_some())
    }

    async fn record_delta(
        &self,
        profile: &ProfileId,
        person: PersonId,
        delta: &RelationshipDelta,
    ) -> anyhow::Result<()> {
        let mut delta = delta.clone();
        delta.at = to_micros(delta.at);
        self.relationships
            .lock()
            .deltas
            .entry((profile.clone(), person))
            .or_default()
            .push(delta);
        Ok(())
    }

    async fn deltas_since(
        &self,
        profile: &ProfileId,
        person: PersonId,
        since: DateTime<Utc>,
    ) -> anyhow::Result<Vec<RelationshipDelta>> {
        let since = to_micros(since);
        let relationships = self.relationships.lock();
        let mut deltas: Vec<RelationshipDelta> = relationships
            .deltas
            .get(&(profile.clone(), person))
            .map(|list| list.iter().filter(|d| d.at >= since).cloned().collect())
            .unwrap_or_default();
        // Stable: equal timestamps keep insertion order.
        deltas.sort_by_key(|d| d.at);
        Ok(deltas)
    }
}

#[async_trait]
impl IdentityStore for MemoryStore {
    async fn link_account(&self, account: &AccountRef, person: PersonId) -> anyhow::Result<()> {
        let mut people = self.people.lock();
        if !people.people.contains_key(&person) {
            anyhow::bail!("unknown person `{person}`");
        }
        match people.accounts.get_mut(account) {
            Some((owner, _)) => *owner = person,
            None => {
                let now = to_micros(Utc::now());
                people.accounts.insert(
                    account.clone(),
                    (
                        person,
                        Account {
                            account: account.clone(),
                            display_name: account.id.clone(),
                            first_seen: now,
                            last_seen: now,
                        },
                    ),
                );
            }
        }
        Ok(())
    }

    async fn merge_people(&self, keep: PersonId, absorb: PersonId) -> anyhow::Result<()> {
        let mut people = self.people.lock();
        for person in [keep, absorb] {
            if !people.people.contains_key(&person) {
                anyhow::bail!("unknown person `{person}`");
            }
        }
        if keep == absorb {
            return Ok(());
        }
        for (owner, _) in people.accounts.values_mut() {
            if *owner == absorb {
                *owner = keep;
            }
        }
        people.people.remove(&absorb);
        Ok(())
    }

    async fn accounts_of(&self, person: PersonId) -> anyhow::Result<Vec<Account>> {
        let people = self.people.lock();
        let mut accounts: Vec<Account> = people
            .accounts
            .values()
            .filter(|(p, _)| *p == person)
            .map(|(_, a)| a.clone())
            .collect();
        accounts.sort_by(|a, b| {
            (a.first_seen, &a.account.platform, &a.account.id).cmp(&(
                b.first_seen,
                &b.account.platform,
                &b.account.id,
            ))
        });
        Ok(accounts)
    }

    async fn set_person_name(&self, person: PersonId, display_name: &str) -> anyhow::Result<()> {
        let mut people = self.people.lock();
        let record = people
            .people
            .get_mut(&person)
            .ok_or_else(|| anyhow::anyhow!("unknown person `{person}`"))?;
        record.display_name = display_name.to_owned();
        Ok(())
    }

    async fn create_link_code(
        &self,
        code: &str,
        account: &AccountRef,
        expires_at: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        self.link_codes
            .lock()
            .insert(code.to_owned(), (account.clone(), to_micros(expires_at)));
        Ok(())
    }

    async fn consume_link_code(
        &self,
        code: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Option<AccountRef>> {
        let removed = self.link_codes.lock().remove(code);
        Ok(removed
            .filter(|(_, expires_at)| *expires_at > to_micros(now))
            .map(|(account, _)| account))
    }
}

#[async_trait]
impl AuthStore for MemoryStore {
    async fn roles(&self) -> anyhow::Result<Vec<RoleDefinition>> {
        let mut roles: Vec<RoleDefinition> = self.auth.lock().roles.values().cloned().collect();
        // Already ordered by name; highest rank first.
        roles.sort_by_key(|r| std::cmp::Reverse(r.rank));
        Ok(roles)
    }

    async fn upsert_role(&self, role: &RoleDefinition) -> anyhow::Result<()> {
        self.auth
            .lock()
            .roles
            .insert(role.name.clone(), role.clone());
        Ok(())
    }

    async fn delete_role(&self, name: &str) -> anyhow::Result<bool> {
        let mut auth = self.auth.lock();
        match auth.roles.get(name) {
            None => return Ok(false),
            Some(role) if role.builtin => anyhow::bail!("role `{name}` is built in"),
            Some(_) => {}
        }
        auth.roles.remove(name);
        auth.assignments.retain(|(_, role, _), _| role != name);
        auth.mappings.retain(|_, m| m.role != name);
        auth.overrides.retain(|_, o| o.role != name);
        Ok(true)
    }

    async fn assignments_for(&self, account: &AccountRef) -> anyhow::Result<Vec<RoleAssignment>> {
        let mut list: Vec<RoleAssignment> = self
            .auth
            .lock()
            .assignments
            .values()
            .filter(|a| &a.account == account)
            .cloned()
            .collect();
        list.sort_by_cached_key(assignment_order);
        Ok(list)
    }

    async fn all_assignments(&self) -> anyhow::Result<Vec<RoleAssignment>> {
        let mut list: Vec<RoleAssignment> =
            self.auth.lock().assignments.values().cloned().collect();
        list.sort_by_cached_key(assignment_order);
        Ok(list)
    }

    async fn assign(&self, assignment: &RoleAssignment) -> anyhow::Result<()> {
        let mut assignment = assignment.clone();
        assignment.at = to_micros(assignment.at);
        let key = (
            assignment.account.clone(),
            assignment.role.clone(),
            json_key(&assignment.scope),
        );
        self.auth.lock().assignments.insert(key, assignment);
        Ok(())
    }

    async fn revoke(
        &self,
        account: &AccountRef,
        role: &str,
        scope: &AuthScope,
    ) -> anyhow::Result<bool> {
        let key = (account.clone(), role.to_owned(), json_key(scope));
        Ok(self.auth.lock().assignments.remove(&key).is_some())
    }

    async fn mappings(
        &self,
        platform: &PlatformId,
        guild: &str,
    ) -> anyhow::Result<Vec<RoleMapping>> {
        Ok(self
            .auth
            .lock()
            .mappings
            .values()
            .filter(|m| &m.platform == platform && m.guild == guild)
            .cloned()
            .collect())
    }

    async fn set_mapping(&self, mapping: &RoleMapping) -> anyhow::Result<()> {
        let key = (
            mapping.platform.0.clone(),
            mapping.guild.clone(),
            mapping.platform_role.clone(),
        );
        self.auth.lock().mappings.insert(key, mapping.clone());
        Ok(())
    }

    async fn remove_mapping(
        &self,
        platform: &PlatformId,
        guild: &str,
        platform_role: &str,
    ) -> anyhow::Result<bool> {
        let key = (
            platform.0.clone(),
            guild.to_owned(),
            platform_role.to_owned(),
        );
        Ok(self.auth.lock().mappings.remove(&key).is_some())
    }

    async fn overrides(&self) -> anyhow::Result<Vec<NodeOverride>> {
        Ok(self.auth.lock().overrides.values().cloned().collect())
    }

    async fn set_override(&self, node_override: &NodeOverride) -> anyhow::Result<()> {
        let key = (
            json_key(&node_override.scope),
            node_override.role.clone(),
            node_override.node.clone(),
        );
        self.auth
            .lock()
            .overrides
            .insert(key, node_override.clone());
        Ok(())
    }

    async fn remove_override(
        &self,
        scope: &AuthScope,
        role: &str,
        node: &str,
    ) -> anyhow::Result<bool> {
        let key = (json_key(scope), role.to_owned(), node.to_owned());
        Ok(self.auth.lock().overrides.remove(&key).is_some())
    }
}

/// Oldest first; ties broken by account, role and scope.
fn assignment_order(a: &RoleAssignment) -> (DateTime<Utc>, String, String, String, String) {
    (
        a.at,
        a.account.platform.0.clone(),
        a.account.id.clone(),
        a.role.clone(),
        json_key(&a.scope),
    )
}

#[async_trait]
impl AuditLog for MemoryStore {
    async fn append(&self, entry: &AuditEntry) -> anyhow::Result<()> {
        let mut audit = self.audit.lock();
        if audit.iter().any(|e| e.id == entry.id) {
            anyhow::bail!("audit entry `{}` already exists", entry.id);
        }
        let mut entry = entry.clone();
        entry.at = to_micros(entry.at);
        let at = audit.partition_point(|e| (e.at, e.id) <= (entry.at, entry.id));
        audit.insert(at, entry);
        Ok(())
    }

    async fn recent(&self, limit: usize, actor: Option<&str>) -> anyhow::Result<Vec<AuditEntry>> {
        Ok(self
            .audit
            .lock()
            .iter()
            .rev()
            .filter(|e| actor.is_none_or(|a| e.actor == a))
            .take(limit)
            .cloned()
            .collect())
    }
}
