//! Long-term memory (module `memory`).
//!
//! * **Consolidation**: when a context goes quiet (or many lines piled up),
//!   new log lines are summarized by the `summarizer` purpose into an
//!   episode, facts, her own notes and followups, written from her
//!   perspective, deduplicated against existing records and stored.
//! * **Retrieval**: hybrid score of vector similarity, full text, recency,
//!   importance and "about someone present", restricted to the scopes visible
//!   in the current context ([`scope`]). Embeddings are optional.
//! * **Privacy**: what is learned in a DM stays in that DM.
//! * Prompt contributor `memory`, tools `remember` / `recall`, commands
//!   `memory show | forget | export`, a [`FollowupSource`](miyoria_types::FollowupSource)
//!   and daily forgetting.

pub mod commands;
pub mod config;
pub mod contributor;
pub mod embed;
pub mod engine;
pub mod extract;
pub mod module;
pub mod scope;
pub mod score;
pub mod tokenize;
pub mod tools;

pub use config::{
    DedupeConfig, EmbeddingConfig, ForgettingConfig, GuildScope, MemoryConfig, Weights,
};
pub use contributor::MemoryContributor;
pub use embed::{Embedder, NoEmbedder, OpenAiCompatibleEmbedder, build_embedder, cosine};
pub use engine::{
    ConsolidationReport, MaintenanceReport, MemoryEngine, NewMemory, Recalled, Stored, Watermark,
};
pub use module::{ActivityTracker, MemoryModule};
pub use scope::{request_scopes, scope_for_new, visible_scopes};
pub use tokenize::tokenize;

#[cfg(test)]
mod tests;
