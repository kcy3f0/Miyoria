//! The decision logic, free of I/O: feed it events and ticks with an explicit
//! `now`, and it returns the initiatives to emit.

use std::collections::{HashMap, HashSet, VecDeque};

use chrono::{DateTime, Datelike, Duration, Timelike, Utc};
use miyoria_types::{
    AccountRef, Attitude, ContextKey, ContextKind, Event, Followup, MoodSignals, PlaybackState,
    SocialSignals, VoiceParticipant,
};
use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::config::InitiativeConfig;

const IDLE_HINT: &str = "頻道冷掉了,可以找點話題";
const IDLE_VOICE_HINT: &str = "語音頻道安靜下來了,可以找點話題";
const GREETING_HINT: &str = "跟他打招呼";
const VOICE_JOIN_HINT: &str = "他剛進語音頻道,跟他打個招呼";
const VOICE_JOIN_MANY_HINT: &str = "他們剛進語音頻道,跟大家打個招呼";

/// Optional read-only services the engine consults.
#[derive(Clone, Copy, Default)]
pub struct Signals<'a> {
    pub social: Option<&'a dyn SocialSignals>,
    pub mood: Option<&'a dyn MoodSignals>,
}

/// One initiative to publish as `Event::AgentInitiative`.
#[derive(Clone, Debug, PartialEq)]
pub struct Emission {
    pub context: ContextKey,
    pub reason: &'static str,
    pub hint: String,
    pub about: Vec<AccountRef>,
}

impl Emission {
    pub fn into_event(self) -> Event {
        Event::AgentInitiative {
            context: self.context,
            reason: self.reason.to_owned(),
            hint: self.hint,
            about: self.about,
        }
    }
}

/// Why an initiative was held back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Blocked {
    Disabled,
    QuietHours,
    /// An earlier idle nudge in this context is still waiting for a reply.
    Pending,
    /// A conversation is going on right now.
    Busy,
    ContextCap,
    GlobalCap,
}

/// Counter that resets when the day changes.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
struct DayCount {
    day: i32,
    count: u32,
}

impl DayCount {
    fn current(&self, day: i32) -> u32 {
        if self.day == day { self.count } else { 0 }
    }

    fn bump(&mut self, day: i32) {
        self.count = self.current(day) + 1;
        self.day = day;
    }
}

/// An emitted initiative waiting to see whether anyone answers.
struct Pending {
    at: DateTime<Utc>,
    /// When she said something after the initiative.
    spoke_at: Option<DateTime<Utc>>,
}

#[derive(Default)]
struct CtxState {
    last_activity: Option<DateTime<Utc>>,
    last_human: Option<DateTime<Utc>>,
    /// Recent messages `(time, hers)` inside the busy window.
    recent: VecDeque<(DateTime<Utc>, bool)>,
    /// Current conversation segment.
    seg_total: u32,
    seg_self: u32,
    blocked_logged: bool,
    count: DayCount,
    backoff_level: u32,
    backoff_at: Option<DateTime<Utc>>,
    pending: Option<Pending>,
}

impl CtxState {
    fn reset_segment(&mut self) {
        self.seg_total = 0;
        self.seg_self = 0;
        self.blocked_logged = false;
    }

    fn lively(&self, cfg: &InitiativeConfig) -> bool {
        self.seg_self >= 1 && self.seg_total >= cfg.lively_min_messages
    }

    fn busy(&self, cfg: &InitiativeConfig, now: DateTime<Utc>) -> bool {
        let since = now - secs(cfg.busy_window_secs);
        let mut count = 0;
        for &(ts, hers) in &self.recent {
            if ts > since {
                if hers {
                    return true;
                }
                count += 1;
            }
        }
        count >= cfg.busy_min_messages.max(1)
    }

    /// Backoff level after decay.
    fn level(&self, cfg: &InitiativeConfig, now: DateTime<Utc>) -> u32 {
        let Some(at) = self.backoff_at else { return 0 };
        let decay = Duration::days(i64::from(cfg.backoff_decay_days.max(1)));
        let forgotten = (now - at).num_seconds().max(0) / decay.num_seconds();
        self.backoff_level
            .saturating_sub(u32::try_from(forgotten).unwrap_or(u32::MAX))
    }

    fn adjust_level(&mut self, cfg: &InitiativeConfig, now: DateTime<Utc>, up: bool) {
        let level = self.level(cfg, now);
        self.backoff_level = if up {
            (level + 1).min(cfg.max_backoff_doublings)
        } else {
            level.saturating_sub(1)
        };
        self.backoff_at = Some(now);
    }
}

struct Person {
    last_at: DateTime<Utc>,
    context: ContextKey,
}

/// Persistable counters, backoff and greeting days.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Snapshot {
    global: DayCount,
    contexts: Vec<SnapshotContext>,
    seen: Vec<(AccountRef, i32)>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SnapshotContext {
    context: ContextKey,
    count: DayCount,
    backoff_level: u32,
    backoff_at: Option<DateTime<Utc>>,
}

/// Pure decision state machine behind the module.
pub struct Engine {
    cfg: InitiativeConfig,
    self_accounts: HashSet<AccountRef>,
    contexts: HashMap<ContextKey, CtxState>,
    people: HashMap<AccountRef, Person>,
    /// Non-self participants of the voice channels she is in.
    voice: HashMap<ContextKey, HashSet<AccountRef>>,
    voice_greeted: HashMap<AccountRef, DateTime<Utc>>,
    /// Day index of each person's first message seen.
    seen_day: HashMap<AccountRef, i32>,
    global: DayCount,
    dirty: bool,
}

fn secs(s: u64) -> Duration {
    Duration::seconds(i64::try_from(s).unwrap_or(i64::MAX / 1000))
}

impl Engine {
    pub fn new(cfg: InitiativeConfig) -> Self {
        Self {
            cfg,
            self_accounts: HashSet::new(),
            contexts: HashMap::new(),
            people: HashMap::new(),
            voice: HashMap::new(),
            voice_greeted: HashMap::new(),
            seen_day: HashMap::new(),
            global: DayCount::default(),
            dirty: false,
        }
    }

    // --- time helpers ---

    fn local(&self, now: DateTime<Utc>) -> chrono::NaiveDateTime {
        let offset = (f64::from(self.cfg.timezone_offset_hours) * 3600.0).round() as i64;
        now.naive_utc() + Duration::seconds(offset)
    }

    /// Day index; the day starts at `day_start_hour` local time.
    fn day_of(&self, now: DateTime<Utc>) -> i32 {
        let shifted = self.local(now) - Duration::hours(i64::from(self.cfg.day_start_hour % 24));
        shifted.date().num_days_from_ce()
    }

    fn in_quiet_hours(&self, now: DateTime<Utc>) -> bool {
        let (start, end) = (self.cfg.quiet_start_hour % 24, self.cfg.quiet_end_hour % 24);
        let hour = self.local(now).hour();
        match start.cmp(&end) {
            std::cmp::Ordering::Equal => false,
            std::cmp::Ordering::Less => hour >= start && hour < end,
            std::cmp::Ordering::Greater => hour >= start || hour < end,
        }
    }

    fn mood_factor(&self, sig: &Signals) -> f64 {
        let energy = sig
            .mood
            .map_or(0.5, |m| f64::from(m.mood().energy).clamp(0.0, 1.0));
        2f64.powf(f64::from(self.cfg.mood_influence) * (1.0 - 2.0 * energy))
    }

    // --- persistence ---

    /// Returns a snapshot when something changed since the last call.
    pub fn take_snapshot(&mut self) -> Option<Snapshot> {
        if !std::mem::take(&mut self.dirty) {
            return None;
        }
        Some(Snapshot {
            global: self.global,
            contexts: self
                .contexts
                .iter()
                .filter(|(_, st)| st.count.count > 0 || st.backoff_level > 0)
                .map(|(context, st)| SnapshotContext {
                    context: context.clone(),
                    count: st.count,
                    backoff_level: st.backoff_level,
                    backoff_at: st.backoff_at,
                })
                .collect(),
            seen: self.seen_day.iter().map(|(a, d)| (a.clone(), *d)).collect(),
        })
    }

    pub fn restore(&mut self, snapshot: Snapshot) {
        self.global = snapshot.global;
        for c in snapshot.contexts {
            let st = self.contexts.entry(c.context).or_default();
            st.count = c.count;
            st.backoff_level = c.backoff_level;
            st.backoff_at = c.backoff_at;
        }
        self.seen_day.extend(snapshot.seen);
    }

    // --- events ---

    /// Digests one bus event; may return greetings to emit right away.
    pub fn observe(&mut self, now: DateTime<Utc>, event: &Event, sig: &Signals) -> Vec<Emission> {
        match event {
            Event::PlatformReady { self_account, .. } => {
                self.self_accounts.insert(self_account.clone());
                Vec::new()
            }
            Event::PlatformMessageCreated(m) => {
                self.on_message(now, m.context(), &m.author.account, m.author.is_bot, sig)
            }
            Event::VoiceUtterance(u) => {
                self.on_message(now, &u.context, &u.speaker.account, u.speaker.is_bot, sig)
            }
            Event::VoicePlayback {
                context,
                state: PlaybackState::Started,
                ..
            } => {
                self.record(now, context, true);
                Vec::new()
            }
            Event::VoiceJoined {
                context,
                participants,
            } => {
                let members = self.non_self(participants);
                self.voice.insert(context.clone(), members);
                self.contexts.entry(context.clone()).or_default();
                Vec::new()
            }
            Event::VoiceLeft { context, .. } => {
                self.voice.remove(context);
                self.contexts.remove(context);
                Vec::new()
            }
            Event::VoiceParticipants {
                context,
                participants,
            } => self.on_voice_participants(now, context, participants, sig),
            _ => Vec::new(),
        }
    }

    fn non_self(&self, participants: &[VoiceParticipant]) -> HashSet<AccountRef> {
        participants
            .iter()
            .filter(|p| !p.is_self && !self.self_accounts.contains(&p.account))
            .map(|p| p.account.clone())
            .collect()
    }

    fn on_message(
        &mut self,
        now: DateTime<Utc>,
        context: &ContextKey,
        account: &AccountRef,
        is_bot: bool,
        sig: &Signals,
    ) -> Vec<Emission> {
        let hers = self.self_accounts.contains(account);
        if is_bot && !hers {
            return Vec::new();
        }
        self.record(now, context, hers);
        if hers {
            return Vec::new();
        }
        if let Some(st) = self.contexts.get_mut(context) {
            st.last_human = Some(now);
        }
        self.people.insert(
            account.clone(),
            Person {
                last_at: now,
                context: context.clone(),
            },
        );
        self.maybe_greet(now, context, account, sig)
            .into_iter()
            .collect()
    }

    /// Records a message in a context and settles a pending initiative.
    fn record(&mut self, now: DateTime<Utc>, context: &ContextKey, hers: bool) {
        let cfg = &self.cfg;
        let st = self.contexts.entry(context.clone()).or_default();
        if st
            .last_activity
            .is_some_and(|last| now - last > secs(cfg.idle_after_secs))
        {
            st.reset_segment();
        }
        st.last_activity = Some(now);
        let since = now - secs(cfg.busy_window_secs);
        while st.recent.front().is_some_and(|&(ts, _)| ts <= since) {
            st.recent.pop_front();
        }
        st.recent.push_back((now, hers));
        st.seg_total += 1;
        if hers {
            st.seg_self += 1;
        }
        let replied = match &mut st.pending {
            Some(p) if hers => {
                p.spoke_at.get_or_insert(now);
                false
            }
            Some(p) => p.spoke_at.is_some(),
            None => false,
        };
        if replied {
            st.pending = None;
            st.adjust_level(cfg, now, false);
            self.dirty = true;
            debug!(%context, "initiative got a reply, backoff relaxed");
        }
    }

    fn maybe_greet(
        &mut self,
        now: DateTime<Utc>,
        context: &ContextKey,
        account: &AccountRef,
        sig: &Signals,
    ) -> Option<Emission> {
        let day = self.day_of(now);
        if self.seen_day.insert(account.clone(), day) == Some(day) {
            return None;
        }
        self.dirty = true;
        if !self.cfg.greeting {
            return None;
        }
        let attitude = sig.social?.attitude(account)?;
        if attitude.blocked || !self.is_friend(&attitude) {
            return None;
        }
        self.try_emit(
            now,
            context,
            "greeting",
            GREETING_HINT.to_owned(),
            vec![account.clone()],
            false,
        )
    }

    fn is_friend(&self, a: &Attitude) -> bool {
        self.cfg.friend_labels.contains(&a.label)
    }

    fn on_voice_participants(
        &mut self,
        now: DateTime<Utc>,
        context: &ContextKey,
        participants: &[VoiceParticipant],
        sig: &Signals,
    ) -> Vec<Emission> {
        let members = self.non_self(participants);
        let Some(previous) = self.voice.insert(context.clone(), members.clone()) else {
            // We never saw her join: this is just the baseline.
            self.contexts.entry(context.clone()).or_default();
            return Vec::new();
        };
        let day = self.day_of(now);
        let cooldown = secs(self.cfg.voice_join_cooldown_secs);
        let mut joiners: Vec<AccountRef> = members.difference(&previous).cloned().collect();
        joiners.sort_by(|a, b| a.id.cmp(&b.id));
        for j in &joiners {
            if self.seen_day.insert(j.clone(), day) != Some(day) {
                self.dirty = true;
            }
        }
        if !self.cfg.voice_join {
            return Vec::new();
        }
        let eligible: Vec<AccountRef> = joiners
            .into_iter()
            .filter(|j| {
                self.voice_greeted
                    .get(j)
                    .is_none_or(|&at| now - at >= cooldown)
                    && sig.social.and_then(|s| s.attitude(j)).is_some_and(|a| {
                        !a.blocked
                            && (a.affinity >= self.cfg.voice_join_min_affinity
                                || self.is_friend(&a))
                    })
            })
            .collect();
        if eligible.is_empty() {
            return Vec::new();
        }
        let hint = if eligible.len() == 1 {
            VOICE_JOIN_HINT
        } else {
            VOICE_JOIN_MANY_HINT
        };
        let Some(e) = self.try_emit(
            now,
            context,
            "voice_join",
            hint.to_owned(),
            eligible.clone(),
            false,
        ) else {
            return Vec::new();
        };
        for j in eligible {
            self.voice_greeted.insert(j, now);
        }
        vec![e]
    }

    // --- ticks ---

    /// Periodic work: settles unanswered initiatives and finds idle contexts.
    pub fn tick(&mut self, now: DateTime<Utc>, sig: &Signals) -> Vec<Emission> {
        self.settle_pending(now);
        self.prune(now);
        let mood = self.mood_factor(sig);
        let cfg = &self.cfg;
        let idle_max = secs(cfg.idle_max_secs);
        let mut due = Vec::new();
        for (ctx, st) in &mut self.contexts {
            let Some(last) = st.last_activity else {
                continue;
            };
            let elapsed = now - last;
            if elapsed > idle_max {
                st.reset_segment();
                continue;
            }
            if !cfg.idle_channel || !st.lively(cfg) {
                continue;
            }
            if ctx.kind == ContextKind::Voice && self.voice.get(ctx).is_none_or(HashSet::is_empty) {
                continue;
            }
            let threshold =
                cfg.idle_after_secs as f64 * 2f64.powi(st.level(cfg, now) as i32) * mood;
            if elapsed.num_milliseconds() as f64 / 1000.0 >= threshold {
                due.push(ctx.clone());
            }
        }
        due.sort_by_key(ToString::to_string);
        let mut out = Vec::new();
        for ctx in due {
            let hint = if ctx.kind == ContextKind::Voice {
                IDLE_VOICE_HINT
            } else {
                IDLE_HINT
            };
            match self.try_emit_checked(
                now,
                &ctx,
                "idle_channel",
                hint.to_owned(),
                Vec::new(),
                true,
            ) {
                Ok(e) => out.push(e),
                Err(blocked) => {
                    if let Some(st) = self.contexts.get_mut(&ctx)
                        && !std::mem::replace(&mut st.blocked_logged, true)
                    {
                        debug!(context = %ctx, ?blocked, "idle initiative held back");
                    }
                }
            }
        }
        out
    }

    fn settle_pending(&mut self, now: DateTime<Utc>) {
        let cfg = &self.cfg;
        let window = secs(cfg.reply_window_secs);
        for (ctx, st) in &mut self.contexts {
            let Some(p) = &st.pending else { continue };
            if now < p.spoke_at.unwrap_or(p.at) + window {
                continue;
            }
            if p.spoke_at.is_some() {
                st.adjust_level(cfg, now, true);
                self.dirty = true;
                debug!(context = %ctx, level = st.backoff_level, "initiative unanswered, backing off");
            }
            st.pending = None;
        }
    }

    fn prune(&mut self, now: DateTime<Utc>) {
        let day = self.day_of(now);
        let before = self.seen_day.len();
        self.seen_day.retain(|_, d| *d >= day - 1);
        self.dirty |= self.seen_day.len() != before;
        self.people
            .retain(|_, p| now - p.last_at < Duration::days(1));
        self.voice_greeted
            .retain(|_, at| now - *at < Duration::days(1));
    }

    // --- followups ---

    /// Decides whether a due followup can be brought up now. On `Some` the
    /// caller must publish it and mark the followup done.
    pub fn plan_followup(
        &mut self,
        now: DateTime<Utc>,
        followup: &Followup,
        sig: &Signals,
    ) -> Option<Emission> {
        if !self.cfg.followup {
            return None;
        }
        let active = secs(self.cfg.followup_active_secs);
        // (context, account, last active)
        let mut cands: Vec<(ContextKey, Option<AccountRef>, DateTime<Utc>)> = Vec::new();
        match &followup.person {
            Some(person) => {
                let social = sig.social?;
                let is_them = |a: &AccountRef| {
                    social
                        .attitude(a)
                        .is_some_and(|att| att.person == *person && !att.blocked)
                };
                for (acc, p) in &self.people {
                    if now - p.last_at <= active && is_them(acc) {
                        cands.push((p.context.clone(), Some(acc.clone()), p.last_at));
                    }
                }
                for (ctx, members) in &self.voice {
                    for acc in members.iter().filter(|a| is_them(a)) {
                        cands.push((ctx.clone(), Some(acc.clone()), now));
                    }
                }
            }
            None => {
                let ctx = followup.context.as_ref()?;
                let last = self.contexts.get(ctx)?.last_human?;
                if now - last <= active {
                    cands.push((ctx.clone(), None, last));
                }
            }
        }
        cands.sort_by(|a, b| {
            let pa = followup.context.as_ref() == Some(&a.0);
            let pb = followup.context.as_ref() == Some(&b.0);
            pb.cmp(&pa)
                .then(b.2.cmp(&a.2))
                .then_with(|| a.0.to_string().cmp(&b.0.to_string()))
        });
        for (ctx, account, _) in cands {
            let about = account.into_iter().collect();
            match self.try_emit_checked(now, &ctx, "followup", followup.about.clone(), about, false)
            {
                Ok(e) => return Some(e),
                Err(blocked) => {
                    debug!(id = %followup.id, context = %ctx, ?blocked, "followup held back");
                }
            }
        }
        None
    }

    // --- budget ---

    fn try_emit(
        &mut self,
        now: DateTime<Utc>,
        context: &ContextKey,
        reason: &'static str,
        hint: String,
        about: Vec<AccountRef>,
        idle: bool,
    ) -> Option<Emission> {
        match self.try_emit_checked(now, context, reason, hint, about, idle) {
            Ok(e) => Some(e),
            Err(blocked) => {
                debug!(%context, reason, ?blocked, "initiative held back");
                None
            }
        }
    }

    /// Applies hard rules, then caps; on success books the initiative.
    fn try_emit_checked(
        &mut self,
        now: DateTime<Utc>,
        context: &ContextKey,
        reason: &'static str,
        hint: String,
        about: Vec<AccountRef>,
        idle: bool,
    ) -> Result<Emission, Blocked> {
        if self.cfg.is_disabled(context) {
            return Err(Blocked::Disabled);
        }
        // Idle nudges are not reactions to anyone, so they stay out of quiet
        // hours and do not stack up on an unanswered one.
        if idle && self.in_quiet_hours(now) {
            return Err(Blocked::QuietHours);
        }
        let day = self.day_of(now);
        let st = self.contexts.entry(context.clone()).or_default();
        if idle && st.pending.is_some() {
            return Err(Blocked::Pending);
        }
        if st.busy(&self.cfg, now) {
            return Err(Blocked::Busy);
        }
        if st.count.current(day) >= self.cfg.max_per_context_per_day {
            return Err(Blocked::ContextCap);
        }
        if self.global.current(day) >= self.cfg.max_per_day {
            return Err(Blocked::GlobalCap);
        }
        st.count.bump(day);
        st.pending.get_or_insert(Pending {
            at: now,
            spoke_at: None,
        });
        st.reset_segment();
        self.global.bump(day);
        self.dirty = true;
        debug!(%context, reason, %hint, "initiative emitted");
        Ok(Emission {
            context: context.clone(),
            reason,
            hint,
            about,
        })
    }
}
