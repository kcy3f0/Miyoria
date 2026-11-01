//! [`MemoryEngine`]: storing with dedupe, hybrid recall, consolidation,
//! forgetting and followups. Provided as the service `Arc<MemoryEngine>`.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use miyoria_llm::{ChatMessage, ChatRequest, LlmRouter};
use miyoria_store::{
    LogEntry, MemoryFilter, MemoryKind, MemoryQuery, MemoryRecord, MemoryRecordStore, MemoryScope,
    MessageLog, PeopleStore, PrunePolicy, SettingsStore,
};
use miyoria_types::{AccountRef, ContextKey, Followup, FollowupSource, PersonId, ProfileId};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};
use ulid::Ulid;

use crate::config::MemoryConfig;
use crate::embed::{Embedder, NoEmbedder, cosine};
use crate::extract::{Extraction, SubjectName, parse_extraction, system_prompt, transcript};
use crate::scope::{is_private, scope_for_new};
use crate::score::{final_score, signals, token_overlap};
use crate::tokenize::{text_similarity, token_string, tokenize};

/// Settings key prefix of consolidation watermarks (`memory_watermark:<context>`).
pub const WATERMARK_PREFIX: &str = "memory_watermark:";
/// Settings key of the last maintenance run.
pub const MAINTENANCE_KEY: &str = "memory_maintenance_last";

/// The last log line already consolidated in a context.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watermark {
    pub context: ContextKey,
    pub ts: DateTime<Utc>,
    pub id: Ulid,
}

/// A memory to store.
#[derive(Clone, Debug, PartialEq)]
pub struct NewMemory {
    pub kind: MemoryKind,
    pub scope: MemoryScope,
    pub subjects: Vec<PersonId>,
    pub content: String,
    pub importance: f32,
    pub confidence: f32,
    pub source_context: Option<ContextKey>,
    pub due: Option<DateTime<Utc>>,
}

/// What [`MemoryEngine::store`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stored {
    Inserted(Ulid),
    /// A near-identical record was updated in place (confidence raised).
    Reinforced(Ulid),
    /// A similar record was replaced by a new one.
    Superseded {
        old: Ulid,
        new: Ulid,
    },
}

/// A recalled record with its final score.
#[derive(Clone, Debug, PartialEq)]
pub struct Recalled {
    pub record: MemoryRecord,
    pub score: f32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConsolidationReport {
    /// New log lines read.
    pub lines: usize,
    pub inserted: usize,
    pub reinforced: usize,
    pub superseded: usize,
    /// Extracted items dropped (malformed or trivial).
    pub skipped: usize,
    /// The summarizer's answer was not usable JSON (lines are skipped).
    pub malformed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MaintenanceReport {
    pub pruned: u64,
    pub decayed: usize,
    pub forgotten: usize,
}

/// Someone who spoke in the lines being consolidated.
#[derive(Clone, Debug)]
struct Speaker {
    account: AccountRef,
    names: Vec<String>,
    person: Option<PersonId>,
}

/// Long-term memory of one profile.
pub struct MemoryEngine {
    profile: ProfileId,
    config: MemoryConfig,
    records: Arc<dyn MemoryRecordStore>,
    embedder: Arc<dyn Embedder>,
    people: Option<Arc<dyn PeopleStore>>,
    messages: Option<Arc<dyn MessageLog>>,
    settings: Option<Arc<dyn SettingsStore>>,
    router: Option<Arc<LlmRouter>>,
    watermarks: Mutex<HashMap<String, Watermark>>,
    last_maintenance: Mutex<Option<DateTime<Utc>>>,
}

impl MemoryEngine {
    pub fn new(
        profile: ProfileId,
        config: MemoryConfig,
        records: Arc<dyn MemoryRecordStore>,
    ) -> Self {
        Self {
            profile,
            config,
            records,
            embedder: Arc::new(NoEmbedder),
            people: None,
            messages: None,
            settings: None,
            router: None,
            watermarks: Mutex::new(HashMap::new()),
            last_maintenance: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn with_embedder(mut self, embedder: Arc<dyn Embedder>) -> Self {
        self.embedder = embedder;
        self
    }

    #[must_use]
    pub fn with_people(mut self, people: Option<Arc<dyn PeopleStore>>) -> Self {
        self.people = people;
        self
    }

    #[must_use]
    pub fn with_messages(mut self, messages: Option<Arc<dyn MessageLog>>) -> Self {
        self.messages = messages;
        self
    }

    #[must_use]
    pub fn with_settings(mut self, settings: Option<Arc<dyn SettingsStore>>) -> Self {
        self.settings = settings;
        self
    }

    #[must_use]
    pub fn with_router(mut self, router: Option<Arc<LlmRouter>>) -> Self {
        self.router = router;
        self
    }

    pub fn profile(&self) -> &ProfileId {
        &self.profile
    }

    pub fn config(&self) -> &MemoryConfig {
        &self.config
    }

    pub fn records(&self) -> &Arc<dyn MemoryRecordStore> {
        &self.records
    }

    /// Whether consolidation can run (message log and LLM router present).
    pub fn can_consolidate(&self) -> bool {
        self.messages.is_some() && self.router.is_some()
    }

    /// The person an account belongs to, when a people store is available.
    pub async fn person_of(&self, account: &AccountRef) -> Option<PersonId> {
        let people = self.people.as_ref()?;
        match people.person_by_account(account).await {
            Ok(person) => person.map(|p| p.id),
            Err(e) => {
                warn!(error = %format!("{e:#}"), "person lookup failed");
                None
            }
        }
    }

    async fn embed_one(&self, text: &str) -> Option<Vec<f32>> {
        if !self.embedder.enabled() || text.trim().is_empty() {
            return None;
        }
        match self.embedder.embed(&[text.to_owned()]).await {
            Ok(mut v) if v.len() == 1 => v.pop().filter(|e| !e.is_empty()),
            Ok(_) => None,
            Err(e) => {
                warn!(embedder = self.embedder.name(), error = %format!("{e:#}"), "embedding failed");
                None
            }
        }
    }

    /// Stores a memory, merging it with a near-identical or very similar
    /// existing record of the same kind, scope and subjects.
    pub async fn store(&self, memory: NewMemory, now: DateTime<Utc>) -> anyhow::Result<Stored> {
        let content = memory.content.trim().to_owned();
        if content.is_empty() {
            anyhow::bail!("empty memory");
        }
        let tokens = token_string(&content);
        let embedding = self.embed_one(&content).await;
        let mut subjects = memory.subjects.clone();
        subjects.sort();
        subjects.dedup();

        let query_tokens: Vec<String> = tokens.split_whitespace().map(str::to_owned).collect();
        let hits = if query_tokens.is_empty() && embedding.is_none() {
            Vec::new()
        } else {
            self.records
                .search(&MemoryQuery {
                    profile: self.profile.clone(),
                    scopes: vec![memory.scope.clone()],
                    kinds: Some(vec![memory.kind]),
                    tokens: query_tokens,
                    embedding: embedding.clone(),
                    limit: 10,
                })
                .await?
        };

        let dedupe = &self.config.dedupe;
        let mut identical: Option<(f32, MemoryRecord)> = None;
        let mut similar: Option<(f32, MemoryRecord)> = None;
        for hit in hits {
            let record = hit.record;
            let mut have = record.subjects.clone();
            have.sort();
            have.dedup();
            if have != subjects
                || record.scope != memory.scope
                || record.superseded_by.is_some()
                || record.done
            {
                continue;
            }
            let text_sim = text_similarity(&record.content, &content);
            let vec_sim =
                hit.vector_score
                    .unwrap_or_else(|| match (&embedding, &record.embedding) {
                        (Some(a), Some(b)) => cosine(a, b),
                        _ => 0.0,
                    });
            if text_sim >= dedupe.text_similarity {
                if identical.as_ref().is_none_or(|(s, _)| text_sim > *s) {
                    identical = Some((text_sim, record));
                }
            } else if vec_sim >= dedupe.vector_similarity
                && similar.as_ref().is_none_or(|(s, _)| vec_sim > *s)
            {
                similar = Some((vec_sim, record));
            }
        }

        if let Some((_, mut old)) = identical {
            old.content = content;
            old.tokens = tokens;
            if embedding.is_some() {
                old.embedding = embedding;
            }
            if old.kind != MemoryKind::Followup {
                old.confidence =
                    (old.confidence.max(memory.confidence) + dedupe.reinforce).clamp(0.0, 1.0);
            }
            old.importance = old.importance.max(memory.importance).clamp(0.0, 1.0);
            old.updated_at = now;
            self.records.upsert(&old).await?;
            return Ok(Stored::Reinforced(old.id));
        }

        let mut record = MemoryRecord {
            id: Ulid::new(),
            profile: self.profile.clone(),
            kind: memory.kind,
            scope: memory.scope,
            subjects,
            content,
            tokens,
            embedding,
            importance: memory.importance.clamp(0.0, 1.0),
            confidence: memory.confidence.clamp(0.0, 1.0),
            created_at: now,
            updated_at: now,
            last_accessed: None,
            access_count: 0,
            source_context: memory.source_context,
            due: memory.due,
            done: false,
            superseded_by: None,
        };
        if let Some((_, mut old)) = similar {
            record.confidence = record.confidence.max(old.confidence);
            record.importance = record.importance.max(old.importance);
            record.access_count = old.access_count;
            record.last_accessed = old.last_accessed;
            self.records.upsert(&record).await?;
            old.superseded_by = Some(record.id);
            self.records.upsert(&old).await?;
            return Ok(Stored::Superseded {
                old: old.id,
                new: record.id,
            });
        }
        self.records.upsert(&record).await?;
        Ok(Stored::Inserted(record.id))
    }

    /// Hybrid recall among records in `scopes`. Records about `present`
    /// people are candidates even without a text or vector match. Recalled
    /// records are touched.
    pub async fn recall(
        &self,
        scopes: &[MemoryScope],
        present: &[PersonId],
        query: &str,
        kinds: &[MemoryKind],
        limit: usize,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Vec<Recalled>> {
        if limit == 0 || scopes.is_empty() {
            return Ok(Vec::new());
        }
        let tokens = tokenize(query);
        let embedding = self.embed_one(query).await;
        let wanted = |r: &MemoryRecord| {
            scopes.contains(&r.scope)
                && kinds.contains(&r.kind)
                && r.superseded_by.is_none()
                && !r.done
        };

        // id -> (record, backend text score, vector score)
        let mut candidates: HashMap<Ulid, (MemoryRecord, f32, Option<f32>)> = HashMap::new();
        if !tokens.is_empty() || embedding.is_some() {
            let hits = self
                .records
                .search(&MemoryQuery {
                    profile: self.profile.clone(),
                    scopes: scopes.to_vec(),
                    kinds: Some(kinds.to_vec()),
                    tokens: tokens.clone(),
                    embedding: embedding.clone(),
                    limit: self.config.candidate_limit.max(limit),
                })
                .await?;
            for hit in hits.into_iter().filter(|h| wanted(&h.record)) {
                candidates.insert(
                    hit.record.id,
                    (hit.record, hit.text_score, hit.vector_score),
                );
            }
        }
        for person in present.iter().take(16) {
            let records = self
                .records
                .list(
                    &self.profile,
                    &MemoryFilter {
                        subject: Some(*person),
                        limit: self.config.candidate_limit.max(limit),
                        ..Default::default()
                    },
                )
                .await?;
            for record in records.into_iter().filter(|r| wanted(r)) {
                candidates.entry(record.id).or_insert((record, 0.0, None));
            }
        }

        let max_text = candidates
            .values()
            .map(|(_, t, _)| *t)
            .fold(0.0f32, f32::max);
        let mut ranked: Vec<Recalled> = candidates
            .into_values()
            .map(|(record, text, vector)| {
                let vector = vector.or_else(|| match (&embedding, &record.embedding) {
                    (Some(a), Some(b)) => Some(cosine(a, b)),
                    _ => None,
                });
                let backend = if max_text > 0.0 { text / max_text } else { 0.0 };
                let text = backend.max(token_overlap(&tokens, &record.tokens));
                let s = signals(&self.config, &record, vector, text, present, now);
                let score = final_score(&self.config, &record, &s);
                Recalled { record, score }
            })
            .filter(|r| r.score >= self.config.min_score)
            .collect();
        ranked.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(b.record.updated_at.cmp(&a.record.updated_at))
        });
        ranked.truncate(limit);
        if !ranked.is_empty() {
            let ids: Vec<Ulid> = ranked.iter().map(|r| r.record.id).collect();
            if let Err(e) = self.records.touch(&ids, now).await {
                warn!(error = %format!("{e:#}"), "touching recalled memories failed");
            }
        }
        Ok(ranked)
    }

    fn watermark_key(context: &ContextKey) -> String {
        format!("{WATERMARK_PREFIX}{context}")
    }

    /// The consolidation watermark of a context.
    pub async fn watermark(&self, context: &ContextKey) -> Option<Watermark> {
        let key = Self::watermark_key(context);
        if let Some(w) = self.watermarks.lock().get(&key) {
            return Some(w.clone());
        }
        let settings = self.settings.as_ref()?;
        let value = match settings.get(&self.profile, &key).await {
            Ok(v) => v?,
            Err(e) => {
                warn!(error = %format!("{e:#}"), "reading memory watermark failed");
                return None;
            }
        };
        let w: Watermark = serde_json::from_value(value).ok()?;
        self.watermarks.lock().insert(key, w.clone());
        Some(w)
    }

    async fn set_watermark(&self, watermark: Watermark) {
        let key = Self::watermark_key(&watermark.context);
        self.watermarks
            .lock()
            .insert(key.clone(), watermark.clone());
        if let Some(settings) = &self.settings {
            let value = serde_json::to_value(&watermark).ok();
            if let Err(e) = settings.set(&self.profile, &key, value).await {
                warn!(error = %format!("{e:#}"), "persisting memory watermark failed");
            }
        }
    }

    /// Contexts with a persisted watermark (checked for new lines on start).
    pub async fn watermarked_contexts(&self) -> Vec<ContextKey> {
        let Some(settings) = &self.settings else {
            return Vec::new();
        };
        match settings.list(&self.profile, WATERMARK_PREFIX).await {
            Ok(map) => map
                .into_values()
                .filter_map(|v| serde_json::from_value::<Watermark>(v).ok())
                .map(|w| w.context)
                .collect(),
            Err(e) => {
                warn!(error = %format!("{e:#}"), "listing memory watermarks failed");
                Vec::new()
            }
        }
    }

    /// Consolidates the lines of `context` written after its watermark.
    ///
    /// LLM failures are returned (the watermark stays, so it is retried);
    /// malformed answers are logged and the lines skipped.
    pub async fn consolidate(
        &self,
        context: &ContextKey,
        now: DateTime<Utc>,
    ) -> anyhow::Result<ConsolidationReport> {
        let (Some(messages), Some(router)) = (&self.messages, &self.router) else {
            anyhow::bail!("consolidation needs a message log and the LLM router");
        };
        let mut report = ConsolidationReport::default();
        let mark = self.watermark(context).await;
        let lines: Vec<LogEntry> = messages
            .recent(
                &self.profile,
                context,
                self.config.max_lines_per_batch.max(1),
            )
            .await?
            .into_iter()
            .filter(|e| mark.as_ref().is_none_or(|w| (e.ts, e.id) > (w.ts, w.id)))
            .collect();
        let Some(last) = lines.last() else {
            return Ok(report);
        };
        report.lines = lines.len();
        let next_mark = Watermark {
            context: context.clone(),
            ts: last.ts,
            id: last.id,
        };
        if lines.iter().all(|e| e.is_self || e.text.trim().is_empty()) {
            self.set_watermark(next_mark).await;
            return Ok(report);
        }

        let speakers = self.speakers(&lines).await;
        let private = is_private(context);
        let request = ChatRequest {
            messages: vec![
                ChatMessage::system(system_prompt(&self.config.self_label)),
                ChatMessage::user(transcript(
                    &lines,
                    &self.config.self_label,
                    private,
                    self.config.utc_offset_minutes,
                )),
            ],
            temperature: Some(0.2),
            max_tokens: Some(2000),
            json_mode: true,
            session: Some(miyoria_llm::session_id(
                &self.profile,
                format!("memory-{}", miyoria_llm::context_hash(context)),
            )),
            ..Default::default()
        };
        let response = router.complete(&self.config.purpose, request).await?;
        let extraction = match parse_extraction(&response.text) {
            Ok(x) => x,
            Err(e) => {
                warn!(%context, error = %format!("{e:#}"), "unusable consolidation output, skipping lines");
                report.malformed = true;
                self.set_watermark(next_mark).await;
                return Ok(report);
            }
        };
        let dm_partner = if private && speakers.len() == 1 {
            Some(speakers[0].account.clone())
        } else {
            None
        };
        self.apply(
            extraction,
            context,
            dm_partner.as_ref(),
            &speakers,
            now,
            &mut report,
        )
        .await?;
        self.set_watermark(next_mark).await;
        debug!(%context, ?report, "consolidated");
        Ok(report)
    }

    async fn speakers(&self, lines: &[LogEntry]) -> Vec<Speaker> {
        let mut out: Vec<Speaker> = Vec::new();
        for entry in lines.iter().filter(|e| !e.is_self) {
            match out.iter_mut().find(|s| s.account == entry.author) {
                Some(s) => {
                    if !s.names.contains(&entry.author_name) {
                        s.names.push(entry.author_name.clone());
                    }
                }
                None => out.push(Speaker {
                    account: entry.author.clone(),
                    names: vec![entry.author_name.clone()],
                    person: None,
                }),
            }
        }
        if let Some(people) = &self.people {
            for speaker in &mut out {
                match people.person_by_account(&speaker.account).await {
                    Ok(Some(person)) => {
                        speaker.person = Some(person.id);
                        let names = std::iter::once(person.display_name)
                            .chain(person.accounts.into_iter().map(|a| a.display_name));
                        for name in names {
                            if !name.is_empty() && !speaker.names.contains(&name) {
                                speaker.names.push(name);
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(e) => warn!(error = %format!("{e:#}"), "person lookup failed"),
                }
            }
        }
        out
    }

    async fn apply(
        &self,
        x: Extraction,
        context: &ContextKey,
        dm_partner: Option<&AccountRef>,
        speakers: &[Speaker],
        now: DateTime<Utc>,
        report: &mut ConsolidationReport,
    ) -> anyhow::Result<()> {
        let min = self.config.min_importance;
        report.skipped += x.skipped;
        let everyone: Vec<PersonId> = speakers.iter().filter_map(|s| s.person).collect();
        let scope = |kind, global: Option<PersonId>| {
            scope_for_new(&self.config, context, dm_partner, kind, global)
        };
        let mut items: Vec<NewMemory> = Vec::new();

        if let Some(ep) = x.episode {
            if ep.importance >= min {
                let content = match ep.emotion.as_deref().map(str::trim) {
                    Some(e) if !e.is_empty() => format!("{}(當時我的心情:{e})", ep.summary),
                    _ => ep.summary,
                };
                items.push(NewMemory {
                    kind: MemoryKind::Episode,
                    scope: scope(MemoryKind::Episode, None),
                    subjects: everyone.clone(),
                    content,
                    importance: ep.importance,
                    confidence: 1.0,
                    source_context: Some(context.clone()),
                    due: None,
                });
            } else {
                report.skipped += 1;
            }
        }

        for fact in x.facts {
            if fact.importance < min {
                report.skipped += 1;
                continue;
            }
            let (kind, subjects) = match &fact.subject {
                SubjectName::Myself => (MemoryKind::SelfNote, Vec::new()),
                SubjectName::Named(name) => (
                    MemoryKind::Fact,
                    resolve_name(name, speakers).into_iter().collect(),
                ),
                SubjectName::Unknown => (MemoryKind::Fact, mentioned(&fact.statement, speakers)),
            };
            let global = match (&fact.subject, fact.global) {
                (SubjectName::Named(_), true) => subjects.first().copied(),
                _ => None,
            };
            items.push(NewMemory {
                kind,
                scope: scope(kind, global),
                subjects,
                content: fact.statement,
                importance: fact.importance,
                confidence: fact.confidence,
                source_context: Some(context.clone()),
                due: None,
            });
        }

        for note in x.self_notes {
            if note.importance < min {
                report.skipped += 1;
                continue;
            }
            items.push(NewMemory {
                kind: MemoryKind::SelfNote,
                scope: scope(MemoryKind::SelfNote, None),
                subjects: mentioned(&note.note, speakers),
                content: note.note,
                importance: note.importance,
                confidence: 1.0,
                source_context: Some(context.clone()),
                due: None,
            });
        }

        for f in x.followups {
            let subjects: Vec<PersonId> = match &f.subject {
                SubjectName::Named(name) => resolve_name(name, speakers).into_iter().collect(),
                SubjectName::Myself => Vec::new(),
                SubjectName::Unknown => mentioned(&f.about, speakers),
            };
            let minutes = (f.due_in_hours * 60.0).round() as i64;
            items.push(NewMemory {
                kind: MemoryKind::Followup,
                scope: scope(MemoryKind::Followup, None),
                subjects,
                content: f.about,
                importance: 0.5,
                confidence: 1.0,
                source_context: Some(context.clone()),
                due: Some(now + Duration::minutes(minutes)),
            });
        }

        for item in items {
            match self.store(item, now).await? {
                Stored::Inserted(_) => report.inserted += 1,
                Stored::Reinforced(_) => report.reinforced += 1,
                Stored::Superseded { .. } => report.superseded += 1,
            }
        }
        Ok(())
    }

    /// Daily forgetting: prunes stale unimportant episodes and decays the
    /// confidence of facts not reinforced recently (deleting the faintest).
    pub async fn maintain(&self, now: DateTime<Utc>) -> anyhow::Result<MaintenanceReport> {
        let f = &self.config.forgetting;
        let mut report = MaintenanceReport {
            pruned: self
                .records
                .prune(
                    &self.profile,
                    &PrunePolicy {
                        created_before: now - Duration::days(f.episode_max_age_days),
                        max_importance: f.episode_max_importance,
                        not_accessed_since: now - Duration::days(f.episode_not_accessed_days),
                    },
                )
                .await?,
            ..Default::default()
        };

        let last = self.last_maintenance_run().await;
        let elapsed_days = last.map_or(1.0, |l| {
            ((now - l).num_seconds().max(0) as f32 / 86_400.0).min(30.0)
        });
        let factor = f.decay_per_day.clamp(0.0, 1.0).powf(elapsed_days);
        let stale_before = now - Duration::days(f.decay_after_days);
        let mut before: Option<DateTime<Utc>> = None;
        loop {
            let page = self
                .records
                .list(
                    &self.profile,
                    &MemoryFilter {
                        kind: Some(MemoryKind::Fact),
                        before,
                        limit: 500,
                        ..Default::default()
                    },
                )
                .await?;
            let Some(oldest) = page.last() else { break };
            let next_before = oldest.created_at;
            let full = page.len() == 500;
            for mut record in page {
                if record.updated_at >= stale_before {
                    continue;
                }
                let confidence = record.confidence * factor;
                if confidence < f.forget_below_confidence {
                    if self.records.delete(record.id).await? {
                        report.forgotten += 1;
                    }
                } else if confidence < record.confidence {
                    record.confidence = confidence;
                    self.records.upsert(&record).await?;
                    report.decayed += 1;
                }
            }
            if !full || before == Some(next_before) {
                break;
            }
            before = Some(next_before);
        }
        self.set_last_maintenance(now).await;
        Ok(report)
    }

    /// When maintenance last ran (memory first, then settings).
    pub async fn last_maintenance_run(&self) -> Option<DateTime<Utc>> {
        if let Some(t) = *self.last_maintenance.lock() {
            return Some(t);
        }
        let settings = self.settings.as_ref()?;
        let value = settings.get(&self.profile, MAINTENANCE_KEY).await.ok()??;
        let t: DateTime<Utc> = serde_json::from_value(value).ok()?;
        *self.last_maintenance.lock() = Some(t);
        Some(t)
    }

    async fn set_last_maintenance(&self, at: DateTime<Utc>) {
        *self.last_maintenance.lock() = Some(at);
        if let Some(settings) = &self.settings
            && let Err(e) = settings
                .set(
                    &self.profile,
                    MAINTENANCE_KEY,
                    serde_json::to_value(at).ok(),
                )
                .await
        {
            warn!(error = %format!("{e:#}"), "persisting maintenance time failed");
        }
    }

    /// Every record about this person or from the DM with this account,
    /// newest first.
    pub async fn memories_of(
        &self,
        person: Option<PersonId>,
        account: &AccountRef,
        include_superseded: bool,
    ) -> anyhow::Result<Vec<MemoryRecord>> {
        let mut out: Vec<MemoryRecord> = Vec::new();
        let mut filters = vec![MemoryFilter {
            scope: Some(MemoryScope::Dm {
                account: account.clone(),
            }),
            include_superseded,
            limit: 10_000,
            ..Default::default()
        }];
        if let Some(person) = person {
            filters.push(MemoryFilter {
                subject: Some(person),
                include_superseded,
                limit: 10_000,
                ..Default::default()
            });
            filters.push(MemoryFilter {
                scope: Some(MemoryScope::Person { person }),
                include_superseded,
                limit: 10_000,
                ..Default::default()
            });
        }
        for filter in filters {
            for record in self.records.list(&self.profile, &filter).await? {
                if !out.iter().any(|r| r.id == record.id) {
                    out.push(record);
                }
            }
        }
        out.sort_by_key(|r| std::cmp::Reverse((r.created_at, r.id)));
        Ok(out)
    }

    /// Forgets this person's memories: those matching `keyword`, or all of
    /// them (`None`). Returns how many records were deleted.
    pub async fn forget(
        &self,
        person: Option<PersonId>,
        account: &AccountRef,
        keyword: Option<&str>,
    ) -> anyhow::Result<u64> {
        let mut deleted = 0;
        let records = self.memories_of(person, account, true).await?;
        let matches = |r: &MemoryRecord| match keyword {
            None => true,
            Some(kw) => matches_keyword(r, kw),
        };
        for record in records.iter().filter(|r| matches(r)) {
            if self.records.delete(record.id).await? {
                deleted += 1;
            }
        }
        if keyword.is_none()
            && let Some(person) = person
        {
            deleted += self
                .records
                .delete_by_subject(&self.profile, person)
                .await?;
        }
        Ok(deleted)
    }
}

/// Content contains the keyword, or the record has all of its tokens.
pub fn matches_keyword(record: &MemoryRecord, keyword: &str) -> bool {
    let kw = keyword.trim().to_lowercase();
    if kw.is_empty() {
        return false;
    }
    if record.content.to_lowercase().contains(&kw) {
        return true;
    }
    let tokens = tokenize(&kw);
    !tokens.is_empty()
        && tokens
            .iter()
            .all(|t| token_overlap(std::slice::from_ref(t), &record.tokens) > 0.0)
}

/// The person a name from the summarizer refers to.
fn resolve_name(name: &str, speakers: &[Speaker]) -> Option<PersonId> {
    let name = name.trim().trim_start_matches('@').to_lowercase();
    if name.is_empty() {
        return None;
    }
    let exact = speakers
        .iter()
        .find(|s| s.names.iter().any(|n| n.to_lowercase() == name));
    if let Some(s) = exact {
        return s.person;
    }
    let mut partial = speakers.iter().filter(|s| {
        s.names.iter().any(|n| {
            let n = n.to_lowercase();
            n.chars().count() >= 2 && (name.contains(&n) || n.contains(&name))
        })
    });
    match (partial.next(), partial.next()) {
        (Some(s), None) => s.person,
        _ => None,
    }
}

/// People whose names appear in `text`.
fn mentioned(text: &str, speakers: &[Speaker]) -> Vec<PersonId> {
    let text = text.to_lowercase();
    speakers
        .iter()
        .filter(|s| {
            s.names
                .iter()
                .any(|n| n.chars().count() >= 2 && text.contains(&n.to_lowercase()))
        })
        .filter_map(|s| s.person)
        .collect()
}

/// Turns a followup record into the shared [`Followup`] type.
pub fn to_followup(record: &MemoryRecord) -> Followup {
    Followup {
        id: record.id.to_string(),
        profile: record.profile.clone(),
        person: record.subjects.first().copied(),
        context: record.source_context.clone(),
        about: record.content.clone(),
        due: record.due.unwrap_or(record.created_at),
    }
}

#[async_trait]
impl FollowupSource for MemoryEngine {
    async fn due(&self, profile: &ProfileId, now: DateTime<Utc>) -> anyhow::Result<Vec<Followup>> {
        Ok(self
            .records
            .due_followups(profile, now)
            .await?
            .iter()
            .map(to_followup)
            .collect())
    }

    async fn mark_done(&self, id: &str) -> anyhow::Result<()> {
        let id: Ulid = id
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid followup id `{id}`: {e}"))?;
        let Some(mut record) = self.records.get(id).await? else {
            anyhow::bail!("unknown followup `{id}`");
        };
        if record.kind != MemoryKind::Followup {
            anyhow::bail!("memory `{id}` is not a followup");
        }
        record.done = true;
        record.updated_at = Utc::now();
        self.records.upsert(&record).await
    }
}
