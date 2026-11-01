//! Hybrid ranking and relative dates.

use chrono::{DateTime, Utc};
use miyoria_store::{MemoryKind, MemoryRecord};
use miyoria_types::PersonId;

use crate::config::{MemoryConfig, Weights};

/// Signals of one candidate, each in 0..1.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Signals {
    pub vector: f32,
    pub text: f32,
    pub recency: f32,
    pub importance: f32,
    pub subject: f32,
}

impl Signals {
    /// `w_vec·cos + w_text·text + w_recency·recency + w_importance·importance
    /// + w_subject·subject`.
    pub fn score(&self, w: &Weights) -> f32 {
        w.vector * self.vector
            + w.text * self.text
            + w.recency * self.recency
            + w.importance * self.importance
            + w.subject * self.subject
    }
}

/// `exp(-age / tau)` with age measured from the last update.
pub fn recency(updated_at: DateTime<Utc>, now: DateTime<Utc>, tau_days: f32) -> f32 {
    let age_days = (now - updated_at).num_seconds().max(0) as f32 / 86_400.0;
    (-age_days / tau_days.max(0.01)).exp()
}

/// Signals of a record. `text` is already normalized (0..1).
pub fn signals(
    config: &MemoryConfig,
    record: &MemoryRecord,
    vector: Option<f32>,
    text: f32,
    present: &[PersonId],
    now: DateTime<Utc>,
) -> Signals {
    Signals {
        vector: vector.unwrap_or(0.0).clamp(0.0, 1.0),
        text: text.clamp(0.0, 1.0),
        recency: recency(record.updated_at, now, config.recency_tau_days),
        importance: record.importance.clamp(0.0, 1.0),
        subject: if record.subjects.iter().any(|s| present.contains(s)) {
            1.0
        } else {
            0.0
        },
    }
}

/// Final score: the weighted sum, scaled by confidence for facts (a fact she
/// is unsure about ranks lower).
pub fn final_score(config: &MemoryConfig, record: &MemoryRecord, signals: &Signals) -> f32 {
    let base = signals.score(&config.weights);
    if record.kind == MemoryKind::Fact {
        base * (0.5 + 0.5 * record.confidence.clamp(0.0, 1.0))
    } else {
        base
    }
}

/// Fraction of query tokens contained in the record's tokens.
pub fn token_overlap(query: &[String], record_tokens: &str) -> f32 {
    if query.is_empty() {
        return 0.0;
    }
    let have: Vec<&str> = record_tokens.split_whitespace().collect();
    let matched = query.iter().filter(|t| have.contains(&t.as_str())).count();
    matched as f32 / query.len() as f32
}

/// Chinese relative date such as 「剛剛」「昨天」「三天前」「兩週前」.
pub fn relative_date(then: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let secs = (now - then).num_seconds();
    if secs < 3_600 {
        return "剛剛".to_owned();
    }
    let hours = secs / 3_600;
    if hours < 24 {
        return format!("{}小時前", numeral(hours, false));
    }
    let days = hours / 24;
    match days {
        1 => "昨天".to_owned(),
        2 => "前天".to_owned(),
        3..=6 => format!("{}天前", numeral(days, false)),
        7..=29 => format!("{}週前", numeral(days / 7, true)),
        30..=364 => format!("{}個月前", numeral(days / 30, true)),
        _ => format!("{}年前", numeral(days / 365, true)),
    }
}

/// Chinese numeral for 1..=99 (falls back to digits). `measure` uses 「兩」
/// for 2, as in 「兩週」.
fn numeral(n: i64, measure: bool) -> String {
    const DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    match n {
        2 if measure => "兩".to_owned(),
        0..=9 => DIGITS[n as usize].to_owned(),
        10 => "十".to_owned(),
        11..=19 => format!("十{}", DIGITS[(n % 10) as usize]),
        20..=99 => {
            let ones = if n % 10 == 0 {
                ""
            } else {
                DIGITS[(n % 10) as usize]
            };
            format!("{}十{ones}", DIGITS[(n / 10) as usize])
        }
        _ => n.to_string(),
    }
}
