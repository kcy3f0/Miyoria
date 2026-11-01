//! Shared domain types and the contracts modules use to talk to each other.
//!
//! Modules never depend on each other's implementations. They exchange the
//! data types defined here over the event bus, or call the service traits
//! defined here through the kernel's service registry.

pub mod action;
pub mod auth;
pub mod event;
pub mod ids;
pub mod platform;
pub mod prompt;
pub mod social;
pub mod voice;

pub use action::{Action, ActionPayload, ActionSink, LaneKey, Priority};
pub use auth::{Authorizer, Subject};
pub use event::{DecisionTrace, Envelope, Event, ModuleStateKind};
pub use ids::{ActionId, EventId, ModuleId, PersonId, ProfileId, TurnId};
pub use platform::{
    AccountRef, Attachment, Author, ContextKey, ContextKind, IncomingMessage, MessageRef,
    OutgoingMessage, PlatformId, PlatformSink, PlatformSinks,
};
pub use prompt::{
    Participant, PromptContributor, PromptContributors, PromptRequest, PromptSection,
};
pub use social::{Attitude, Followup, FollowupSource, Mood, MoodSignals, SocialSignals};
pub use voice::{PlaybackState, SpeakOutcome, VoiceParticipant, VoiceSink, VoiceUtterance};
