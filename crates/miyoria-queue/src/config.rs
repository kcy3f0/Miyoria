use serde::Deserialize;

/// Permission nodes checked by the queue commands. Phase-1 permissions only
/// distinguish `owner.` / `admin.` prefixes, so deployments that do not want
/// every user to manage the queue should set e.g. `manage = "admin.queue.manage"`.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct QueuePermissions {
    pub request: String,
    pub manage: String,
    pub vote: String,
}

impl Default for QueuePermissions {
    fn default() -> Self {
        Self {
            request: "queue.request".to_owned(),
            manage: "queue.manage".to_owned(),
            vote: "queue.vote".to_owned(),
        }
    }
}

/// `[modules.queue]` config section.
///
/// ```toml
/// [modules.queue]
/// max_pending_per_user = 2
/// affinity_weight = 1.0
/// ```
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct QueueConfig {
    /// Pending requests one account may have at the same time.
    pub max_pending_per_user: usize,
    /// Pending requests in total.
    pub max_pending: usize,
    /// Longest accepted request text, in characters.
    pub max_text_chars: usize,
    /// Finished items kept for `history`.
    pub history_limit: usize,
    /// Weight points per 10 affinity points (affinity is -100..100).
    pub affinity_weight: f32,
    /// Weight points per upvote.
    pub vote_weight: f32,
    /// Most options in a vote.
    pub max_vote_options: usize,
    /// Longest vote, in seconds.
    pub max_vote_seconds: u64,
    /// Enqueue the winning option as an item (kind `vote`) when a vote ends.
    pub vote_enqueue_winner: bool,
    /// Priority of the enqueued winner.
    pub vote_winner_priority: i32,
    /// Snapshot delay after the last change, in milliseconds.
    pub persist_debounce_ms: u64,
    /// How often the run loop checks for expired votes, in milliseconds.
    pub tick_ms: u64,
    pub permissions: QueuePermissions,
}

impl Default for QueueConfig {
    fn default() -> Self {
        Self {
            max_pending_per_user: 2,
            max_pending: 100,
            max_text_chars: 200,
            history_limit: 50,
            affinity_weight: 1.0,
            vote_weight: 1.0,
            max_vote_options: 10,
            max_vote_seconds: 3600,
            vote_enqueue_winner: true,
            vote_winner_priority: 100,
            persist_debounce_ms: 500,
            tick_ms: 250,
            permissions: QueuePermissions::default(),
        }
    }
}
