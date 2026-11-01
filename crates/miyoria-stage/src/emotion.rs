//! Emotion → VTube Studio expression / hotkey, with a hold time and a return
//! to neutral.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use crate::avatar::{AvatarAction, AvatarProfile};

/// A request the emotion controller wants sent to VTube Studio.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VtsCommand {
    Expression { file: String, active: bool },
    Hotkey(String),
}

struct Current {
    name: String,
    action: AvatarAction,
    until: Instant,
}

/// Keeps one main expression at a time.
///
/// `neutral` is the resting state: an expression there is active while
/// resting, a hotkey there is fired to return to rest (e.g. a VTS "Remove all
/// expressions" hotkey). Unmapped emotions count as neutral. An emotion is
/// held for `hold`, never ends while she speaks, and lasts at least
/// `after_speech` after she stops.
pub struct EmotionController {
    emotions: BTreeMap<String, AvatarAction>,
    neutral: Option<AvatarAction>,
    hold: Duration,
    after_speech: Duration,
    current: Option<Current>,
    speaking: bool,
}

impl EmotionController {
    pub fn new(profile: &AvatarProfile, hold: Duration, after_speech: Duration) -> Self {
        let mut emotions = profile.emotions.clone();
        let neutral = emotions.remove("neutral");
        Self {
            emotions,
            neutral,
            hold,
            after_speech,
            current: None,
            speaking: false,
        }
    }

    /// The emotion being shown (`None` = neutral).
    pub fn current(&self) -> Option<&str> {
        self.current.as_ref().map(|c| c.name.as_str())
    }

    /// When the current emotion ends (if she is not speaking then).
    pub fn deadline(&self) -> Option<Instant> {
        self.current.as_ref().map(|c| c.until)
    }

    /// Commands that put the model into the resting state (after connecting).
    pub fn rest(&mut self) -> Vec<VtsCommand> {
        let mut out = Vec::new();
        if let Some(current) = self.current.take() {
            leave(&current.action, &mut out);
        }
        enter_rest(self.neutral.as_ref(), &mut out);
        out
    }

    pub fn on_emotion(&mut self, name: &str, now: Instant) -> Vec<VtsCommand> {
        let name = name.trim().to_lowercase();
        let Some(action) = self.emotions.get(&name).cloned() else {
            // `neutral` or unmapped.
            return self.return_to_rest();
        };
        let until = now + self.hold;
        if let Some(current) = &mut self.current {
            if current.name == name {
                current.until = current.until.max(until);
                return Vec::new();
            }
        }
        let mut out = Vec::new();
        match self.current.take() {
            Some(previous) => {
                leave(&previous.action, &mut out);
                // A hotkey effect is cleared through neutral's hotkey.
                if matches!(previous.action, AvatarAction::Hotkey(_)) {
                    if let Some(AvatarAction::Hotkey(h)) = &self.neutral {
                        out.push(VtsCommand::Hotkey(h.clone()));
                    }
                }
            }
            None => {
                if let Some(AvatarAction::Expression(file)) = &self.neutral {
                    out.push(VtsCommand::Expression {
                        file: file.clone(),
                        active: false,
                    });
                }
            }
        }
        enter(&action, &mut out);
        self.current = Some(Current {
            name,
            action,
            until,
        });
        out
    }

    pub fn set_speaking(&mut self, speaking: bool, now: Instant) {
        if self.speaking && !speaking {
            if let Some(current) = &mut self.current {
                current.until = current.until.max(now + self.after_speech);
            }
        }
        self.speaking = speaking;
    }

    /// Returns to neutral once the hold time is over.
    pub fn tick(&mut self, now: Instant) -> Vec<VtsCommand> {
        match &self.current {
            Some(c) if !self.speaking && now >= c.until => self.return_to_rest(),
            _ => Vec::new(),
        }
    }

    fn return_to_rest(&mut self) -> Vec<VtsCommand> {
        let Some(current) = self.current.take() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        leave(&current.action, &mut out);
        enter_rest(self.neutral.as_ref(), &mut out);
        out
    }
}

fn enter(action: &AvatarAction, out: &mut Vec<VtsCommand>) {
    out.push(match action {
        AvatarAction::Expression(file) => VtsCommand::Expression {
            file: file.clone(),
            active: true,
        },
        AvatarAction::Hotkey(h) => VtsCommand::Hotkey(h.clone()),
    });
}

fn leave(action: &AvatarAction, out: &mut Vec<VtsCommand>) {
    if let AvatarAction::Expression(file) = action {
        out.push(VtsCommand::Expression {
            file: file.clone(),
            active: false,
        });
    }
}

fn enter_rest(neutral: Option<&AvatarAction>, out: &mut Vec<VtsCommand>) {
    if let Some(neutral) = neutral {
        enter(neutral, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(entries: &[(&str, &str)]) -> AvatarProfile {
        let mut p = AvatarProfile::default();
        for (k, v) in entries {
            if let Some(a) = AvatarAction::parse(v) {
                p.emotions.insert((*k).to_owned(), a);
            }
        }
        p
    }

    fn expr(file: &str, active: bool) -> VtsCommand {
        VtsCommand::Expression {
            file: file.into(),
            active,
        }
    }

    const HOLD: Duration = Duration::from_secs(4);
    const AFTER: Duration = Duration::from_secs(1);

    #[test]
    fn expression_is_held_then_reverts() {
        let p = profile(&[("happy", "happy.exp3.json"), ("sad", "sad.exp3.json")]);
        let mut c = EmotionController::new(&p, HOLD, AFTER);
        let t0 = Instant::now();
        assert!(c.rest().is_empty());
        assert_eq!(c.on_emotion("Happy", t0), [expr("happy.exp3.json", true)]);
        assert_eq!(c.current(), Some("happy"));
        // Repeating extends the hold without new requests.
        assert!(
            c.on_emotion("happy", t0 + Duration::from_secs(2))
                .is_empty()
        );
        assert!(c.tick(t0 + HOLD).is_empty());
        assert_eq!(
            c.tick(t0 + Duration::from_secs(6)),
            [expr("happy.exp3.json", false)]
        );
        assert_eq!(c.current(), None);
        // One main expression: switching deactivates the old one first.
        c.on_emotion("happy", t0);
        assert_eq!(
            c.on_emotion("sad", t0),
            [expr("happy.exp3.json", false), expr("sad.exp3.json", true)]
        );
        // Neutral and unmapped emotions return to rest at once.
        assert_eq!(c.on_emotion("neutral", t0), [expr("sad.exp3.json", false)]);
        c.on_emotion("sad", t0);
        assert_eq!(c.on_emotion("thinking", t0), [expr("sad.exp3.json", false)]);
        assert!(c.on_emotion("thinking", t0).is_empty());
    }

    #[test]
    fn speaking_keeps_the_expression() {
        let p = profile(&[("happy", "happy.exp3.json")]);
        let mut c = EmotionController::new(&p, HOLD, AFTER);
        let t0 = Instant::now();
        c.on_emotion("happy", t0);
        c.set_speaking(true, t0);
        assert!(c.tick(t0 + Duration::from_secs(10)).is_empty());
        c.set_speaking(false, t0 + Duration::from_secs(10));
        assert!(c.tick(t0 + Duration::from_millis(10_500)).is_empty());
        assert_eq!(
            c.tick(t0 + Duration::from_secs(11)),
            [expr("happy.exp3.json", false)]
        );
    }

    #[test]
    fn hotkeys_and_neutral_rest() {
        let p = profile(&[
            ("neutral", "Clear"),
            ("smug", "Smug"),
            ("happy", "happy.exp3.json"),
        ]);
        let mut c = EmotionController::new(&p, HOLD, AFTER);
        let t0 = Instant::now();
        assert_eq!(c.rest(), [VtsCommand::Hotkey("Clear".into())]);
        assert_eq!(
            c.on_emotion("smug", t0),
            [VtsCommand::Hotkey("Smug".into())]
        );
        assert_eq!(
            c.on_emotion("happy", t0),
            [
                VtsCommand::Hotkey("Clear".into()),
                expr("happy.exp3.json", true)
            ]
        );
        assert_eq!(
            c.tick(t0 + HOLD),
            [
                expr("happy.exp3.json", false),
                VtsCommand::Hotkey("Clear".into())
            ]
        );

        // A neutral expression is active while resting.
        let p = profile(&[("neutral", "calm.exp3.json"), ("happy", "happy.exp3.json")]);
        let mut c = EmotionController::new(&p, HOLD, AFTER);
        assert_eq!(c.rest(), [expr("calm.exp3.json", true)]);
        assert_eq!(
            c.on_emotion("happy", t0),
            [expr("calm.exp3.json", false), expr("happy.exp3.json", true)]
        );
        assert_eq!(
            c.on_emotion("neutral", t0),
            [expr("happy.exp3.json", false), expr("calm.exp3.json", true)]
        );
    }
}
