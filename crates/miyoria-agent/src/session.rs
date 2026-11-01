use std::collections::{HashMap, VecDeque};

use chrono::{DateTime, Utc};
use miyoria_types::{AccountRef, ActionId, ContextKey, IncomingMessage};

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryEntry {
    pub author: String,
    pub account: AccountRef,
    pub text: String,
    pub ts: DateTime<Utc>,
    pub is_self: bool,
    /// Her message was submitted as this action and not yet seen echoed back.
    pub pending: Option<ActionId>,
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
}

impl Session {
    pub fn new(context: ContextKey, limit: usize) -> Self {
        Self {
            context,
            limit: limit.max(1),
            history: VecDeque::new(),
            participants: HashMap::new(),
            last_self_at: None,
        }
    }

    /// Records a platform message. Her own messages that echo a submitted
    /// reply confirm the existing entry instead of adding a duplicate.
    pub fn record_message(&mut self, msg: &IncomingMessage, is_self: bool) {
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
        });
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
