//! Relationship arithmetic: event values, daily caps, diminishing returns,
//! the owner floor and labels. Pure functions, no I/O.

use std::collections::HashMap;
use std::fmt;

use chrono::{DateTime, Duration, FixedOffset, NaiveDate, TimeZone, Utc};
use miyoria_store::{Relationship, RelationshipDelta};
use serde::{Deserialize, Serialize};

use super::config::SocialConfig;

pub const OWNER_TAG: &str = "owner";
pub const BLOCKED_TAG: &str = "blocked";

/// Something a person did toward her.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Greeting,
    Thanks,
    Praise,
    Gift,
    Friendly,
    Apology,
    /// Overall positive tone judged by the LLM (`toward_her > 0`).
    Warm,
    /// Overall negative tone judged by the LLM (`toward_her < 0`).
    Cold,
    Rude,
    Insult,
    Harassment,
    FlirtTooFar,
}

impl EventKind {
    pub const ALL: [Self; 12] = [
        Self::Greeting,
        Self::Thanks,
        Self::Praise,
        Self::Gift,
        Self::Friendly,
        Self::Apology,
        Self::Warm,
        Self::Cold,
        Self::Rude,
        Self::Insult,
        Self::Harassment,
        Self::FlirtTooFar,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Greeting => "greeting",
            Self::Thanks => "thanks",
            Self::Praise => "praise",
            Self::Gift => "gift",
            Self::Friendly => "friendly",
            Self::Apology => "apology",
            Self::Warm => "warm",
            Self::Cold => "cold",
            Self::Rude => "rude",
            Self::Insult => "insult",
            Self::Harassment => "harassment",
            Self::FlirtTooFar => "flirt_too_far",
        }
    }

    /// Parses an event name, accepting a few synonyms LLMs like to use.
    pub fn parse(name: &str) -> Option<Self> {
        let n = name.trim().to_lowercase().replace(['-', ' '], "_");
        Some(match n.as_str() {
            "greeting" | "greet" | "hello" => Self::Greeting,
            "thanks" | "thank" | "gratitude" => Self::Thanks,
            "praise" | "compliment" => Self::Praise,
            "gift" | "donation" | "donate" | "tip" | "superchat" => Self::Gift,
            "friendly" | "kind" | "kindness" | "help" | "support" => Self::Friendly,
            "apology" | "apologize" | "sorry" => Self::Apology,
            "warm" => Self::Warm,
            "cold" => Self::Cold,
            "rude" | "rudeness" | "mean" => Self::Rude,
            "insult" | "abuse" | "abusive" => Self::Insult,
            "harassment" | "harass" | "threat" => Self::Harassment,
            "flirt_too_far" | "flirting_too_far" | "sexual" | "creepy" => Self::FlirtTooFar,
            _ => return None,
        })
    }

    pub fn is_positive(self) -> bool {
        matches!(
            self,
            Self::Greeting
                | Self::Thanks
                | Self::Praise
                | Self::Gift
                | Self::Friendly
                | Self::Apology
                | Self::Warm
        )
    }

    /// `(affinity, trust)` before caps. `scale` only matters for `Warm` /
    /// `Cold` (the LLM's `toward_her`, -1..1).
    pub fn base(self, scale: f32) -> (f32, f32) {
        match self {
            Self::Greeting => (0.5, 0.1),
            Self::Thanks => (1.0, 0.5),
            Self::Praise => (1.5, 0.3),
            Self::Gift => (3.0, 1.0),
            Self::Friendly => (0.8, 0.3),
            Self::Apology => (1.0, 0.8),
            Self::Warm => (2.0 * scale.abs(), 0.5 * scale.abs()),
            Self::Cold => (-2.0 * scale.abs(), -0.8 * scale.abs()),
            Self::Rude => (-1.5, -0.5),
            Self::Insult => (-3.0, -1.0),
            Self::Harassment => (-5.0, -3.0),
            Self::FlirtTooFar => (-2.0, -1.5),
        }
    }
}

impl fmt::Display for EventKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where a capped change came from; part of the delta `reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Rule,
    Appraisal,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rule => "rule",
            Self::Appraisal => "appraisal",
        }
    }
}

/// `"rule: praise"` → `Praise`. Only rule / appraisal reasons count toward caps.
pub fn capped_kind(reason: &str) -> Option<EventKind> {
    let (source, kind) = reason.split_once(':')?;
    matches!(source.trim(), "rule" | "appraisal")
        .then(|| EventKind::parse(kind))
        .flatten()
}

/// One person's appraisal budget for one local day.
#[derive(Clone, Debug, PartialEq)]
pub struct DayLedger {
    pub day: NaiveDate,
    pub affinity_gained: f32,
    pub affinity_lost: f32,
    pub trust_gained: f32,
    pub trust_lost: f32,
    pub counts: HashMap<EventKind, u32>,
}

impl DayLedger {
    pub fn new(day: NaiveDate) -> Self {
        Self {
            day,
            affinity_gained: 0.0,
            affinity_lost: 0.0,
            trust_gained: 0.0,
            trust_lost: 0.0,
            counts: HashMap::new(),
        }
    }

    /// Rebuilds a ledger from the deltas recorded since the start of `day`.
    pub fn from_deltas(day: NaiveDate, deltas: &[RelationshipDelta]) -> Self {
        let mut ledger = Self::new(day);
        for d in deltas {
            let Some(kind) = capped_kind(&d.reason) else {
                continue;
            };
            *ledger.counts.entry(kind).or_default() += 1;
            ledger.book(d.affinity, d.trust);
        }
        ledger
    }

    fn book(&mut self, affinity: f32, trust: f32) {
        if affinity > 0.0 {
            self.affinity_gained += affinity;
        } else {
            self.affinity_lost -= affinity;
        }
        if trust > 0.0 {
            self.trust_gained += trust;
        } else {
            self.trust_lost -= trust;
        }
    }

    /// Applies diminishing returns and the daily caps to a raw change and
    /// books what is left.
    pub fn take(&mut self, kind: EventKind, raw: (f32, f32), config: &SocialConfig) -> (f32, f32) {
        let count = self.counts.entry(kind).or_default();
        let exponent = i32::try_from(*count).unwrap_or(i32::MAX);
        let factor = config.repeat_decay.clamp(0.0, 1.0).powi(exponent);
        *count += 1;
        let affinity = clip(
            raw.0 * factor,
            config.daily_affinity_cap,
            self.affinity_gained,
            self.affinity_lost,
        );
        let trust = clip(
            raw.1 * factor,
            config.daily_trust_cap,
            self.trust_gained,
            self.trust_lost,
        );
        self.book(affinity, trust);
        (affinity, trust)
    }
}

fn clip(value: f32, cap: f32, gained: f32, lost: f32) -> f32 {
    if value > 0.0 {
        value.min((cap - gained).max(0.0))
    } else {
        value.max(-(cap - lost).max(0.0))
    }
}

pub fn has_tag(rel: &Relationship, tag: &str) -> bool {
    rel.tags.iter().any(|t| t == tag)
}

pub fn is_owner(rel: &Relationship) -> bool {
    has_tag(rel, OWNER_TAG)
}

pub fn is_blocked(rel: &Relationship) -> bool {
    has_tag(rel, BLOCKED_TAG)
}

/// Clamps every number to its range and applies the owner floor.
pub fn normalize(rel: &mut Relationship, config: &SocialConfig) {
    rel.affinity = finite(rel.affinity).clamp(-100.0, 100.0);
    rel.trust = finite(rel.trust).clamp(0.0, 100.0);
    rel.familiarity = finite(rel.familiarity).clamp(0.0, 100.0);
    if is_owner(rel) {
        rel.trust = config.owner_trust.clamp(0.0, 100.0);
        rel.affinity = rel
            .affinity
            .max(config.owner_affinity_floor.clamp(-100.0, 100.0));
    }
}

fn finite(v: f32) -> f32 {
    if v.is_finite() { v } else { 0.0 }
}

/// Adds the changes, normalizes and returns what actually changed.
pub fn apply(
    rel: &mut Relationship,
    affinity: f32,
    trust: f32,
    familiarity: f32,
    config: &SocialConfig,
) -> (f32, f32, f32) {
    let before = (rel.affinity, rel.trust, rel.familiarity);
    rel.affinity += affinity;
    rel.trust += trust;
    rel.familiarity += familiarity;
    normalize(rel, config);
    (
        rel.affinity - before.0,
        rel.trust - before.1,
        rel.familiarity - before.2,
    )
}

/// The difference between two states as a delta row.
pub fn diff(
    before: &Relationship,
    after: &Relationship,
    reason: impl Into<String>,
    at: DateTime<Utc>,
) -> RelationshipDelta {
    RelationshipDelta {
        at,
        affinity: after.affinity - before.affinity,
        trust: after.trust - before.trust,
        familiarity: after.familiarity - before.familiarity,
        reason: reason.into(),
    }
}

/// Familiarity change for an interaction at `now`: +1 on the first
/// interaction of a local day, minus the decay for the days without contact.
pub fn familiarity_change(
    last: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    config: &SocialConfig,
) -> f32 {
    let today = local_day(now, config);
    let Some(last) = last else {
        return 1.0;
    };
    let gap = (today - local_day(last, config)).num_days();
    if gap <= 0 {
        return 0.0;
    }
    let idle_days = (gap - 1 - config.familiarity_grace_days).max(0);
    let decay = idle_days as f32 * config.familiarity_decay_per_day;
    1.0 - decay
}

/// Short label for prompts and `/me`.
pub fn label(rel: &Relationship) -> &'static str {
    let (a, f) = (rel.affinity, rel.familiarity);
    if a <= -50.0 {
        "很討厭"
    } else if a <= -15.0 {
        "討厭"
    } else if a >= 75.0 && f >= 30.0 {
        "摯友"
    } else if a >= 45.0 && f >= 10.0 {
        "好朋友"
    } else if a >= 15.0 {
        "朋友"
    } else if f < 3.0 {
        "陌生人"
    } else {
        "認識"
    }
}

fn offset(config: &SocialConfig) -> FixedOffset {
    FixedOffset::east_opt(config.utc_offset_minutes * 60)
        .unwrap_or_else(|| FixedOffset::east_opt(0).expect("zero offset"))
}

/// Her local calendar day of `ts`.
pub fn local_day(ts: DateTime<Utc>, config: &SocialConfig) -> NaiveDate {
    ts.with_timezone(&offset(config)).date_naive()
}

/// The UTC instant her local `day` starts.
pub fn day_start(day: NaiveDate, config: &SocialConfig) -> DateTime<Utc> {
    let midnight = day.and_hms_opt(0, 0, 0).expect("midnight exists");
    offset(config)
        .from_local_datetime(&midnight)
        .single()
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(|| midnight.and_utc() - Duration::minutes(config.utc_offset_minutes.into()))
}
