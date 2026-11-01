//! Her social life (ARCHITECTURE §6).
//!
//! * Module [`SocialModule`] (`social`): relationships of the active profile,
//!   appraisal of conversations (keyword rules plus a batched LLM pass), her
//!   impression notes, the `在場的人` prompt section, `/link`, `/me` and
//!   `/admin person ...`. Provides `Arc<dyn SocialSignals>` and `Arc<Social>`.
//! * Module [`MoodModule`] (`mood`): her global mood (valence / arousal /
//!   energy) drifting back to the profile baseline. Provides
//!   `Arc<dyn MoodSignals>` and the `mood` prompt section.
//!
//! Only these modules change relationship numbers; LLM tools cannot.

pub mod mood;
pub mod social;

pub use mood::{MoodConfig, MoodEngine, MoodModule, MoodPrompt, MoodState};
pub use social::{
    EventKind, Social, SocialConfig, SocialModule, SocialPrompt, SocialStores, label,
};
