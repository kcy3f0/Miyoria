//! Module `mood`: her global mood.
//!
//! Valence / arousal / energy drift back to the profile baseline with an
//! exponential decay, energy follows a time-of-day curve (low late at night)
//! and events nudge it:
//!
//! * `social.relationship` (praise, insults, ... from the social module),
//! * `agent.emotion` (her own emotion tags),
//! * `mood.nudge` with `{"valence": .., "arousal": .., "energy": .., "reason": ..}`
//!   (all optional; for games and extensions).
//!
//! Publishes `mood.changed` when the mood moved noticeably.

use std::sync::Arc;
use std::time::Duration as StdDuration;

use async_trait::async_trait;
use chrono::{DateTime, FixedOffset, Timelike, Utc};
use miyoria_kernel::{Module, ModuleContext, ModuleManifest, TopicFilter};
use miyoria_profile::MoodBaseline;
use miyoria_store::SettingsStore;
use miyoria_types::{
    Event, Mood, MoodSignals, ProfileId, PromptContributor, PromptContributors, PromptRequest,
    PromptSection,
};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;
use tracing::{debug, warn};

/// Settings key of the persisted mood.
pub const SETTINGS_KEY: &str = "mood:last";
/// Bus topic published when the mood moved.
pub const TOPIC_CHANGED: &str = "mood.changed";

/// `[modules.mood]` config section.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct MoodConfig {
    /// Time for half of a deviation from the baseline to fade.
    pub half_life_secs: f64,
    pub tick_secs: u64,
    /// Publish `mood.changed` once any dimension moved this much.
    pub publish_threshold: f32,
    /// Her local time zone as a UTC offset.
    pub utc_offset_minutes: i32,
    /// How much energy drops at the deepest point of the night (0..1).
    pub night_dip: f32,
    /// Remember the last mood across restarts (needs `dyn SettingsStore`).
    pub persist: bool,
    /// Valence change per affinity point of a social event.
    pub social_weight: f32,
    /// Largest change of one dimension by a single event.
    pub max_nudge: f32,
}

impl Default for MoodConfig {
    fn default() -> Self {
        Self {
            half_life_secs: 1800.0,
            tick_secs: 30,
            publish_threshold: 0.05,
            utc_offset_minutes: 8 * 60,
            night_dip: 0.4,
            persist: true,
            social_weight: 0.03,
            max_nudge: 0.2,
        }
    }
}

/// Sleepiness per local hour (0 = awake, 1 = deepest night), interpolated.
const NIGHT_SHAPE: [f32; 24] = [
    0.5, 0.7, 0.85, 0.95, 1.0, 0.9, 0.65, 0.35, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.05, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.1, 0.2, 0.35,
];

/// Sleepiness at a fractional local hour (0..24).
pub fn night_shape(hour: f32) -> f32 {
    let h = hour.rem_euclid(24.0);
    let i = (h.floor() as usize) % 24;
    let frac = h - h.floor();
    let next = NIGHT_SHAPE[(i + 1) % 24];
    NIGHT_SHAPE[i] + (next - NIGHT_SHAPE[i]) * frac
}

fn clamp_mood(m: Mood) -> Mood {
    let fix = |v: f32, lo: f32, hi: f32| {
        if v.is_finite() {
            v.clamp(lo, hi)
        } else {
            lo.max(0.0)
        }
    };
    Mood {
        valence: fix(m.valence, -1.0, 1.0),
        arousal: fix(m.arousal, 0.0, 1.0),
        energy: fix(m.energy, 0.0, 1.0),
    }
}

/// Pure mood dynamics; `now` is passed in.
#[derive(Clone, Debug)]
pub struct MoodEngine {
    baseline: Mood,
    current: Mood,
    at: DateTime<Utc>,
    config: MoodConfig,
}

impl MoodEngine {
    pub fn new(baseline: MoodBaseline, config: MoodConfig, now: DateTime<Utc>) -> Self {
        let baseline = clamp_mood(Mood {
            valence: baseline.valence,
            arousal: baseline.arousal,
            energy: baseline.energy,
        });
        let mut engine = Self {
            baseline,
            current: baseline,
            at: now,
            config,
        };
        engine.current = engine.target(now);
        engine
    }

    pub fn baseline(&self) -> Mood {
        self.baseline
    }

    pub fn current(&self) -> Mood {
        self.current
    }

    fn local_hour(&self, now: DateTime<Utc>) -> f32 {
        let offset = FixedOffset::east_opt(self.config.utc_offset_minutes * 60)
            .unwrap_or_else(|| FixedOffset::east_opt(0).expect("zero offset"));
        let t = now.with_timezone(&offset);
        let minutes = (t.hour() * 60 + t.minute()) as f32;
        minutes / 60.0
    }

    /// Where the mood drifts to at `now` (baseline shaped by the time of day).
    pub fn target(&self, now: DateTime<Utc>) -> Mood {
        let dip = self.config.night_dip.clamp(0.0, 1.0) * night_shape(self.local_hour(now));
        clamp_mood(Mood {
            valence: self.baseline.valence,
            arousal: self.baseline.arousal * (1.0 - 0.5 * dip),
            energy: self.baseline.energy * (1.0 - dip),
        })
    }

    /// The mood at `now` without changing the engine.
    pub fn peek(&self, now: DateTime<Utc>) -> Mood {
        let mut copy = self.clone();
        copy.advance(now);
        copy.current
    }

    /// Decays toward the target up to `now`.
    pub fn advance(&mut self, now: DateTime<Utc>) {
        let dt = (now - self.at).num_milliseconds();
        if dt <= 0 {
            return;
        }
        let secs = dt as f64 / 1000.0;
        let half_life = self.config.half_life_secs.max(1.0);
        let alpha = (1.0 - 0.5f64.powf(secs / half_life)) as f32;
        let target = self.target(now);
        let step = |cur: f32, tgt: f32| cur + (tgt - cur) * alpha;
        self.current = clamp_mood(Mood {
            valence: step(self.current.valence, target.valence),
            arousal: step(self.current.arousal, target.arousal),
            energy: step(self.current.energy, target.energy),
        });
        self.at = now;
    }

    /// Adds a change (each dimension limited to `max_nudge`) at `now`.
    pub fn nudge(&mut self, now: DateTime<Utc>, valence: f32, arousal: f32, energy: f32) {
        self.advance(now);
        let max = self.config.max_nudge.abs();
        let lim = |v: f32| {
            if v.is_finite() {
                v.clamp(-max, max)
            } else {
                0.0
            }
        };
        self.current = clamp_mood(Mood {
            valence: self.current.valence + lim(valence),
            arousal: self.current.arousal + lim(arousal),
            energy: self.current.energy + lim(energy),
        });
    }

    /// Restores a saved mood from `at` and decays it to `now`.
    pub fn restore(&mut self, mood: Mood, at: DateTime<Utc>, now: DateTime<Utc>) {
        self.current = clamp_mood(mood);
        self.at = at.min(now);
        self.advance(now);
    }
}

/// `(valence, arousal, energy)` nudge for one of her emotion tags.
pub fn emotion_nudge(emotion: &str) -> Option<(f32, f32, f32)> {
    Some(match emotion.trim().to_lowercase().as_str() {
        "happy" => (0.06, 0.04, 0.0),
        "smug" => (0.04, 0.02, 0.0),
        "embarrassed" => (0.02, 0.05, 0.0),
        "surprised" => (0.0, 0.06, 0.0),
        "annoyed" => (-0.03, 0.03, 0.0),
        "angry" => (-0.06, 0.08, 0.0),
        "sad" => (-0.06, -0.03, -0.02),
        _ => return None,
    })
}

fn num(v: &Value, key: &str) -> f32 {
    v.get(key).and_then(Value::as_f64).map_or(0.0, |x| x as f32)
}

/// The nudge an event causes, if any, with a short reason.
pub fn event_nudge(event: &Event, config: &MoodConfig) -> Option<(f32, f32, f32, String)> {
    let Event::Custom { topic, payload } = event else {
        return None;
    };
    match topic.as_str() {
        "social.relationship" => {
            let kind = payload.get("kind").and_then(Value::as_str)?;
            let affinity = num(payload, "affinity");
            if affinity.abs() < 1e-6 {
                return None;
            }
            let hostile = matches!(kind, "insult" | "harassment" | "flirt_too_far");
            let arousal = affinity.abs() * 0.01 + if hostile { 0.05 } else { 0.0 };
            Some((
                affinity * config.social_weight,
                arousal,
                0.0,
                format!("social: {kind}"),
            ))
        }
        "agent.emotion" => {
            let emotion = payload.get("emotion").and_then(Value::as_str)?;
            let (v, a, e) = emotion_nudge(emotion)?;
            Some((v, a, e, format!("emotion: {emotion}")))
        }
        "mood.nudge" => {
            let reason = payload
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("nudge")
                .to_owned();
            Some((
                num(payload, "valence"),
                num(payload, "arousal"),
                num(payload, "energy"),
                reason,
            ))
        }
        _ => None,
    }
}

/// One-line hint for the prompt.
pub fn describe(m: Mood) -> String {
    let v = if m.valence >= 0.5 {
        "心情很好"
    } else if m.valence >= 0.2 {
        "心情不錯"
    } else if m.valence > -0.2 {
        "心情普通"
    } else if m.valence > -0.5 {
        "有點不爽"
    } else {
        "心情很差"
    };
    let e = if m.energy < 0.3 {
        "很睏"
    } else if m.energy < 0.5 {
        "有點累"
    } else if m.energy > 0.85 {
        "精神很好"
    } else {
        "精神還可以"
    };
    let a = if m.arousal > 0.75 {
        ",情緒有點激動"
    } else if m.arousal < 0.25 {
        ",很平靜"
    } else {
        ""
    };
    format!("你現在{v}、{e}{a}。語氣可以自然帶出來,但不用直接說出自己的心情。")
}

/// Shared mood state. Provided as `Arc<MoodState>` and `Arc<dyn MoodSignals>`.
pub struct MoodState {
    engine: Mutex<MoodEngine>,
    last_published: Mutex<Mood>,
    threshold: f32,
    config: MoodConfig,
}

impl MoodState {
    pub fn new(baseline: MoodBaseline, config: MoodConfig, now: DateTime<Utc>) -> Self {
        let engine = MoodEngine::new(baseline, config.clone(), now);
        let current = engine.current();
        Self {
            engine: Mutex::new(engine),
            last_published: Mutex::new(current),
            threshold: config.publish_threshold.abs(),
            config,
        }
    }

    pub fn at(&self, now: DateTime<Utc>) -> Mood {
        self.engine.lock().peek(now)
    }

    /// Applies an event. Returns the new mood when it should be published.
    pub fn handle(&self, event: &Event, now: DateTime<Utc>) -> Option<(Mood, String)> {
        let (v, a, e, reason) = event_nudge(event, &self.config)?;
        self.engine.lock().nudge(now, v, a, e);
        self.changed(now).map(|m| (m, reason))
    }

    /// Advances the decay. Returns the new mood when it should be published.
    pub fn tick(&self, now: DateTime<Utc>) -> Option<Mood> {
        self.engine.lock().advance(now);
        self.changed(now)
    }

    fn changed(&self, now: DateTime<Utc>) -> Option<Mood> {
        let current = self.engine.lock().peek(now);
        let mut last = self.last_published.lock();
        let moved = (current.valence - last.valence)
            .abs()
            .max((current.arousal - last.arousal).abs())
            .max((current.energy - last.energy).abs());
        (moved >= self.threshold).then(|| {
            *last = current;
            current
        })
    }

    /// Restores `{"valence", "arousal", "energy", "at"}` as saved by [`to_json`](Self::to_json).
    pub fn restore_json(&self, value: &Value, now: DateTime<Utc>) {
        let at = value
            .get("at")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map_or(now, |t| t.with_timezone(&Utc));
        let mood = Mood {
            valence: num(value, "valence"),
            arousal: num(value, "arousal"),
            energy: num(value, "energy"),
        };
        let mut engine = self.engine.lock();
        engine.restore(mood, at, now);
        *self.last_published.lock() = engine.current();
    }

    pub fn to_json(&self, now: DateTime<Utc>) -> Value {
        let m = self.at(now);
        serde_json::json!({
            "valence": m.valence,
            "arousal": m.arousal,
            "energy": m.energy,
            "at": now.to_rfc3339(),
        })
    }
}

impl MoodSignals for MoodState {
    fn mood(&self) -> Mood {
        self.at(Utc::now())
    }
}

/// Prompt contributor `mood`: one line about how she feels.
pub struct MoodPrompt {
    state: Arc<MoodState>,
}

impl MoodPrompt {
    pub const KEY: &'static str = "mood";

    pub fn new(state: Arc<MoodState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl PromptContributor for MoodPrompt {
    fn key(&self) -> &str {
        Self::KEY
    }

    async fn contribute(&self, request: &PromptRequest) -> anyhow::Result<Vec<PromptSection>> {
        Ok(vec![PromptSection {
            key: Self::KEY.to_owned(),
            title: "你現在的狀態".to_owned(),
            body: describe(self.state.at(request.now)),
            order: 30,
        }])
    }
}

/// Module `mood`. Requires nothing; uses `dyn SettingsStore` and
/// `PromptContributors` when present.
pub struct MoodModule {
    manifest: ModuleManifest,
    profile: ProfileId,
    baseline: MoodBaseline,
    running: Mutex<Option<Running>>,
}

struct Running {
    state: Arc<MoodState>,
    store: Option<Arc<dyn SettingsStore>>,
    contributors: Option<Arc<PromptContributors>>,
}

impl MoodModule {
    pub const ID: &'static str = "mood";

    /// `baseline` is `Profile.manifest.mood`.
    pub fn new(profile: ProfileId, baseline: MoodBaseline) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Mood")
                .description("Her mood: decays to the persona baseline, nudged by events"),
            profile,
            baseline,
            running: Mutex::new(None),
        }
    }
}

async fn save(store: &dyn SettingsStore, profile: &ProfileId, state: &MoodState) {
    if let Err(e) = store
        .set(profile, SETTINGS_KEY, Some(state.to_json(Utc::now())))
        .await
    {
        warn!(error = %e, "cannot persist mood");
    }
}

#[async_trait]
impl Module for MoodModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: MoodConfig = ctx.config()?;
        let now = Utc::now();
        let state = Arc::new(MoodState::new(self.baseline, config.clone(), now));
        let store = if config.persist {
            ctx.services().get::<dyn SettingsStore>()
        } else {
            None
        };
        if let Some(store) = &store {
            match store.get(&self.profile, SETTINGS_KEY).await {
                Ok(Some(saved)) => state.restore_json(&saved, now),
                Ok(None) => {}
                Err(e) => warn!(error = %e, "cannot load saved mood"),
            }
        }
        ctx.provide::<dyn MoodSignals>(state.clone());
        ctx.provide(state.clone());
        let contributors = ctx.services().get::<PromptContributors>();
        if let Some(c) = &contributors {
            c.register(Arc::new(MoodPrompt::new(state.clone())));
        }
        *self.running.lock() = Some(Running {
            state: state.clone(),
            store: store.clone(),
            contributors,
        });

        let mut sub = ctx.subscribe(TopicFilter::new([
            "social.relationship",
            "agent.emotion",
            "mood.nudge",
        ]));
        let cancel = ctx.cancellation().clone();
        let profile = self.profile.clone();
        let task_ctx = ctx.clone();
        ctx.spawn("mood", async move {
            let mut tick = tokio::time::interval(StdDuration::from_secs(config.tick_secs.max(1)));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                let changed = tokio::select! {
                    () = cancel.cancelled() => return Ok(()),
                    _ = tick.tick() => state.tick(Utc::now()).map(|m| (m, "decay".to_owned())),
                    env = sub.recv() => match env {
                        Some(env) => state.handle(&env.event, Utc::now()),
                        None => return Ok(()),
                    },
                };
                let Some((mood, reason)) = changed else {
                    continue;
                };
                debug!(?mood, %reason, "mood changed");
                task_ctx.publish(Event::Custom {
                    topic: TOPIC_CHANGED.to_owned(),
                    payload: serde_json::json!({
                        "valence": mood.valence,
                        "arousal": mood.arousal,
                        "energy": mood.energy,
                        "reason": reason,
                    }),
                });
                if let Some(store) = &store {
                    save(store.as_ref(), &profile, &state).await;
                }
            }
        });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        let running = self.running.lock().take();
        if let Some(r) = running {
            if let Some(c) = &r.contributors {
                c.unregister(MoodPrompt::KEY);
            }
            if let Some(store) = &r.store {
                save(store.as_ref(), &self.profile, &r.state).await;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn baseline() -> MoodBaseline {
        MoodBaseline {
            valence: 0.1,
            arousal: 0.5,
            energy: 0.7,
        }
    }

    /// Local (UTC+8) time on a fixed day.
    fn local(h: u32, m: u32) -> DateTime<Utc> {
        FixedOffset::east_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 11, 1, h, m, 0)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn energy_is_lower_late_at_night() {
        let e = MoodEngine::new(baseline(), MoodConfig::default(), local(12, 0));
        let noon = e.target(local(12, 0));
        let four = e.target(local(4, 0));
        let midnight = e.target(local(0, 0));
        assert!(close(noon.energy, 0.7), "{noon:?}");
        assert!(close(four.energy, 0.7 * 0.6), "{four:?}");
        assert!(four.energy < midnight.energy && midnight.energy < noon.energy);
        assert!(close(four.valence, 0.1));
        assert!(close(night_shape(4.5), 0.95));
    }

    #[test]
    fn decays_to_baseline_with_half_life() {
        let config = MoodConfig {
            half_life_secs: 600.0,
            ..MoodConfig::default()
        };
        let t0 = local(12, 0);
        let mut e = MoodEngine::new(baseline(), config, t0);
        e.nudge(t0, 0.2, 0.0, 0.0);
        assert!(close(e.current().valence, 0.3));
        e.advance(t0 + chrono::Duration::minutes(10));
        assert!(close(e.current().valence, 0.2), "{:?}", e.current());
        e.advance(t0 + chrono::Duration::hours(5));
        assert!(close(e.current().valence, 0.1));
    }

    #[test]
    fn nudges_are_limited_and_clamped() {
        let t0 = local(12, 0);
        let mut e = MoodEngine::new(baseline(), MoodConfig::default(), t0);
        e.nudge(t0, 5.0, -5.0, f32::NAN);
        assert!(close(e.current().valence, 0.3), "max_nudge");
        assert!(close(e.current().arousal, 0.3));
        assert!(close(e.current().energy, 0.7));
        for _ in 0..10 {
            e.nudge(t0, -0.2, -0.2, -0.2);
        }
        assert!(close(e.current().valence, -1.0));
        assert!(close(e.current().arousal, 0.0));
        assert!(close(e.current().energy, 0.0));
    }

    #[test]
    fn events_nudge_and_publish_past_threshold() {
        let t0 = local(12, 0);
        let state = MoodState::new(baseline(), MoodConfig::default(), t0);
        let praise = Event::Custom {
            topic: "social.relationship".into(),
            payload: serde_json::json!({"kind": "gift", "affinity": 3.0}),
        };
        let (mood, reason) = state.handle(&praise, t0).unwrap();
        assert!(mood.valence > 0.15 && reason == "social: gift");

        let insult = Event::Custom {
            topic: "social.relationship".into(),
            payload: serde_json::json!({"kind": "insult", "affinity": -3.0}),
        };
        let (mood, _) = state.handle(&insult, t0).unwrap();
        assert!(mood.valence < 0.15 && mood.arousal > 0.55, "{mood:?}");

        let small = Event::Custom {
            topic: "agent.emotion".into(),
            payload: serde_json::json!({"emotion": "smug"}),
        };
        assert!(state.handle(&small, t0).is_none(), "below threshold");
        let admin = Event::Custom {
            topic: "social.relationship".into(),
            payload: serde_json::json!({"kind": null, "affinity": 20.0}),
        };
        assert!(event_nudge(&admin, &MoodConfig::default()).is_none());
        let game = Event::Custom {
            topic: "mood.nudge".into(),
            payload: serde_json::json!({"energy": -0.1, "reason": "game: died"}),
        };
        let (mood, reason) = state.handle(&game, t0).unwrap();
        assert_eq!(reason, "game: died");
        assert!(mood.energy < 0.7);
        // Hours later it is back at the baseline.
        let later = state.at(t0 + chrono::Duration::hours(6));
        assert!(
            close(later.valence, 0.1) && close(later.energy, 0.7),
            "{later:?}"
        );
    }

    #[test]
    fn persists_and_restores() {
        let t0 = local(12, 0);
        let state = MoodState::new(baseline(), MoodConfig::default(), t0);
        state.engine.lock().nudge(t0, -0.2, 0.0, 0.0);
        let saved = state.to_json(t0);
        let fresh = MoodState::new(baseline(), MoodConfig::default(), t0);
        fresh.restore_json(&saved, t0 + chrono::Duration::minutes(30));
        let m = fresh.at(t0 + chrono::Duration::minutes(30));
        assert!(close(m.valence, 0.0), "half decayed: {m:?}");
    }

    #[test]
    fn describes_in_one_line() {
        let line = describe(Mood {
            valence: 0.6,
            arousal: 0.9,
            energy: 0.2,
        });
        assert!(line.contains("心情很好") && line.contains("很睏") && line.contains("激動"));
        assert!(!line.contains('\n'));
    }
}
