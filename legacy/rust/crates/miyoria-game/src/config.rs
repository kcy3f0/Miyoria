//! `[modules.game]` configuration.

use miyoria_types::ContextKey;
use serde::Deserialize;

/// Permission nodes of the `game` commands.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct GamePermissions {
    pub start: String,
    pub stop: String,
    pub goal: String,
    pub status: String,
}

impl Default for GamePermissions {
    fn default() -> Self {
        Self {
            start: "game.start".to_owned(),
            stop: "game.stop".to_owned(),
            goal: "game.goal".to_owned(),
            status: "game.status".to_owned(),
        }
    }
}

/// All fields have defaults; durations are in seconds.
///
/// ```toml
/// [modules.game]
/// decide_secs = 20
/// stream_context = { platform = "discord", scope = "123", channel = "456", kind = "voice" }
/// ```
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct GameConfig {
    /// Game id used when `game start` names none.
    pub default_game: String,
    /// Regular decision interval while playing.
    pub decide_secs: u64,
    /// Event-triggered decisions happen at most this often.
    pub min_decide_secs: u64,
    /// A goal is kept at least this long unless it finished, failed, the bot
    /// went idle or something important happened.
    pub min_goal_secs: u64,
    /// A goal still running after this long is given up.
    pub max_goal_secs: u64,
    /// Goal reached / failed events this soon after an action belong to the
    /// previous goal and are ignored.
    pub settle_secs: u64,
    /// Act failures before a goal counts as failed.
    pub max_attempts: u32,
    /// Minimum time between regular commentary requests.
    pub commentary_min_secs: u64,
    /// Minimum time between urgent ones (death, viewer goals, ...).
    pub urgent_commentary_min_secs: u64,
    /// LLM purpose of the decisions.
    pub purpose: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub llm_timeout_secs: u64,
    pub tool_timeout_secs: u64,
    /// How much of the persona prompt goes into the decision prompt.
    pub persona_chars: usize,
    /// Recent game events remembered for prompts.
    pub recent_events: usize,
    /// Characters of the observation summary in the chat prompt section.
    pub prompt_summary_chars: usize,
    /// Where commentary goes when `game start` is not run from a voice
    /// channel she is in (e.g. the stream's voice channel).
    pub stream_context: Option<ContextKey>,
    /// Request queue item kind consumed as goals.
    pub queue_kind: String,
    /// Actions that never replace the current goal.
    pub instant_actions: Vec<String>,
    /// Game event types that trigger an early decision.
    pub trigger_events: Vec<String>,
    /// Event types meaning the current goal was reached.
    pub reached_events: Vec<String>,
    /// Event types meaning the current goal failed.
    pub failed_events: Vec<String>,
    /// Largest mood change the model may ask for per decision.
    pub max_llm_nudge: f32,
    pub permissions: GamePermissions,
}

impl Default for GameConfig {
    fn default() -> Self {
        let list = |items: &[&str]| items.iter().map(|s| (*s).to_owned()).collect();
        Self {
            default_game: "minecraft".to_owned(),
            decide_secs: 20,
            min_decide_secs: 4,
            min_goal_secs: 45,
            max_goal_secs: 600,
            settle_secs: 3,
            max_attempts: 3,
            commentary_min_secs: 15,
            urgent_commentary_min_secs: 3,
            purpose: "game".to_owned(),
            temperature: 0.7,
            max_tokens: 400,
            llm_timeout_secs: 30,
            tool_timeout_secs: 20,
            persona_chars: 600,
            recent_events: 12,
            prompt_summary_chars: 500,
            stream_context: None,
            queue_kind: "game_goal".to_owned(),
            instant_actions: list(&["chat", "look", "attack", "use", "select", "respawn"]),
            trigger_events: list(&[
                "death",
                "low_health",
                "hostile_near",
                "goal_reached",
                "goal_failed",
                "baritone_idle",
                "advancement",
                "chat",
                "connected",
            ]),
            reached_events: list(&["goal_reached", "baritone_idle"]),
            failed_events: list(&["goal_failed"]),
            max_llm_nudge: 0.1,
            permissions: GamePermissions::default(),
        }
    }
}
