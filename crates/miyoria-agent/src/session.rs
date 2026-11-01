use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use chrono::{DateTime, Utc};
use miyoria_types::{AccountRef, ActionId, ContextKey, IncomingMessage, TurnId, VoiceParticipant};
use tokio::time::Instant;

/// A speaking signal older than this is treated as lost.
const SPEAKING_STALE: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryEntry {
    pub author: String,
    pub account: AccountRef,
    pub text: String,
    pub ts: DateTime<Utc>,
    pub is_self: bool,
    /// Her message was submitted as this action and not yet seen echoed back.
    pub pending: Option<ActionId>,
    /// Said out loud in a voice channel (a transcript, or her speech).
    pub spoken: bool,
    /// Her speech was cut off before she finished.
    pub interrupted: bool,
    /// The turn her speech belongs to.
    pub turn: Option<TurnId>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Participant {
    pub display_name: String,
    pub last_seen: DateTime<Utc>,
}

/// Short-term working memory of one conversation context.
#[derive(Debug)]
pub struct Session {
    pub context: ContextKey,
    limit: usize,
    history: VecDeque<HistoryEntry>,
    participants: HashMap<AccountRef, Participant>,
    last_self_at: Option<DateTime<Utc>>,
    /// Who is in the voice channel (voice contexts only).
    voice_members: Vec<VoiceParticipant>,
    /// People currently speaking, with when they started.
    speaking: HashMap<AccountRef, Instant>,
}

impl Session {
    pub fn new(context: ContextKey, limit: usize) -> Self {
        Self {
            context,
            limit: limit.max(1),
            history: VecDeque::new(),
            participants: HashMap::new(),
            last_self_at: None,
            voice_members: Vec::new(),
            speaking: HashMap::new(),
        }
    }

    /// Records a platform message. Her own messages that echo a submitted
    /// reply confirm the existing entry instead of adding a duplicate.
    pub fn record_message(&mut self, msg: &IncomingMessage, is_self: bool) {
        self.record(msg, is_self, false);
    }

    /// Records a transcribed voice utterance of someone else.
    pub fn record_utterance(&mut self, msg: &IncomingMessage) {
        self.record(msg, false, true);
    }

    fn record(&mut self, msg: &IncomingMessage, is_self: bool, spoken: bool) {
        let text = message_text(msg);
        if is_self {
            self.last_self_at = Some(self.last_self_at.map_or(msg.ts, |t| t.max(msg.ts)));
            if let Some(entry) = self
                .history
                .iter_mut()
                .find(|e| e.pending.is_some() && e.text.trim() == text.trim())
            {
                entry.pending = None;
                entry.account = msg.author.account.clone();
                return;
            }
        } else {
            self.participants.insert(
                msg.author.account.clone(),
                Participant {
                    display_name: msg.author.display_name.clone(),
                    last_seen: msg.ts,
                },
            );
        }
        self.push(HistoryEntry {
            author: msg.author.display_name.clone(),
            account: msg.author.account.clone(),
            text,
            ts: msg.ts,
            is_self,
            pending: None,
            spoken,
            interrupted: false,
            turn: None,
        });
    }

    /// Records a reply she just submitted.
    pub fn record_own(
        &mut self,
        author: &str,
        account: AccountRef,
        text: &str,
        action: ActionId,
        ts: DateTime<Utc>,
    ) {
        self.last_self_at = Some(ts);
        self.push(HistoryEntry {
            author: author.to_owned(),
            account,
            text: text.to_owned(),
            ts,
            is_self: true,
            pending: Some(action),
            spoken: false,
            interrupted: false,
            turn: None,
        });
    }

    /// Records a sentence of hers that started playing. Sentences of the same
    /// turn are joined into one entry.
    pub fn record_speech(
        &mut self,
        author: &str,
        account: AccountRef,
        text: &str,
        turn: Option<TurnId>,
        ts: DateTime<Utc>,
    ) {
        self.note_self_spoke(ts);
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        if let Some(last) = self.history.back_mut() {
            if last.is_self
                && last.spoken
                && !last.interrupted
                && turn.is_some()
                && last.turn == turn
            {
                last.text.push_str(text);
                return;
            }
        }
        self.push(HistoryEntry {
            author: author.to_owned(),
            account,
            text: text.to_owned(),
            ts,
            is_self: true,
            pending: None,
            spoken: true,
            interrupted: false,
            turn,
        });
    }

    /// Marks her speech of `turn` as cut off. Without a matching entry (the
    /// start was missed) `text` is recorded as interrupted speech.
    pub fn record_interruption(
        &mut self,
        author: &str,
        account: AccountRef,
        text: &str,
        turn: Option<TurnId>,
        ts: DateTime<Utc>,
    ) {
        let found = self
            .history
            .iter_mut()
            .rev()
            .find(|e| e.is_self && e.spoken && turn.is_some() && e.turn == turn);
        match found {
            Some(entry) => entry.interrupted = true,
            None => {
                self.record_speech(author, account, text, turn, ts);
                if let Some(last) = self.history.back_mut().filter(|e| e.is_self) {
                    last.interrupted = true;
                }
            }
        }
        self.note_self_spoke(ts);
    }

    /// She was talking at `ts` (start or end of her speech).
    pub fn note_self_spoke(&mut self, ts: DateTime<Utc>) {
        self.last_self_at = Some(self.last_self_at.map_or(ts, |t| t.max(ts)));
    }

    /// Removes a submitted reply that was never delivered.
    pub fn forget_action(&mut self, action: ActionId) {
        self.history.retain(|e| e.pending != Some(action));
        self.last_self_at = self.history.iter().rev().find(|e| e.is_self).map(|e| e.ts);
    }

    fn push(&mut self, entry: HistoryEntry) {
        self.history.push_back(entry);
        while self.history.len() > self.limit {
            self.history.pop_front();
        }
    }

    pub fn history(&self) -> &VecDeque<HistoryEntry> {
        &self.history
    }

    /// The last `n` entries, oldest first.
    pub fn recent(&self, n: usize) -> impl Iterator<Item = &HistoryEntry> {
        self.history
            .iter()
            .skip(self.history.len().saturating_sub(n))
    }

    pub fn last_self_at(&self) -> Option<DateTime<Utc>> {
        self.last_self_at
    }

    /// Her share of the last `window` messages. Short histories count as if
    /// padded to `window`, so one early reply does not trip the limit.
    pub fn self_share(&self, window: usize) -> f32 {
        let window = window.max(1);
        let own = self.recent(window).filter(|e| e.is_self).count();
        own as f32 / window as f32
    }

    /// Other people seen in this context, most recently active first.
    pub fn participants(&self) -> Vec<&Participant> {
        let mut out: Vec<_> = self.participants.values().collect();
        out.sort_by_key(|p| std::cmp::Reverse(p.last_seen));
        out
    }

    /// Replaces the voice channel roster; people who left stop speaking.
    pub fn set_voice_members(&mut self, members: Vec<VoiceParticipant>) {
        self.speaking
            .retain(|account, _| members.iter().any(|m| &m.account == account));
        self.voice_members = members;
    }

    pub fn voice_members(&self) -> &[VoiceParticipant] {
        &self.voice_members
    }

    pub fn set_speaking(&mut self, account: &AccountRef, speaking: bool) {
        if speaking {
            self.speaking
                .entry(account.clone())
                .or_insert_with(Instant::now);
        } else {
            self.speaking.remove(account);
        }
    }

    /// Someone else is speaking right now (signals older than 30 s are
    /// considered lost).
    pub fn someone_speaking(&self) -> bool {
        let now = Instant::now();
        self.speaking
            .values()
            .any(|since| now.saturating_duration_since(*since) < SPEAKING_STALE)
    }
}

/// Message text as shown in history; attachments are noted inline.
pub fn message_text(msg: &IncomingMessage) -> String {
    let mut text = msg.text.trim().to_owned();
    for a in &msg.attachments {
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&format!("[附件: {}]", a.filename));
    }
    text
}

#[cfg(test)]
mod tests {
    use miyoria_types::{Author, ContextKind, MessageRef, PlatformId};

    use super::*;

    fn ctx() -> ContextKey {
        ContextKey {
            platform: PlatformId::new("t"),
            scope: Some("g".into()),
            channel: "c".into(),
            kind: ContextKind::Channel,
        }
    }

    fn msg(account: &str, text: &str) -> IncomingMessage {
        IncomingMessage {
            id: MessageRef {
                context: ctx(),
                id: "1".into(),
            },
            author: Author {
                account: AccountRef {
                    platform: PlatformId::new("t"),
                    id: account.into(),
                },
                display_name: account.to_uppercase(),
                is_bot: false,
            },
            text: text.into(),
            mentions_self: false,
            reply_to_self: false,
            attachments: Vec::new(),
            ts: Utc::now(),
        }
    }

    #[test]
    fn bounded_history_and_echo_dedup() {
        let mut s = Session::new(ctx(), 3);
        s.record_message(&msg("a", "1"), false);
        let action = ActionId::new();
        let me = AccountRef {
            platform: PlatformId::new("t"),
            id: "her".into(),
        };
        s.record_own("Her", me, "hi there", action, Utc::now());
        s.record_message(&msg("her", " hi there "), true);
        assert_eq!(s.history().len(), 2);
        assert_eq!(s.history()[1].pending, None);
        s.record_message(&msg("b", "2"), false);
        s.record_message(&msg("c", "3"), false);
        assert_eq!(s.history().len(), 3);
        assert_eq!(s.history()[0].text, "hi there");
        assert_eq!(s.participants().len(), 3);
    }

    #[test]
    fn forgets_undelivered_replies() {
        let mut s = Session::new(ctx(), 10);
        let me = AccountRef {
            platform: PlatformId::new("t"),
            id: "her".into(),
        };
        let action = ActionId::new();
        s.record_own("Her", me, "x", action, Utc::now());
        assert!(s.last_self_at().is_some());
        s.forget_action(action);
        assert!(s.history().is_empty());
        assert!(s.last_self_at().is_none());
    }

    #[test]
    fn speech_of_a_turn_is_joined_and_can_be_interrupted() {
        let mut s = Session::new(ctx(), 10);
        let me = AccountRef {
            platform: PlatformId::new("t"),
            id: "her".into(),
        };
        let (t1, t2) = (TurnId::new(), TurnId::new());
        s.record_speech("Her", me.clone(), "哼。", Some(t1), Utc::now());
        s.record_speech("Her", me.clone(), "才不是。", Some(t1), Utc::now());
        assert_eq!(s.history().len(), 1);
        assert_eq!(s.history()[0].text, "哼。才不是。");
        assert!(s.history()[0].spoken && s.last_self_at().is_some());

        s.record_interruption("Her", me.clone(), "才不是。", Some(t1), Utc::now());
        assert!(s.history()[0].interrupted);
        // Nothing more is appended to an interrupted entry.
        s.record_speech("Her", me.clone(), "其實", Some(t1), Utc::now());
        assert_eq!(s.history().len(), 2);

        // An interruption whose start was missed is still recorded.
        s.record_interruption("Her", me, "等等", Some(t2), Utc::now());
        let last = s.history().back().unwrap();
        assert_eq!(last.text, "等等");
        assert!(last.interrupted && last.turn == Some(t2));
    }

    #[test]
    fn voice_members_and_speaking() {
        let mut s = Session::new(ctx(), 10);
        let owen = AccountRef {
            platform: PlatformId::new("t"),
            id: "owen".into(),
        };
        assert!(!s.someone_speaking());
        s.set_speaking(&owen, true);
        assert!(s.someone_speaking());
        s.set_voice_members(Vec::new());
        assert!(!s.someone_speaking(), "people who left stop speaking");
        s.set_voice_members(vec![VoiceParticipant {
            account: owen.clone(),
            display_name: "Owen".into(),
            is_self: false,
            muted: false,
            deafened: false,
        }]);
        s.set_speaking(&owen, true);
        s.set_speaking(&owen, false);
        assert!(!s.someone_speaking());
        assert_eq!(s.voice_members()[0].display_name, "Owen");
    }

    #[test]
    fn self_share_pads_short_histories() {
        let mut s = Session::new(ctx(), 50);
        s.record_message(&msg("her", "a"), true);
        s.record_message(&msg("x", "b"), false);
        assert!((s.self_share(20) - 0.05).abs() < 1e-6);
        for _ in 0..20 {
            s.record_message(&msg("her", "spam"), true);
        }
        assert!((s.self_share(20) - 1.0).abs() < 1e-6);
    }
}
