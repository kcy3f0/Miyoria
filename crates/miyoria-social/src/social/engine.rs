//! The social engine: an in-memory cache of the active profile's
//! relationships, kept in sync with the store, plus appraisal and notes.
//!
//! Callers pass `now` explicitly so everything is testable without a clock.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use miyoria_llm::LlmRouter;
use miyoria_store::{
    IdentityStore, PeopleStore, Relationship, RelationshipDelta, RelationshipStore,
};
use miyoria_types::{
    AccountRef, Attitude, Authorizer, ContextKey, Event, Participant, PersonId, ProfileId,
    SocialSignals, Subject,
};
use parking_lot::{Mutex, RwLock};
use tracing::{debug, info, warn};

use super::TOPIC;
use super::appraisal::{self, Line, truncate};
use super::config::SocialConfig;
use super::rel::{
    self, DayLedger, EventKind, OWNER_TAG, Source, day_start, familiarity_change, is_blocked,
    is_owner, label, local_day,
};
use super::rules::classify;

/// Publishes events on the bus (the module wires it to the `EventBus`).
pub type Publisher = Arc<dyn Fn(Event) + Send + Sync>;

/// The stores the engine works with. Backends are provided by the app.
#[derive(Clone)]
pub struct SocialStores {
    pub people: Arc<dyn PeopleStore>,
    pub relationships: Arc<dyn RelationshipStore>,
    /// Needed for `/link` and to know people's accounts right after start.
    pub identity: Option<Arc<dyn IdentityStore>>,
}

/// One line someone said, as seen by the engine.
#[derive(Clone, Debug)]
pub struct Observed {
    pub context: ContextKey,
    pub account: AccountRef,
    pub display_name: String,
    pub text: String,
    /// Explicitly addressed to her (mention, reply, DM).
    pub directed: bool,
    pub ts: DateTime<Utc>,
}

/// Result of `/link <code>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkOutcome {
    Linked {
        keep: PersonId,
        absorbed: PersonId,
    },
    AlreadyLinked,
    SameAccount,
    InvalidCode,
    TooManyAttempts,
    /// No identity store is configured.
    Unavailable,
}

const LINK_CODE_MINUTES: i64 = 10;
const LINK_MAX_FAILURES: u32 = 5;
const ACTIVITY_LINES: usize = 30;
const CONTEXT_LINES_KEPT: usize = 6;
const TONE_THRESHOLD: f32 = 0.15;

struct BufLine {
    person: Option<PersonId>,
    speaker: String,
    text: String,
    fresh: bool,
}

struct ContextBuffer {
    lines: VecDeque<BufLine>,
    /// Lines from people since the last appraisal.
    pending: usize,
    /// Kinds the rules already counted per person since the last appraisal.
    rule_kinds: HashMap<PersonId, HashSet<EventKind>>,
    last_activity: DateTime<Utc>,
    her_last_spoke: Option<DateTime<Utc>>,
    in_flight: bool,
}

impl ContextBuffer {
    fn new(now: DateTime<Utc>) -> Self {
        Self {
            lines: VecDeque::new(),
            pending: 0,
            rule_kinds: HashMap::new(),
            last_activity: now,
            her_last_spoke: None,
            in_flight: false,
        }
    }

    fn push(&mut self, line: BufLine, max: usize) {
        self.lines.push_back(line);
        while self.lines.len() > max {
            self.lines.pop_front();
        }
    }
}

#[derive(Default)]
struct Activity {
    lines: VecDeque<String>,
    since_notes: u32,
    last_notes: Option<DateTime<Utc>>,
    in_flight: bool,
}

impl Activity {
    fn push(&mut self, line: String) {
        self.lines.push_back(line);
        while self.lines.len() > ACTIVITY_LINES {
            self.lines.pop_front();
        }
    }
}

#[derive(Default)]
struct State {
    rels: HashMap<PersonId, Relationship>,
    names: HashMap<PersonId, String>,
    accounts: HashMap<AccountRef, PersonId>,
    ledgers: HashMap<PersonId, DayLedger>,
    contexts: HashMap<ContextKey, ContextBuffer>,
    activity: HashMap<PersonId, Activity>,
    self_accounts: HashSet<AccountRef>,
    /// Interaction counters changed but not yet written.
    dirty: HashSet<PersonId>,
    link_failures: HashMap<AccountRef, (DateTime<Utc>, u32)>,
}

/// Relationships of one profile. Provided as `Arc<Social>` and as
/// `Arc<dyn SocialSignals>`.
pub struct Social {
    profile: ProfileId,
    her_name: String,
    /// Lower-cased names that address her.
    names: Vec<String>,
    config: SocialConfig,
    stores: SocialStores,
    publish: Publisher,
    authorizer: RwLock<Option<Arc<dyn Authorizer>>>,
    state: Mutex<State>,
    /// Serializes read-modify-write cycles so store writes stay in order.
    gate: tokio::sync::Mutex<()>,
}

impl Social {
    pub fn new(
        profile: ProfileId,
        her_name: impl Into<String>,
        names: Vec<String>,
        config: SocialConfig,
        stores: SocialStores,
        publish: Publisher,
    ) -> Self {
        let her_name = her_name.into();
        let mut names: Vec<String> = names
            .into_iter()
            .chain(std::iter::once(her_name.clone()))
            .map(|n| n.trim().to_lowercase())
            .filter(|n| !n.is_empty())
            .collect();
        names.sort();
        names.dedup();
        Self {
            profile,
            her_name,
            names,
            config,
            stores,
            publish,
            authorizer: RwLock::new(None),
            state: Mutex::new(State::default()),
            gate: tokio::sync::Mutex::new(()),
        }
    }

    pub fn profile(&self) -> &ProfileId {
        &self.profile
    }

    pub fn config(&self) -> &SocialConfig {
        &self.config
    }

    /// Used to auto-tag owners and for owner-only commands.
    pub fn set_authorizer(&self, authorizer: Option<Arc<dyn Authorizer>>) {
        *self.authorizer.write() = authorizer;
    }

    pub(crate) fn authorizer(&self) -> Option<Arc<dyn Authorizer>> {
        self.authorizer.read().clone()
    }

    /// Loads every relationship of the profile and, when an identity store
    /// is available, which accounts belong to whom.
    pub async fn load(&self) -> anyhow::Result<()> {
        let rels = self.stores.relationships.list(&self.profile).await?;
        let mut accounts = Vec::new();
        if let Some(identity) = &self.stores.identity {
            for r in &rels {
                match identity.accounts_of(r.person).await {
                    Ok(list) => accounts.push((r.person, list)),
                    Err(e) => warn!(person = %r.person, error = %e, "cannot load accounts"),
                }
            }
        }
        let mut st = self.state.lock();
        let count = rels.len();
        for mut r in rels {
            rel::normalize(&mut r, &self.config);
            st.rels.insert(r.person, r);
        }
        for (person, list) in accounts {
            for a in list {
                st.names.insert(person, a.display_name.clone());
                st.accounts.insert(a.account, person);
            }
        }
        info!(profile = %self.profile, relationships = count, "relationships loaded");
        Ok(())
    }

    /// One of her own accounts; never appraised.
    pub fn add_self_account(&self, account: AccountRef) {
        self.state.lock().self_accounts.insert(account);
    }

    pub fn is_self(&self, account: &AccountRef) -> bool {
        self.state.lock().self_accounts.contains(account)
    }

    pub fn relationship(&self, person: PersonId) -> Option<Relationship> {
        self.state.lock().rels.get(&person).cloned()
    }

    pub fn person_of(&self, account: &AccountRef) -> Option<PersonId> {
        self.state.lock().accounts.get(account).copied()
    }

    pub fn display_name(&self, person: PersonId) -> Option<String> {
        self.state.lock().names.get(&person).cloned()
    }

    /// Today's appraisal budget use of a person, if any was tracked.
    pub fn today(&self, person: PersonId, now: DateTime<Utc>) -> Option<DayLedger> {
        let day = local_day(now, &self.config);
        self.state
            .lock()
            .ledgers
            .get(&person)
            .filter(|l| l.day == day)
            .cloned()
    }

    /// People whose cached display name equals `name` (case-insensitive).
    pub fn people_named(&self, name: &str) -> Vec<PersonId> {
        let name = name.trim().to_lowercase();
        let mut out: Vec<PersonId> = self
            .state
            .lock()
            .names
            .iter()
            .filter(|(_, n)| n.to_lowercase() == name)
            .map(|(p, _)| *p)
            .collect();
        out.sort();
        out
    }

    fn new_rel(&self, person: PersonId, now: DateTime<Utc>) -> Relationship {
        let mut r = Relationship {
            profile: self.profile.clone(),
            person,
            affinity: 0.0,
            trust: self.config.default_trust,
            familiarity: 0.0,
            tags: Vec::new(),
            notes: String::new(),
            call_name: None,
            interactions: 0,
            last_interaction: None,
            updated_at: now,
        };
        rel::normalize(&mut r, &self.config);
        r
    }

    fn account_is_owner(&self, account: &AccountRef) -> bool {
        self.authorizer()
            .is_some_and(|a| a.allows(account, "owner.social"))
    }

    /// Owner check for commands; `fallback` is used when no authorizer is set.
    pub(crate) fn subject_is_owner(&self, subject: &Subject, fallback: bool) -> bool {
        match self.authorizer() {
            Some(a) => a.allows_subject(subject, "owner.person.adjust"),
            None => fallback,
        }
    }

    /// Account → person, from the cache or the people store. With a display
    /// name the account is recorded (creating a person on first sight);
    /// without one, unknown accounts resolve to `None`.
    pub async fn resolve(
        &self,
        account: &AccountRef,
        display_name: Option<&str>,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Option<PersonId>> {
        let cached = self.person_of(account);
        let person = match cached {
            Some(p) => p,
            None => {
                let (person, name) = match display_name {
                    Some(n) => (
                        self.stores.people.upsert_account(account, n).await?,
                        n.to_owned(),
                    ),
                    None => match self.stores.people.person_by_account(account).await? {
                        Some(p) => {
                            let name = p
                                .accounts
                                .iter()
                                .find(|a| &a.account == account)
                                .map_or_else(|| p.display_name.clone(), |a| a.display_name.clone());
                            (p.id, name)
                        }
                        None => return Ok(None),
                    },
                };
                let known = self.state.lock().rels.contains_key(&person);
                let stored = if known {
                    None
                } else {
                    Some(self.stores.relationships.get(&self.profile, person).await?)
                };
                let mut st = self.state.lock();
                st.accounts.insert(account.clone(), person);
                st.names.entry(person).or_insert(name);
                if let Some(stored) = stored {
                    let r = stored.map_or_else(
                        || self.new_rel(person, now),
                        |mut r| {
                            rel::normalize(&mut r, &self.config);
                            r
                        },
                    );
                    st.rels.entry(person).or_insert(r);
                }
                person
            }
        };
        if let Some(n) = display_name {
            self.state.lock().names.insert(person, n.to_owned());
        }
        let tagged = self.relationship(person).is_some_and(|r| is_owner(&r));
        if self.config.auto_owner_tag && !tagged && self.account_is_owner(account) {
            self.modify(person, "system: owner", now, |r| {
                r.tags.push(OWNER_TAG.to_owned());
            })
            .await?;
        }
        Ok(Some(person))
    }

    fn mentions_her(&self, text: &str) -> bool {
        let lower = text.to_lowercase();
        self.names.iter().any(|n| lower.contains(n.as_str()))
    }

    fn spoke_recently(&self, context: &ContextKey, now: DateTime<Utc>) -> bool {
        let window = Duration::seconds(self.config.direct_window_secs);
        self.state
            .lock()
            .contexts
            .get(context)
            .and_then(|b| b.her_last_spoke)
            .is_some_and(|t| now - t <= window)
    }

    /// Handles one line from a person: interaction count, familiarity, rule
    /// deltas (only for lines said to her) and buffering for appraisal.
    /// Returns `true` when the context is due for an LLM appraisal.
    pub async fn observe(&self, line: Observed) -> anyhow::Result<bool> {
        let now = line.ts;
        let Some(person) = self
            .resolve(&line.account, Some(&line.display_name), now)
            .await?
        else {
            return Ok(false);
        };
        if self.relationship(person).is_some_and(|r| is_blocked(&r)) {
            return Ok(false);
        }
        let directed = line.directed
            || self.mentions_her(&line.text)
            || self.spoke_recently(&line.context, now);
        let kinds = if directed {
            classify(&line.text)
        } else {
            Vec::new()
        };
        let events: Vec<_> = kinds.iter().map(|k| (Source::Rule, *k, 1.0)).collect();
        self.apply_events(person, &events, Some(now), Some(&line.context), now)
            .await?;

        let mut guard = self.state.lock();
        let st = &mut *guard;
        let speaker = st
            .names
            .get(&person)
            .cloned()
            .unwrap_or_else(|| line.display_name.clone());
        let text = line.text.trim().to_owned();
        let buf = st
            .contexts
            .entry(line.context.clone())
            .or_insert_with(|| ContextBuffer::new(now));
        buf.push(
            BufLine {
                person: Some(person),
                speaker: speaker.clone(),
                text: text.clone(),
                fresh: true,
            },
            self.config.appraisal_max_lines.max(1),
        );
        buf.pending += 1;
        buf.last_activity = now;
        buf.rule_kinds.entry(person).or_default().extend(kinds);
        let due = !buf.in_flight && buf.pending >= self.config.appraisal_every_lines.max(1);
        let activity = st.activity.entry(person).or_default();
        activity.push(format!("{speaker}: {text}"));
        activity.since_notes += 1;
        Ok(due)
    }

    /// Records her own reply in a context (context for appraisal and notes;
    /// lines right after it count as said to her).
    pub fn observe_self(&self, context: &ContextKey, text: &str, now: DateTime<Utc>) {
        let text = strip_tags(text);
        if text.is_empty() {
            return;
        }
        let mut guard = self.state.lock();
        let st = &mut *guard;
        let buf = st
            .contexts
            .entry(context.clone())
            .or_insert_with(|| ContextBuffer::new(now));
        buf.her_last_spoke = Some(now);
        buf.last_activity = now;
        let recent: HashSet<PersonId> = buf
            .lines
            .iter()
            .rev()
            .take(CONTEXT_LINES_KEPT)
            .filter_map(|l| l.person)
            .collect();
        buf.push(
            BufLine {
                person: None,
                speaker: self.her_name.clone(),
                text: text.clone(),
                fresh: true,
            },
            self.config.appraisal_max_lines.max(1),
        );
        for person in recent {
            st.activity
                .entry(person)
                .or_default()
                .push(format!("{}: {text}", self.her_name));
        }
    }

    /// Contexts with unappraised lines that have been quiet long enough.
    pub fn due_appraisals(&self, now: DateTime<Utc>) -> Vec<ContextKey> {
        let idle = Duration::seconds(self.config.appraisal_idle_secs);
        self.state
            .lock()
            .contexts
            .iter()
            .filter(|(_, b)| !b.in_flight && b.pending > 0 && now - b.last_activity >= idle)
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// Asks the LLM about the unappraised lines of `context` and applies the
    /// result. Returns how many people were appraised.
    pub async fn appraise(
        &self,
        router: &LlmRouter,
        context: &ContextKey,
        now: DateTime<Utc>,
    ) -> anyhow::Result<usize> {
        let Some(snapshot) = self.take_snapshot(context) else {
            return Ok(0);
        };
        let result = self.run_appraisal(router, snapshot, context, now).await;
        if let Some(buf) = self.state.lock().contexts.get_mut(context) {
            buf.in_flight = false;
        }
        result
    }

    fn take_snapshot(&self, context: &ContextKey) -> Option<Snapshot> {
        let mut st = self.state.lock();
        let buf = st.contexts.get_mut(context)?;
        if buf.pending == 0 || buf.in_flight {
            return None;
        }
        buf.in_flight = true;
        buf.pending = 0;
        let rule_kinds = std::mem::take(&mut buf.rule_kinds);

        // Unique speaker labels per person.
        let mut labels: HashMap<PersonId, String> = HashMap::new();
        let mut used: HashSet<String> = HashSet::from([self.her_name.clone()]);
        for line in &buf.lines {
            let Some(p) = line.person else { continue };
            if labels.contains_key(&p) {
                continue;
            }
            let mut name = line.speaker.clone();
            let mut n = 2;
            while used.contains(&name) {
                name = format!("{}#{n}", line.speaker);
                n += 1;
            }
            used.insert(name.clone());
            labels.insert(p, name);
        }
        let mut fresh_people = Vec::new();
        let lines = buf
            .lines
            .iter()
            .map(|l| {
                if l.fresh
                    && let Some(p) = l.person
                    && !fresh_people.contains(&p)
                {
                    fresh_people.push(p);
                }
                Line {
                    speaker: l
                        .person
                        .and_then(|p| labels.get(&p).cloned())
                        .unwrap_or_else(|| l.speaker.clone()),
                    text: l.text.clone(),
                    old: !l.fresh,
                }
            })
            .collect();
        for l in &mut buf.lines {
            l.fresh = false;
        }
        // Keep a little context for the next round.
        while buf.lines.len() > CONTEXT_LINES_KEPT {
            buf.lines.pop_front();
        }
        let people = fresh_people
            .into_iter()
            .filter_map(|p| labels.get(&p).map(|l| (l.clone(), p)))
            .collect();
        Some(Snapshot {
            lines,
            people,
            rule_kinds,
        })
    }

    async fn run_appraisal(
        &self,
        router: &LlmRouter,
        snapshot: Snapshot,
        context: &ContextKey,
        now: DateTime<Utc>,
    ) -> anyhow::Result<usize> {
        if snapshot.people.is_empty() {
            return Ok(0);
        }
        let names: Vec<String> = snapshot.people.iter().map(|(n, _)| n.clone()).collect();
        let request = appraisal::appraisal_request(&self.her_name, &snapshot.lines, &names);
        let response = router.complete(&self.config.llm_purpose, request).await?;
        let results = appraisal::parse_appraisal(&response.text)?;
        let mut applied = 0;
        for result in &results {
            let person = snapshot
                .people
                .iter()
                .find(|(n, _)| n.trim().eq_ignore_ascii_case(result.person_name.trim()))
                .map(|(_, p)| *p)
                .or_else(|| {
                    (snapshot.people.len() == 1 && results.len() == 1).then(|| snapshot.people[0].1)
                });
            let Some(person) = person else {
                debug!(name = %result.person_name, "appraisal names an unknown person");
                continue;
            };
            let counted = snapshot.rule_kinds.get(&person);
            let mut kinds: Vec<EventKind> = result
                .events
                .iter()
                .filter_map(|e| EventKind::parse(e))
                .filter(|k| !matches!(k, EventKind::Warm | EventKind::Cold))
                .filter(|k| counted.is_none_or(|c| !c.contains(k)))
                .collect();
            kinds.sort();
            kinds.dedup();
            let mut events: Vec<_> = kinds
                .into_iter()
                .map(|k| (Source::Appraisal, k, 1.0))
                .collect();
            let tone = result.toward_her;
            if tone >= TONE_THRESHOLD {
                events.push((Source::Appraisal, EventKind::Warm, tone));
            } else if tone <= -TONE_THRESHOLD {
                events.push((Source::Appraisal, EventKind::Cold, tone));
            }
            self.apply_events(person, &events, None, Some(context), now)
                .await?;
            applied += 1;
        }
        Ok(applied)
    }

    /// People whose notes are due for a refresh.
    pub fn due_notes(&self, now: DateTime<Utc>) -> Vec<PersonId> {
        let interval = Duration::hours(self.config.notes_min_interval_hours);
        let st = self.state.lock();
        st.activity
            .iter()
            .filter(|(p, a)| {
                !a.in_flight
                    && a.since_notes >= self.config.notes_every_lines.max(1)
                    && a.last_notes.is_none_or(|t| now - t >= interval)
                    && !st.rels.get(p).is_some_and(is_blocked)
            })
            .map(|(p, _)| *p)
            .collect()
    }

    /// Rewrites her impression notes of `person` from recent lines. Returns
    /// whether the notes changed.
    pub async fn refresh_notes(
        &self,
        router: &LlmRouter,
        person: PersonId,
        now: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        let (lines, old, name) = {
            let mut st = self.state.lock();
            let old = st
                .rels
                .get(&person)
                .map(|r| r.notes.clone())
                .unwrap_or_default();
            let name = st.names.get(&person).cloned().unwrap_or_default();
            let Some(a) = st.activity.get_mut(&person) else {
                return Ok(false);
            };
            if a.in_flight || a.lines.is_empty() {
                return Ok(false);
            }
            a.in_flight = true;
            a.since_notes = 0;
            a.last_notes = Some(now);
            (a.lines.iter().cloned().collect::<Vec<_>>(), old, name)
        };
        let result = async {
            let request = appraisal::notes_request(&self.her_name, &name, &old, &lines);
            let response = router.complete(&self.config.llm_purpose, request).await?;
            let Some(notes) = appraisal::parse_notes(&response.text) else {
                return Ok(false);
            };
            if notes == old {
                return Ok(false);
            }
            self.modify_quiet(person, "notes: refresh", now, |r| r.notes = notes)
                .await?;
            Ok(true)
        }
        .await;
        if let Some(a) = self.state.lock().activity.get_mut(&person) {
            a.in_flight = false;
        }
        result
    }

    /// Writes interaction counters that changed without a numeric change.
    pub async fn flush(&self) -> anyhow::Result<()> {
        let _gate = self.gate.lock().await;
        let rels: Vec<Relationship> = {
            let mut st = self.state.lock();
            let dirty = std::mem::take(&mut st.dirty);
            dirty
                .into_iter()
                .filter_map(|p| st.rels.get(&p).cloned())
                .collect()
        };
        for r in rels {
            self.stores.relationships.upsert(&r).await?;
        }
        Ok(())
    }

    async fn ensure_ledger(&self, person: PersonId, now: DateTime<Utc>) -> anyhow::Result<()> {
        let today = local_day(now, &self.config);
        {
            let mut st = self.state.lock();
            match st.ledgers.get_mut(&person) {
                Some(l) if l.day == today => return Ok(()),
                Some(l) => {
                    *l = DayLedger::new(today);
                    return Ok(());
                }
                None => {}
            }
        }
        let since = day_start(today, &self.config);
        let deltas = self
            .stores
            .relationships
            .deltas_since(&self.profile, person, since)
            .await?;
        self.state
            .lock()
            .ledgers
            .insert(person, DayLedger::from_deltas(today, &deltas));
        Ok(())
    }

    /// Applies capped events and, with `touch`, one interaction.
    pub(crate) async fn apply_events(
        &self,
        person: PersonId,
        events: &[(Source, EventKind, f32)],
        touch: Option<DateTime<Utc>>,
        context: Option<&ContextKey>,
        now: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        if events.is_empty() && touch.is_none() {
            return Ok(());
        }
        let _gate = self.gate.lock().await;
        if !events.is_empty() {
            self.ensure_ledger(person, now).await?;
        }
        let (snapshot, rows) = {
            let mut guard = self.state.lock();
            let st = &mut *guard;
            let r = st
                .rels
                .entry(person)
                .or_insert_with(|| self.new_rel(person, now));
            if is_blocked(r) {
                return Ok(());
            }
            let mut rows: Vec<(RelationshipDelta, Option<EventKind>)> = Vec::new();
            if let Some(ts) = touch {
                let df = familiarity_change(r.last_interaction, ts, &self.config);
                r.interactions = r.interactions.saturating_add(1);
                r.last_interaction = Some(ts);
                let (_, _, df) = rel::apply(r, 0.0, 0.0, df, &self.config);
                if nonzero(df) {
                    rows.push((row(now, 0.0, 0.0, df, "familiarity: day"), None));
                }
            }
            if let Some(ledger) = st.ledgers.get_mut(&person) {
                for &(source, kind, scale) in events {
                    let (a, t) = ledger.take(kind, kind.base(scale), &self.config);
                    let (da, dt, _) = rel::apply(r, a, t, 0.0, &self.config);
                    if nonzero(da) || nonzero(dt) {
                        let reason = format!("{}: {kind}", source.as_str());
                        rows.push((row(now, da, dt, 0.0, reason), Some(kind)));
                    }
                }
            }
            r.updated_at = now;
            if rows.is_empty() {
                st.dirty.insert(person);
                return Ok(());
            }
            st.dirty.remove(&person);
            (r.clone(), rows)
        };
        self.persist(&snapshot, &rows, context).await
    }

    async fn persist(
        &self,
        r: &Relationship,
        rows: &[(RelationshipDelta, Option<EventKind>)],
        context: Option<&ContextKey>,
    ) -> anyhow::Result<()> {
        self.stores.relationships.upsert(r).await?;
        for (delta, kind) in rows {
            self.stores
                .relationships
                .record_delta(&self.profile, r.person, delta)
                .await?;
            self.announce(r, delta, *kind, context);
        }
        Ok(())
    }

    fn announce(
        &self,
        r: &Relationship,
        delta: &RelationshipDelta,
        kind: Option<EventKind>,
        context: Option<&ContextKey>,
    ) {
        let name = self.display_name(r.person);
        (self.publish)(Event::Custom {
            topic: TOPIC.to_owned(),
            payload: serde_json::json!({
                "profile": self.profile,
                "person": r.person,
                "name": name,
                "reason": delta.reason,
                "kind": kind.map(EventKind::as_str),
                "positive": kind.map(EventKind::is_positive),
                "affinity": delta.affinity,
                "trust": delta.trust,
                "familiarity": delta.familiarity,
                "label": label(r),
                "context": context,
            }),
        });
    }

    /// Changes a relationship outside the caps (admin, linking, settings),
    /// recording the difference as one delta.
    pub(crate) async fn modify(
        &self,
        person: PersonId,
        reason: &str,
        now: DateTime<Utc>,
        f: impl FnOnce(&mut Relationship),
    ) -> anyhow::Result<Relationship> {
        self.modify_inner(person, reason, now, true, f).await
    }

    /// Like [`modify`](Self::modify) but without a delta row (notes).
    async fn modify_quiet(
        &self,
        person: PersonId,
        reason: &str,
        now: DateTime<Utc>,
        f: impl FnOnce(&mut Relationship),
    ) -> anyhow::Result<Relationship> {
        self.modify_inner(person, reason, now, false, f).await
    }

    async fn modify_inner(
        &self,
        person: PersonId,
        reason: &str,
        now: DateTime<Utc>,
        record: bool,
        f: impl FnOnce(&mut Relationship),
    ) -> anyhow::Result<Relationship> {
        let _gate = self.gate.lock().await;
        let (before, after) = {
            let mut guard = self.state.lock();
            let st = &mut *guard;
            let r = st
                .rels
                .entry(person)
                .or_insert_with(|| self.new_rel(person, now));
            let before = r.clone();
            f(r);
            r.tags.sort();
            r.tags.dedup();
            rel::normalize(r, &self.config);
            r.updated_at = now;
            st.dirty.remove(&person);
            (before, r.clone())
        };
        let delta = rel::diff(&before, &after, reason, now);
        self.stores.relationships.upsert(&after).await?;
        if record {
            self.stores
                .relationships
                .record_delta(&self.profile, person, &delta)
                .await?;
        }
        self.announce(&after, &delta, None, None);
        Ok(after)
    }

    /// Resets numbers, notes and call name; tags stay.
    pub async fn reset(
        &self,
        person: PersonId,
        by: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Relationship> {
        let fresh = self.new_rel(person, now);
        self.modify(person, &format!("admin: reset by {by}"), now, move |r| {
            let tags = std::mem::take(&mut r.tags);
            *r = Relationship { tags, ..fresh };
        })
        .await
    }

    /// Adds `affinity` directly (owner only; ignores caps).
    pub async fn adjust(
        &self,
        person: PersonId,
        affinity: f32,
        by: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Relationship> {
        self.modify(person, &format!("admin: adjust by {by}"), now, |r| {
            r.affinity += affinity;
        })
        .await
    }

    /// Adds or removes a tag. Returns whether anything changed.
    pub async fn set_tag(
        &self,
        person: PersonId,
        tag: &str,
        on: bool,
        by: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        let has = self
            .relationship(person)
            .is_some_and(|r| rel::has_tag(&r, tag));
        if has == on {
            return Ok(false);
        }
        let verb = if on { "tag" } else { "untag" };
        let tag = tag.to_owned();
        self.modify(person, &format!("admin: {verb} {tag} by {by}"), now, |r| {
            if on {
                r.tags.push(tag);
            } else {
                r.tags.retain(|t| *t != tag);
            }
        })
        .await?;
        Ok(true)
    }

    pub async fn set_call_name(
        &self,
        person: PersonId,
        call_name: Option<String>,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Relationship> {
        self.modify(person, "me: call_name", now, |r| r.call_name = call_name)
            .await
    }

    /// Issues a one-time `/link` code for `account` (valid 10 minutes).
    /// `None` when no identity store is configured.
    pub async fn issue_link_code(
        &self,
        account: &AccountRef,
        display_name: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Option<String>> {
        let Some(identity) = &self.stores.identity else {
            return Ok(None);
        };
        self.resolve(account, Some(display_name), now).await?;
        let ulid = ulid::Ulid::new().to_string();
        let code = ulid[ulid.len() - 8..].to_owned();
        identity
            .create_link_code(&code, account, now + Duration::minutes(LINK_CODE_MINUTES))
            .await?;
        Ok(Some(code))
    }

    /// Redeems a code from another account: the invoker's person is merged
    /// into the issuer's. Relationships keep the higher-affinity side; other
    /// per-profile data (memories) is not merged here.
    pub async fn redeem_link_code(
        &self,
        account: &AccountRef,
        display_name: &str,
        code: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<LinkOutcome> {
        let Some(identity) = self.stores.identity.clone() else {
            return Ok(LinkOutcome::Unavailable);
        };
        let window = Duration::minutes(LINK_CODE_MINUTES);
        {
            let mut st = self.state.lock();
            if let Some((since, n)) = st.link_failures.get(account).copied() {
                if now - since > window {
                    st.link_failures.remove(account);
                } else if n >= LINK_MAX_FAILURES {
                    return Ok(LinkOutcome::TooManyAttempts);
                }
            }
        }
        let code = code.trim().to_uppercase();
        let Some(issuer) = identity.consume_link_code(&code, now).await? else {
            let mut st = self.state.lock();
            let entry = st.link_failures.entry(account.clone()).or_insert((now, 0));
            entry.1 += 1;
            return Ok(LinkOutcome::InvalidCode);
        };
        if &issuer == account {
            return Ok(LinkOutcome::SameAccount);
        }
        let Some(keep) = self.resolve(&issuer, None, now).await? else {
            return Ok(LinkOutcome::InvalidCode);
        };
        let Some(absorb) = self.resolve(account, Some(display_name), now).await? else {
            return Ok(LinkOutcome::InvalidCode);
        };
        if keep == absorb {
            return Ok(LinkOutcome::AlreadyLinked);
        }
        self.merge(keep, absorb, now).await?;
        identity.link_account(account, keep).await?;
        identity.merge_people(keep, absorb).await?;
        let mut st = self.state.lock();
        for p in st.accounts.values_mut() {
            if *p == absorb {
                *p = keep;
            }
        }
        st.names.remove(&absorb);
        st.ledgers.remove(&absorb);
        if let Some(a) = st.activity.remove(&absorb) {
            st.activity.entry(keep).or_default().lines.extend(a.lines);
        }
        info!(%keep, %absorb, "accounts linked; memories are not merged");
        Ok(LinkOutcome::Linked {
            keep,
            absorbed: absorb,
        })
    }

    async fn merge(
        &self,
        keep: PersonId,
        absorb: PersonId,
        now: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        let other = match self.relationship(absorb) {
            Some(r) => Some(r),
            None => self.stores.relationships.get(&self.profile, absorb).await?,
        };
        if let Some(other) = other {
            self.modify(keep, "link: merge", now, |r| merge_into(r, other))
                .await?;
        }
        let _gate = self.gate.lock().await;
        self.state.lock().rels.remove(&absorb);
        self.stores
            .relationships
            .delete(&self.profile, absorb)
            .await?;
        Ok(())
    }

    /// Prompt lines for the people in a turn, speakers first.
    pub fn describe_people(
        &self,
        participants: &[Participant],
        speakers: &[AccountRef],
    ) -> Vec<String> {
        let st = self.state.lock();
        let mut ordered: Vec<&Participant> = participants.iter().collect();
        ordered.sort_by_key(|p| !speakers.contains(&p.account));
        let mut seen_people = HashSet::new();
        let mut seen_accounts = HashSet::new();
        let mut out = Vec::new();
        for p in ordered {
            if out.len() >= self.config.prompt_max_people {
                break;
            }
            if st.self_accounts.contains(&p.account) || !seen_accounts.insert(&p.account) {
                continue;
            }
            let person = p.person.or_else(|| st.accounts.get(&p.account).copied());
            if let Some(person) = person
                && !seen_people.insert(person)
            {
                continue;
            }
            let name = p.display_name.trim();
            out.push(match person.and_then(|x| st.rels.get(&x)) {
                Some(r) => person_line(name, r),
                None => format!("- {name}:陌生人"),
            });
        }
        out
    }
}

impl SocialSignals for Social {
    fn attitude(&self, account: &AccountRef) -> Option<Attitude> {
        let st = self.state.lock();
        let person = st.accounts.get(account)?;
        st.rels.get(person).map(attitude)
    }
}

pub fn attitude(r: &Relationship) -> Attitude {
    Attitude {
        person: r.person,
        affinity: r.affinity,
        trust: r.trust,
        familiarity: r.familiarity,
        blocked: is_blocked(r),
        label: label(r).to_owned(),
        call_name: r.call_name.clone(),
    }
}

/// Keeps the side with the higher affinity; the rest is combined.
pub fn merge_into(keep: &mut Relationship, other: Relationship) {
    let person = keep.person;
    let profile = keep.profile.clone();
    let mut tags = keep.tags.clone();
    tags.extend(other.tags.iter().cloned());
    let familiarity = keep.familiarity.max(other.familiarity);
    let interactions = keep.interactions.saturating_add(other.interactions);
    let last = keep.last_interaction.max(other.last_interaction);
    let (mut base, rest) = if other.affinity > keep.affinity {
        (other, keep.clone())
    } else {
        (keep.clone(), other)
    };
    if base.notes.trim().is_empty() {
        base.notes = rest.notes;
    }
    if base.call_name.is_none() {
        base.call_name = rest.call_name;
    }
    *keep = Relationship {
        profile,
        person,
        tags,
        familiarity,
        interactions,
        last_interaction: last,
        ..base
    };
}

fn person_line(name: &str, r: &Relationship) -> String {
    let mut line = format!("- {name}:{}", label(r));
    if let Some(call) = &r.call_name {
        line.push_str(&format!(";稱呼「{call}」"));
    }
    let tags: Vec<&str> = r
        .tags
        .iter()
        .map(String::as_str)
        .filter(|t| *t != rel::BLOCKED_TAG)
        .collect();
    if !tags.is_empty() {
        line.push_str(&format!(";標籤 {}", tags.join("、")));
    }
    let notes = r.notes.trim();
    if !notes.is_empty() {
        line.push_str(&format!(";印象:{}", truncate(notes, 60)));
    }
    if is_blocked(r) {
        line.push_str("(你決定不理這個人)");
    }
    line
}

struct Snapshot {
    lines: Vec<Line>,
    /// Label shown to the model → person, for people with new lines.
    people: Vec<(String, PersonId)>,
    rule_kinds: HashMap<PersonId, HashSet<EventKind>>,
}

fn row(
    at: DateTime<Utc>,
    affinity: f32,
    trust: f32,
    familiarity: f32,
    reason: impl Into<String>,
) -> RelationshipDelta {
    RelationshipDelta {
        at,
        affinity,
        trust,
        familiarity,
        reason: reason.into(),
    }
}

fn nonzero(v: f32) -> bool {
    v.abs() > 1e-6
}

/// Drops `<emo:...>` style markup from her replies.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    for c in text.chars() {
        match c {
            '<' => depth += 1,
            '>' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}
