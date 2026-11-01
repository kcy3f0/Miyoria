use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::{PersonId, ProfileId};
use crate::platform::{AccountRef, ContextKey};

/// How she currently feels about someone. Cheap to query.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Attitude {
    pub person: PersonId,
    /// -100..100
    pub affinity: f32,
    /// 0..100
    pub trust: f32,
    /// 0..100
    pub familiarity: f32,
    /// She ignores this person entirely (admin decision).
    pub blocked: bool,
    /// Short label for prompts and `/me`, e.g. `"陌生人"`, `"朋友"`.
    pub label: String,
    /// How she addresses them, if set.
    pub call_name: Option<String>,
}

/// Provided by the social module (`dyn SocialSignals`); the agent uses it in
/// attention. Must answer from memory (no I/O).
pub trait SocialSignals: Send + Sync {
    fn attitude(&self, account: &AccountRef) -> Option<Attitude>;
}

/// Global emotional state of the active profile.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Mood {
    /// -1..1
    pub valence: f32,
    /// 0..1
    pub arousal: f32,
    /// 0..1
    pub energy: f32,
}

/// Provided by the mood module (`dyn MoodSignals`).
pub trait MoodSignals: Send + Sync {
    fn mood(&self) -> Mood;
}

/// Something she promised or wants to bring up later ("你明天考試考得怎樣?").
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Followup {
    pub id: String,
    pub profile: ProfileId,
    pub person: Option<PersonId>,
    /// Where it came up; follow up there (or wherever the person shows up).
    pub context: Option<ContextKey>,
    pub about: String,
    /// Earliest time it makes sense to bring it up.
    pub due: DateTime<Utc>,
}

/// Provided by the memory module (`dyn FollowupSource`); used by initiative.
#[async_trait]
pub trait FollowupSource: Send + Sync {
    /// Followups due at `now` (not yet done).
    async fn due(&self, profile: &ProfileId, now: DateTime<Utc>) -> anyhow::Result<Vec<Followup>>;
    async fn mark_done(&self, id: &str) -> anyhow::Result<()>;
}
