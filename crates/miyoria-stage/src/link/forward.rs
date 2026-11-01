//! Turns bus events into Core → Stage messages.

use std::collections::VecDeque;

use miyoria_types::{ContextKind, Event, PlaybackState, TurnId};

use crate::protocol::{CoreMessage, SpeakingState};

/// Topic of the agent's emotion markers.
pub const EMOTION_TOPIC: &str = "agent.emotion";

/// Turns whose subtitles are tracked at once.
const MAX_TURNS: usize = 16;

struct TurnSubtitle {
    turn: TurnId,
    /// Text of the playbacks started so far.
    spoken: String,
    /// Playbacks started and not yet ended.
    active: u32,
    completed: bool,
    finalized: bool,
}

/// Subscribed topics → messages, with the subtitle bookkeeping.
///
/// Subtitles follow her speech: every started playback appends its text and
/// sends a non-final `subtitle`; once the turn completed and no playback of it
/// is running, the text is sent again with `final: true`. Turns outside voice
/// contexts produce one final subtitle when `text_turns` is set.
pub(crate) struct Forwarder {
    text_turns: bool,
    turns: VecDeque<TurnSubtitle>,
}

impl Forwarder {
    pub fn new(text_turns: bool) -> Self {
        Self {
            text_turns,
            turns: VecDeque::new(),
        }
    }

    fn entry(&mut self, turn: TurnId) -> &mut TurnSubtitle {
        if let Some(i) = self.turns.iter().position(|t| t.turn == turn) {
            return &mut self.turns[i];
        }
        if self.turns.len() >= MAX_TURNS {
            self.turns.pop_front();
        }
        self.turns.push_back(TurnSubtitle {
            turn,
            spoken: String::new(),
            active: 0,
            completed: false,
            finalized: false,
        });
        self.turns.back_mut().expect("just pushed")
    }

    pub fn on_event(&mut self, event: &Event) -> Vec<CoreMessage> {
        match event {
            Event::Custom { topic, payload } if topic == EMOTION_TOPIC => {
                let name = payload
                    .get("emotion")
                    .or_else(|| payload.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_lowercase())
                    .unwrap_or_default();
                if name.is_empty() {
                    return Vec::new();
                }
                let intensity = payload
                    .get("intensity")
                    .and_then(serde_json::Value::as_f64)
                    .map_or(1.0, |v| v.clamp(0.0, 1.0) as f32);
                vec![CoreMessage::Emotion { name, intensity }]
            }
            Event::VoicePlayback {
                turn, state, text, ..
            } => self.on_playback(*turn, *state, text),
            Event::AgentTurnCompleted {
                turn,
                context,
                text,
            } => {
                let voice = context.kind == ContextKind::Voice;
                let text_turns = self.text_turns;
                let e = self.entry(*turn);
                e.completed = true;
                if voice || !e.spoken.is_empty() {
                    if e.active == 0 && !e.spoken.is_empty() && !e.finalized {
                        e.finalized = true;
                        return vec![subtitle(*turn, &e.spoken, true)];
                    }
                } else if text_turns && !text.trim().is_empty() && !e.finalized {
                    e.finalized = true;
                    return vec![subtitle(*turn, text.trim(), true)];
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn on_playback(
        &mut self,
        turn: Option<TurnId>,
        state: PlaybackState,
        text: &str,
    ) -> Vec<CoreMessage> {
        let text = text.trim();
        match state {
            PlaybackState::Started => {
                let mut out = vec![CoreMessage::Speaking {
                    state: SpeakingState::Started,
                }];
                match turn {
                    Some(turn) => {
                        let e = self.entry(turn);
                        e.active += 1;
                        e.finalized = false;
                        append(&mut e.spoken, text);
                        if !e.spoken.is_empty() {
                            out.push(subtitle(turn, &e.spoken, false));
                        }
                    }
                    None if !text.is_empty() => out.push(CoreMessage::Subtitle {
                        turn: String::new(),
                        text: text.to_owned(),
                        is_final: false,
                    }),
                    None => {}
                }
                out
            }
            PlaybackState::Finished | PlaybackState::Interrupted | PlaybackState::Failed => {
                let mut out = vec![CoreMessage::Speaking {
                    state: SpeakingState::Stopped,
                }];
                match turn {
                    Some(turn) => {
                        let e = self.entry(turn);
                        // `Failed` without `Started` (TTS failed) has nothing running.
                        if state != PlaybackState::Failed || e.active > 0 {
                            e.active = e.active.saturating_sub(1);
                        }
                        if e.completed && e.active == 0 && !e.spoken.is_empty() && !e.finalized {
                            e.finalized = true;
                            out.push(subtitle(turn, &e.spoken, true));
                        }
                    }
                    None if !text.is_empty() && state != PlaybackState::Failed => {
                        out.push(CoreMessage::Subtitle {
                            turn: String::new(),
                            text: text.to_owned(),
                            is_final: true,
                        });
                    }
                    None => {}
                }
                out
            }
        }
    }
}

fn subtitle(turn: TurnId, text: &str, is_final: bool) -> CoreMessage {
    CoreMessage::Subtitle {
        turn: turn.to_string(),
        text: text.to_owned(),
        is_final,
    }
}

/// Appends a speech segment, with a space between two Latin words.
fn append(spoken: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    let needs_space = spoken
        .chars()
        .last()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == ',' || c == '.')
        && text
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric());
    if needs_space {
        spoken.push(' ');
    }
    spoken.push_str(text);
}

#[cfg(test)]
mod tests {
    use super::*;
    use miyoria_types::{ContextKey, PlatformId};
    use serde_json::json;

    fn ctx(kind: ContextKind) -> ContextKey {
        ContextKey {
            platform: PlatformId::new("discord"),
            scope: Some("g".into()),
            channel: "c".into(),
            kind,
        }
    }

    fn playback(turn: TurnId, state: PlaybackState, text: &str) -> Event {
        Event::VoicePlayback {
            context: ctx(ContextKind::Voice),
            turn: Some(turn),
            state,
            text: text.into(),
        }
    }

    fn subs(msgs: &[CoreMessage]) -> Vec<(String, bool)> {
        msgs.iter()
            .filter_map(|m| match m {
                CoreMessage::Subtitle { text, is_final, .. } => Some((text.clone(), *is_final)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn emotions() {
        let mut f = Forwarder::new(false);
        let out = f.on_event(&Event::Custom {
            topic: EMOTION_TOPIC.into(),
            payload: json!({"turn": "x", "emotion": " Happy "}),
        });
        assert_eq!(
            out,
            [CoreMessage::Emotion {
                name: "happy".into(),
                intensity: 1.0
            }]
        );
        let out = f.on_event(&Event::Custom {
            topic: EMOTION_TOPIC.into(),
            payload: json!({"emotion": "sad", "intensity": 0.4}),
        });
        assert_eq!(
            out,
            [CoreMessage::Emotion {
                name: "sad".into(),
                intensity: 0.4
            }]
        );
        assert!(
            f.on_event(&Event::Custom {
                topic: EMOTION_TOPIC.into(),
                payload: json!({}),
            })
            .is_empty()
        );
    }

    #[test]
    fn voice_turn_subtitles_follow_playback() {
        let mut f = Forwarder::new(false);
        let turn = TurnId::new();
        let out = f.on_event(&playback(turn, PlaybackState::Started, "哼,"));
        assert_eq!(
            out[0],
            CoreMessage::Speaking {
                state: SpeakingState::Started
            }
        );
        assert_eq!(subs(&out), [("哼,".to_owned(), false)]);
        let out = f.on_event(&playback(turn, PlaybackState::Finished, "哼,"));
        assert!(subs(&out).is_empty());
        let out = f.on_event(&playback(turn, PlaybackState::Started, "才不是在等你呢。"));
        assert_eq!(subs(&out), [("哼,才不是在等你呢。".to_owned(), false)]);
        // Completion while speaking: final comes when the playback ends.
        let out = f.on_event(&Event::AgentTurnCompleted {
            turn,
            context: ctx(ContextKind::Voice),
            text: "哼,才不是在等你呢。".into(),
        });
        assert!(out.is_empty());
        let out = f.on_event(&playback(turn, PlaybackState::Interrupted, ""));
        assert_eq!(
            out[0],
            CoreMessage::Speaking {
                state: SpeakingState::Stopped
            }
        );
        assert_eq!(subs(&out), [("哼,才不是在等你呢。".to_owned(), true)]);
    }

    #[test]
    fn completion_after_speech_finalizes_immediately() {
        let mut f = Forwarder::new(false);
        let turn = TurnId::new();
        f.on_event(&playback(turn, PlaybackState::Started, "Hello"));
        f.on_event(&playback(turn, PlaybackState::Finished, "Hello"));
        f.on_event(&playback(turn, PlaybackState::Started, "there."));
        f.on_event(&playback(turn, PlaybackState::Finished, "there."));
        let out = f.on_event(&Event::AgentTurnCompleted {
            turn,
            context: ctx(ContextKind::Voice),
            text: "Hello there.".into(),
        });
        assert_eq!(subs(&out), [("Hello there.".to_owned(), true)]);
    }

    #[test]
    fn text_turns_are_optional() {
        let turn = TurnId::new();
        let done = Event::AgentTurnCompleted {
            turn,
            context: ctx(ContextKind::Channel),
            text: "早安".into(),
        };
        assert!(Forwarder::new(false).on_event(&done).is_empty());
        assert_eq!(
            subs(&Forwarder::new(true).on_event(&done)),
            [("早安".to_owned(), true)]
        );
        // A failed TTS start does not count as a running playback.
        let mut f = Forwarder::new(false);
        f.on_event(&playback(turn, PlaybackState::Started, "a"));
        f.on_event(&playback(turn, PlaybackState::Failed, "b"));
        let out = f.on_event(&Event::AgentTurnCompleted {
            turn,
            context: ctx(ContextKind::Voice),
            text: "a b".into(),
        });
        assert_eq!(subs(&out), [("a".to_owned(), true)]);
    }
}
