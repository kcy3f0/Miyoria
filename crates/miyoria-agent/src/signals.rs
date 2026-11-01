//! Signals from other modules that shape her behaviour: how she feels about
//! people (`dyn SocialSignals`), her mood (`dyn MoodSignals`) and the LLM
//! budget (`llm.budget` events).

use std::fmt;
use std::str::FromStr;

use miyoria_types::{Attitude, Mood};
use serde::{Deserialize, Serialize};

/// Topic of the `Event::Custom` the LLM layer publishes when its budget
/// state changes; the payload is `{"state": "ok" | "degraded" | "exhausted", ...}`.
pub const BUDGET_TOPIC: &str = "llm.budget";

/// What she says (at most once per context per notice interval) when the LLM
/// budget is exhausted. Constant: no model is involved.
pub const EXHAUSTED_LINE: &str = "哼……今天的能量用完了啦,才、才不是想偷懶!明天再陪你們聊。";

/// At or below this affinity she may ignore even direct address.
pub const IGNORE_DIRECT_AFFINITY: f32 = -80.0;

/// State of the LLM budget as reported on `llm.budget`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BudgetState {
    #[default]
    Ok,
    /// Save tokens: ambient channels act like mention-only, no initiative.
    Degraded,
    /// No generation at all; a canned line now and then instead.
    Exhausted,
}

impl FromStr for BudgetState {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ok" => Ok(Self::Ok),
            "degraded" => Ok(Self::Degraded),
            "exhausted" => Ok(Self::Exhausted),
            other => anyhow::bail!("unknown budget state `{other}`"),
        }
    }
}

impl fmt::Display for BudgetState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Ok => "ok",
            Self::Degraded => "degraded",
            Self::Exhausted => "exhausted",
        })
    }
}

/// Multiplier for ambient reply probabilities: ×0.3 at affinity -100, ×1 at
/// 0, ×1.4 at +100 (linear in between).
pub fn affinity_ambient_factor(affinity: f32) -> f32 {
    let a = affinity.clamp(-100.0, 100.0) / 100.0;
    if a >= 0.0 {
        1.0 + 0.4 * a
    } else {
        1.0 + 0.7 * a
    }
}

/// Multiplier for the reply probability of direct address: she answers
/// people she dislikes (coldly), unless affinity is at or below -80.
pub fn affinity_direct_factor(affinity: f32) -> f32 {
    let a = affinity.clamp(-100.0, 100.0);
    if a <= IGNORE_DIRECT_AFFINITY {
        0.4
    } else if a > 0.0 {
        1.0 + 0.1 * a / 100.0
    } else {
        1.0
    }
}

/// Multiplier for ambient reply probabilities: ×0.7 when exhausted, ×1.3
/// with full energy.
pub fn energy_probability_factor(mood: &Mood) -> f32 {
    0.7 + 0.6 * mood.energy.clamp(0.0, 1.0)
}

/// Multiplier for the ambient cooldown: ×1.3 when tired, ×0.7 with full energy.
pub fn energy_cooldown_factor(mood: &Mood) -> f32 {
    1.3 - 0.6 * mood.energy.clamp(0.0, 1.0)
}

/// `冷淡` / `普通` / `親近`.
pub fn tone(affinity: f32) -> &'static str {
    if affinity < -20.0 {
        "冷淡"
    } else if affinity > 40.0 {
        "親近"
    } else {
        "普通"
    }
}

/// `"你對 Owen 的態度:親近(朋友),你都叫對方「歐文」"`.
pub fn attitude_hint(name: &str, attitude: &Attitude) -> String {
    let mut line = format!("你對 {name} 的態度:{}", tone(attitude.affinity));
    let label = attitude.label.trim();
    if !label.is_empty() {
        line.push_str(&format!("({label})"));
    }
    if let Some(call) = attitude
        .call_name
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        line.push_str(&format!(",你都叫對方「{call}」"));
    }
    line
}

/// One line describing her mood, e.g. `"你現在的狀態:心情不錯、平靜、有點累"`.
pub fn mood_hint(mood: &Mood) -> String {
    let valence = if mood.valence < -0.3 {
        "心情不太好"
    } else if mood.valence > 0.3 {
        "心情不錯"
    } else {
        "心情普通"
    };
    let arousal = if mood.arousal > 0.7 {
        "有點興奮"
    } else if mood.arousal < 0.3 {
        "平靜"
    } else {
        "還算放鬆"
    };
    let energy = if mood.energy < 0.3 {
        "有點累"
    } else if mood.energy > 0.7 {
        "精神很好"
    } else {
        "精神普通"
    };
    format!("你現在的狀態:{valence}、{arousal}、{energy}")
}

#[cfg(test)]
mod tests {
    use miyoria_types::PersonId;

    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    #[test]
    fn affinity_factors() {
        assert!(close(affinity_ambient_factor(-100.0), 0.3));
        assert!(close(affinity_ambient_factor(-500.0), 0.3));
        assert!(close(affinity_ambient_factor(0.0), 1.0));
        assert!(close(affinity_ambient_factor(50.0), 1.2));
        assert!(close(affinity_ambient_factor(100.0), 1.4));
        assert!(close(affinity_direct_factor(-79.0), 1.0));
        assert!(close(affinity_direct_factor(-80.0), 0.4));
        assert!(close(affinity_direct_factor(100.0), 1.1));
    }

    #[test]
    fn mood_factors_and_hint() {
        let tired = Mood {
            valence: -0.5,
            arousal: 0.1,
            energy: 0.0,
        };
        let fresh = Mood {
            valence: 0.8,
            arousal: 0.9,
            energy: 1.0,
        };
        assert!(close(energy_probability_factor(&tired), 0.7));
        assert!(close(energy_probability_factor(&fresh), 1.3));
        assert!(close(energy_cooldown_factor(&tired), 1.3));
        assert!(close(energy_cooldown_factor(&fresh), 0.7));
        assert_eq!(mood_hint(&tired), "你現在的狀態:心情不太好、平靜、有點累");
        assert_eq!(
            mood_hint(&fresh),
            "你現在的狀態:心情不錯、有點興奮、精神很好"
        );
    }

    #[test]
    fn attitude_hints() {
        let mut a = Attitude {
            person: PersonId::new(),
            affinity: 60.0,
            trust: 50.0,
            familiarity: 50.0,
            blocked: false,
            label: "朋友".into(),
            call_name: Some("歐文".into()),
        };
        assert_eq!(
            attitude_hint("Owen", &a),
            "你對 Owen 的態度:親近(朋友),你都叫對方「歐文」"
        );
        a.affinity = -50.0;
        a.label = String::new();
        a.call_name = None;
        assert_eq!(attitude_hint("Owen", &a), "你對 Owen 的態度:冷淡");
        a.affinity = 0.0;
        assert_eq!(tone(a.affinity), "普通");
    }

    #[test]
    fn parses_budget_states() {
        assert_eq!("OK".parse::<BudgetState>().unwrap(), BudgetState::Ok);
        assert_eq!(
            "degraded".parse::<BudgetState>().unwrap(),
            BudgetState::Degraded
        );
        assert_eq!(
            "exhausted".parse::<BudgetState>().unwrap(),
            BudgetState::Exhausted
        );
        assert!("broke".parse::<BudgetState>().is_err());
        assert_eq!(BudgetState::Degraded.to_string(), "degraded");
    }
}
