use chrono::{DateTime, Utc};
use miyoria_types::{AccountRef, ContextKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Short numeric id, convenient to type in commands (`queue skip 3`).
pub type ItemId = u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    Pending,
    Active,
    Done,
    Skipped,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueueItem {
    pub id: ItemId,
    pub requester: AccountRef,
    pub requester_name: String,
    /// Free-form, e.g. `game_goal`, `song`, `chat`.
    pub kind: String,
    pub text: String,
    /// Where the request was made, for replying later.
    pub context: Option<ContextKey>,
    pub created_at: DateTime<Utc>,
    /// Moderator-set; higher goes first, ahead of fairness.
    pub priority: i32,
    /// Manual position set by `move_item`; orders items of equal priority.
    #[serde(default)]
    pub slot: Option<u32>,
    /// Upvote count (`voters.len()`).
    #[serde(default)]
    pub votes: u32,
    #[serde(default)]
    pub voters: Vec<AccountRef>,
    pub state: ItemState,
}

/// Input of [`RequestQueue::submit`](crate::RequestQueue::submit).
#[derive(Clone, Debug)]
pub struct SubmitRequest {
    pub requester: AccountRef,
    pub requester_name: String,
    pub kind: String,
    pub text: String,
    pub context: Option<ContextKey>,
    pub priority: i32,
}

impl SubmitRequest {
    pub fn new(
        requester: AccountRef,
        requester_name: impl Into<String>,
        kind: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            requester,
            requester_name: requester_name.into(),
            kind: kind.into(),
            text: text.into(),
            context: None,
            priority: 0,
        }
    }

    pub fn context(mut self, context: ContextKey) -> Self {
        self.context = Some(context);
        self
    }

    pub fn priority(mut self, priority: i32) -> Self {
        self.priority = priority;
        self
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ballot {
    pub account: AccountRef,
    pub option: usize,
    /// When the ballot was cast or last changed.
    pub at: DateTime<Utc>,
}

/// A running vote.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoteState {
    pub options: Vec<String>,
    pub started_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    /// One per account (latest wins).
    pub ballots: Vec<Ballot>,
}

impl VoteState {
    pub fn tallies(&self) -> Vec<u32> {
        let mut t = vec![0; self.options.len()];
        for b in &self.ballots {
            if let Some(n) = t.get_mut(b.option) {
                *n += 1;
            }
        }
        t
    }

    /// Option with the most ballots. Ties go to the option that reached its
    /// tally first (smallest time of its latest ballot). `None` without ballots.
    pub fn winner(&self) -> Option<usize> {
        let tallies = self.tallies();
        (0..self.options.len())
            .filter(|&i| tallies[i] > 0)
            .min_by_key(|&i| {
                let reached = self
                    .ballots
                    .iter()
                    .filter(|b| b.option == i)
                    .map(|b| b.at)
                    .max();
                (std::cmp::Reverse(tallies[i]), reached)
            })
    }
}

/// Outcome of a finished vote.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoteResult {
    pub options: Vec<String>,
    pub tallies: Vec<u32>,
    pub winner: Option<usize>,
    pub total: u32,
    pub ended_at: DateTime<Utc>,
}

impl VoteResult {
    pub fn winner_option(&self) -> Option<&str> {
        self.winner
            .and_then(|i| self.options.get(i))
            .map(String::as_str)
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum QueueError {
    #[error("the requester is blocked")]
    Blocked,
    #[error("request text is empty")]
    EmptyText,
    #[error("request text is longer than {0} characters")]
    TextTooLong(usize),
    #[error("already {0} pending requests from this account")]
    UserLimit(usize),
    #[error("the queue is full ({0} pending)")]
    QueueFull(usize),
    #[error("no item #{0}")]
    NotFound(ItemId),
    #[error("item #{0} is not in a state that allows this")]
    WrongState(ItemId),
    #[error("a vote is already running")]
    VoteRunning,
    #[error("no vote is running")]
    NoVote,
    #[error("invalid vote: {0}")]
    BadVote(String),
    #[error("unknown vote option `{0}`")]
    UnknownOption(String),
}
