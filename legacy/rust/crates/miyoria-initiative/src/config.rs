//! Configuration of module `initiative` (`[modules.initiative]`).

use miyoria_types::ContextKey;
use serde::{Deserialize, Serialize};

/// All fields have defaults; durations are in seconds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InitiativeConfig {
    // --- triggers ---
    /// Nudge a channel that went quiet after a lively conversation.
    pub idle_channel: bool,
    /// Bring up due followups when the person is around.
    pub followup: bool,
    /// Greet friends on their first message of the day.
    pub greeting: bool,
    /// Greet people with good affinity who join her voice channel.
    pub voice_join: bool,

    // --- idle_channel ---
    /// Quiet time after which a lively conversation counts as gone cold.
    pub idle_after_secs: u64,
    /// Beyond this quiet time the conversation is considered over.
    pub idle_max_secs: u64,
    /// Messages (hers included) a conversation needs to count as lively.
    pub lively_min_messages: u32,

    // --- budget ---
    /// Initiatives per context per day.
    pub max_per_context_per_day: u32,
    /// Initiatives per day over all contexts.
    pub max_per_day: u32,
    /// Window used to detect an active conversation.
    pub busy_window_secs: u64,
    /// Messages inside the window that make a conversation active (a lone
    /// message does not). Anything she said inside the window also counts.
    pub busy_min_messages: u32,

    // --- adaptive backoff ---
    /// How long to wait for a human reply to her initiative.
    pub reply_window_secs: u64,
    /// The idle threshold doubles per unanswered initiative, at most this often.
    pub max_backoff_doublings: u32,
    /// One doubling is forgotten per this many days.
    pub backoff_decay_days: u32,

    // --- time ---
    /// Local time zone as an offset from UTC.
    pub timezone_offset_hours: f32,
    /// Local hour at which the "day" rolls over for counters and greetings.
    pub day_start_hour: u32,
    /// Local hour quiet hours start (inclusive).
    pub quiet_start_hour: u32,
    /// Local hour quiet hours end (exclusive). Equal to start: no quiet hours.
    /// Quiet hours stop idle nudges; reactions to a person who is present
    /// (greeting, voice join, followup) are not affected.
    pub quiet_end_hour: u32,

    // --- people ---
    /// Attitude labels that count as "friend or closer".
    pub friend_labels: Vec<String>,
    /// Affinity at which someone joining voice gets greeted (labels in
    /// `friend_labels` qualify too).
    pub voice_join_min_affinity: f32,
    /// Minimum time between voice greetings of the same person.
    pub voice_join_cooldown_secs: u64,
    /// A person counts as around if they were active this recently.
    pub followup_active_secs: u64,

    // --- misc ---
    /// How often idle checks and the followup poll run.
    pub tick_secs: u64,
    /// Strength of mood-energy scaling of the idle threshold: energy 1 gives
    /// `2^-influence`, energy 0 gives `2^influence`. 0 disables it.
    pub mood_influence: f32,
    /// Contexts that never get initiative. Entries match the context's
    /// display form (`discord:<guild>:<channel>`, `discord:dm:<channel>`,
    /// voice contexts have `voice:` before the channel) or its bare channel id.
    pub disabled_contexts: Vec<String>,
}

impl Default for InitiativeConfig {
    fn default() -> Self {
        Self {
            idle_channel: true,
            followup: true,
            greeting: true,
            voice_join: true,
            idle_after_secs: 20 * 60,
            idle_max_secs: 3 * 60 * 60,
            lively_min_messages: 6,
            max_per_context_per_day: 4,
            max_per_day: 12,
            busy_window_secs: 120,
            busy_min_messages: 2,
            reply_window_secs: 10 * 60,
            max_backoff_doublings: 3,
            backoff_decay_days: 1,
            timezone_offset_hours: 8.0,
            day_start_hour: 4,
            quiet_start_hour: 1,
            quiet_end_hour: 7,
            friend_labels: ["朋友", "好朋友", "好友", "摯友", "親友", "戀人", "家人"]
                .map(String::from)
                .to_vec(),
            voice_join_min_affinity: 30.0,
            voice_join_cooldown_secs: 30 * 60,
            followup_active_secs: 10 * 60,
            tick_secs: 60,
            mood_influence: 1.0,
            disabled_contexts: Vec::new(),
        }
    }
}

impl InitiativeConfig {
    /// Whether `context` is on the opt-out list.
    pub fn is_disabled(&self, context: &ContextKey) -> bool {
        if self.disabled_contexts.is_empty() {
            return false;
        }
        let display = context.to_string();
        self.disabled_contexts
            .iter()
            .any(|d| *d == display || *d == context.channel)
    }
}
