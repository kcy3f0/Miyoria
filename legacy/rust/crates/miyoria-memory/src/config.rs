//! Configuration: `[modules.memory]` (module settings) and the top-level
//! `[memory.embedding]` section (passed in by the app, like `[llm]`).

use serde::{Deserialize, Serialize};

/// `[modules.memory]`.
///
/// ```toml
/// [modules.memory]
/// consolidate_idle_secs = 300
/// consolidate_every_messages = 40
/// recall_limit = 8
///
/// [modules.memory.weights]
/// vector = 0.35
/// text = 0.25
/// ```
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryConfig {
    /// Consolidate a context after it has been quiet this long.
    pub consolidate_idle_secs: u64,
    /// ... or as soon as this many new lines arrived since the last watermark.
    pub consolidate_every_messages: usize,
    /// How often the background task checks contexts.
    pub tick_secs: u64,
    /// At most this many log lines go into one consolidation.
    pub max_lines_per_batch: usize,
    /// Wait this long before retrying a context whose consolidation failed.
    pub retry_secs: u64,
    /// LLM purpose used for consolidation.
    pub purpose: String,
    /// How her own lines are labelled in the transcript given to the summarizer.
    pub self_label: String,
    /// Offset of local time used in transcripts (minutes east of UTC).
    pub utc_offset_minutes: i32,
    /// Memories recalled into the prompt per turn.
    pub recall_limit: usize,
    /// Candidates fetched from the store per kind of match before ranking.
    pub candidate_limit: usize,
    /// Records scoring below this are never recalled.
    pub min_score: f32,
    pub weights: Weights,
    /// Recency decay time constant (days): `exp(-age / tau)`.
    pub recency_tau_days: f32,
    /// Where episodes and facts learned in guild channels live.
    pub guild_scope: GuildScope,
    /// Lets facts marked `global` in a DM become person-wide. Off by default:
    /// nothing learned in a DM leaves that DM.
    pub allow_global_from_dm: bool,
    /// Extracted items below this importance are dropped as trivia.
    pub min_importance: f32,
    pub dedupe: DedupeConfig,
    pub forgetting: ForgettingConfig,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            consolidate_idle_secs: 300,
            consolidate_every_messages: 40,
            tick_secs: 15,
            max_lines_per_batch: 200,
            retry_secs: 120,
            purpose: "summarizer".to_owned(),
            self_label: "我".to_owned(),
            utc_offset_minutes: 8 * 60,
            recall_limit: 8,
            candidate_limit: 32,
            min_score: 0.05,
            weights: Weights::default(),
            recency_tau_days: 14.0,
            guild_scope: GuildScope::Guild,
            allow_global_from_dm: false,
            min_importance: 0.1,
            dedupe: DedupeConfig::default(),
            forgetting: ForgettingConfig::default(),
        }
    }
}

/// Hybrid retrieval weights.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Weights {
    pub vector: f32,
    pub text: f32,
    pub recency: f32,
    pub importance: f32,
    /// Bonus when the memory is about someone present.
    pub subject: f32,
}

impl Default for Weights {
    fn default() -> Self {
        Self {
            vector: 0.35,
            text: 0.25,
            recency: 0.15,
            importance: 0.15,
            subject: 0.10,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuildScope {
    /// Shared across the whole guild / server.
    Guild,
    /// Only in the channel where it was learned.
    Channel,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DedupeConfig {
    /// Cosine similarity at which a new memory supersedes an existing one.
    pub vector_similarity: f32,
    /// Character-bigram similarity of normalized text at which a new memory
    /// is the same as an existing one (reinforced in place).
    pub text_similarity: f32,
    /// Confidence added when a fact is learned again.
    pub reinforce: f32,
}

impl Default for DedupeConfig {
    fn default() -> Self {
        Self {
            vector_similarity: 0.9,
            text_similarity: 0.85,
            reinforce: 0.1,
        }
    }
}

/// Daily maintenance: pruning episodes and decaying unreinforced facts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ForgettingConfig {
    pub enabled: bool,
    pub interval_hours: u64,
    /// Episodes older than this ...
    pub episode_max_age_days: i64,
    /// ... with importance at most this ...
    pub episode_max_importance: f32,
    /// ... and not recalled for this long are deleted.
    pub episode_not_accessed_days: i64,
    /// Facts not reinforced for this long lose confidence ...
    pub decay_after_days: i64,
    /// ... multiplied by this per day ...
    pub decay_per_day: f32,
    /// ... and are deleted below this confidence.
    pub forget_below_confidence: f32,
}

impl Default for ForgettingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 24,
            episode_max_age_days: 30,
            episode_max_importance: 0.3,
            episode_not_accessed_days: 14,
            decay_after_days: 30,
            decay_per_day: 0.98,
            forget_below_confidence: 0.1,
        }
    }
}

/// Top-level `[memory.embedding]`. Embeddings are optional; without them
/// retrieval uses full text, recency and importance only.
///
/// ```toml
/// [memory.embedding]
/// provider = "openai-compatible"
/// base_url = "http://localhost:11434/v1"
/// model = "bge-m3"
/// ```
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EmbeddingConfig {
    /// `"none"` (default) or `"openai-compatible"`.
    pub provider: String,
    /// API root, e.g. `https://api.openai.com/v1`; `/embeddings` is appended.
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    /// Requested output size, for models that support it.
    pub dimensions: Option<u32>,
    pub timeout_secs: u64,
    /// Texts per request.
    pub batch_size: usize,
}

impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            provider: "none".to_owned(),
            base_url: String::new(),
            api_key: None,
            model: String::new(),
            dimensions: None,
            timeout_secs: 10,
            batch_size: 32,
        }
    }
}
