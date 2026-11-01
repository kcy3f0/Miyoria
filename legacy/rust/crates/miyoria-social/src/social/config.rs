use serde::Deserialize;

/// `[modules.social]` config section. Every field has a default.
///
/// ```toml
/// [modules.social]
/// daily_affinity_cap = 8.0
/// appraisal_every_lines = 8
/// ```
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct SocialConfig {
    /// Max affinity gained (and, separately, lost) per person per day through
    /// appraisal.
    pub daily_affinity_cap: f32,
    /// Max trust gained (and lost) per person per day through appraisal.
    pub daily_trust_cap: f32,
    /// The n-th event of the same kind on one day is worth `repeat_decay^n`.
    pub repeat_decay: f32,
    /// People tagged `owner` always have this trust.
    pub owner_trust: f32,
    /// People tagged `owner` never drop below this affinity.
    pub owner_affinity_floor: f32,
    /// Trust of someone she just met.
    pub default_trust: f32,
    /// Her local time zone as a UTC offset, for "days" and familiarity.
    pub utc_offset_minutes: i32,
    /// Days without contact before familiarity starts to decay.
    pub familiarity_grace_days: i64,
    /// Familiarity lost per day without contact after the grace period.
    pub familiarity_decay_per_day: f32,
    /// Ask the LLM once a context collected this many new lines from people.
    pub appraisal_every_lines: usize,
    /// ...or once a context with new lines was quiet this long.
    pub appraisal_idle_secs: i64,
    /// Lines of a context kept for appraisal (older ones are dropped).
    pub appraisal_max_lines: usize,
    /// A line counts as said to her when she spoke in the context this
    /// recently (besides mentions, replies, DMs and her names).
    pub direct_window_secs: i64,
    /// Refresh her notes about someone after this many of their lines...
    pub notes_every_lines: u32,
    /// ...but at most this often per person.
    pub notes_min_interval_hours: i64,
    /// Background tick: idle appraisals, notes, flushing interaction counts.
    pub tick_secs: u64,
    /// Accounts the authorizer treats as owners get the `owner` tag.
    pub auto_owner_tag: bool,
    /// People listed in the `在場的人` prompt section.
    pub prompt_max_people: usize,
    /// LLM purpose used for appraisal and notes.
    pub llm_purpose: String,
}

impl Default for SocialConfig {
    fn default() -> Self {
        Self {
            daily_affinity_cap: 8.0,
            daily_trust_cap: 5.0,
            repeat_decay: 0.5,
            owner_trust: 100.0,
            owner_affinity_floor: 30.0,
            default_trust: 10.0,
            utc_offset_minutes: 8 * 60,
            familiarity_grace_days: 7,
            familiarity_decay_per_day: 0.5,
            appraisal_every_lines: 8,
            appraisal_idle_secs: 90,
            appraisal_max_lines: 30,
            direct_window_secs: 45,
            notes_every_lines: 40,
            notes_min_interval_hours: 12,
            tick_secs: 15,
            auto_owner_tag: true,
            prompt_max_people: 8,
            llm_purpose: "fast".to_owned(),
        }
    }
}
