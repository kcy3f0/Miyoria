//! Module `social`: relationships, appraisal, notes, linking and commands.

mod appraisal;
mod commands;
mod config;
mod engine;
mod module;
mod prompt;
mod rel;
mod rules;

#[cfg(test)]
mod tests;

pub use appraisal::{PersonAppraisal, parse_appraisal, parse_notes};
pub use commands::{PATHS, register_commands, unregister_commands};
pub use config::SocialConfig;
pub use engine::{LinkOutcome, Observed, Publisher, Social, SocialStores, attitude, merge_into};
pub use module::SocialModule;
pub use prompt::SocialPrompt;
pub use rel::{BLOCKED_TAG, DayLedger, EventKind, OWNER_TAG, label};
pub use rules::classify;

/// Bus topic of every relationship change.
pub const TOPIC: &str = "social.relationship";
