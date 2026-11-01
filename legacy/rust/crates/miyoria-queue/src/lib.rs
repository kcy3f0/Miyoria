//! The user request queue (module `queue`).
//!
//! Explicit "orders" from viewers ("sing a song", "go mine diamonds"), game
//! goals and other long tasks wait here. Ordering is fair round-robin across
//! requesters, then moderator priority and affinity weight, then age (see
//! [`RequestQueue`]). A voting mode collects one ballot per account for a
//! limited time and enqueues the winner.
//!
//! Events published on the bus (all `Event::Custom`):
//! - `queue.changed` `{items, paused, vote?}` after every change (the overlay shows it)
//! - `queue.item_activated` `{...item}` when an item is popped with `next`
//! - `queue.vote_result` `{options, tallies, winner, ...}` when a vote ends
//!
//! State is snapshotted to `dyn SettingsStore` (profile `_global`, key
//! `queue:state`) after changes and restored on start.

pub mod commands;
pub mod config;
pub mod module;
pub mod queue;
pub mod types;

pub use commands::register_commands;
pub use config::{QueueConfig, QueuePermissions};
pub use module::QueueModule;
pub use queue::{Clock, Publisher, RequestQueue, STATE_KEY, STATE_PROFILE, Submitted};
pub use types::{
    Ballot, ItemId, ItemState, QueueError, QueueItem, SubmitRequest, VoteResult, VoteState,
};
