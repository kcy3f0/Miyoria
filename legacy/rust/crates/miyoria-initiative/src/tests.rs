//! Engine tests drive `Engine` with explicit times; module tests run the real
//! module on a supervisor with paused tokio time and fake services.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use miyoria_kernel::{EventBus, ServiceRegistry, Subscription, Supervisor, TopicFilter};
use miyoria_store::{SettingsStore, Store};
use miyoria_types::{
    AccountRef, Attitude, Author, ContextKey, ContextKind, Event, Followup, FollowupSource,
    IncomingMessage, MessageRef, ModuleId, Mood, MoodSignals, PersonId, PlatformId, ProfileId,
    SocialSignals, VoiceParticipant,
};
use parking_lot::Mutex;

use crate::{Emission, Engine, InitiativeConfig, InitiativeModule, Signals, TokioClock};

// --- fixtures ---------------------------------------------------------

const MIN: i64 = 60;

fn t0() -> DateTime<Utc> {
    // 2025-03-10 12:00 in UTC+8.
    Utc.with_ymd_and_hms(2025, 3, 10, 4, 0, 0).unwrap()
}

fn at(base: DateTime<Utc>, secs: i64) -> DateTime<Utc> {
    base + chrono::Duration::seconds(secs)
}

fn acct(id: &str) -> AccountRef {
    AccountRef {
        platform: PlatformId::new("discord"),
        id: id.to_owned(),
    }
}

fn text_ctx(channel: &str) -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: Some("g".to_owned()),
        channel: channel.to_owned(),
        kind: ContextKind::Channel,
    }
}

fn voice_ctx(channel: &str) -> ContextKey {
    ContextKey {
        kind: ContextKind::Voice,
        ..text_ctx(channel)
    }
}

fn message(ctx: &ContextKey, who: &str, is_bot: bool, ts: DateTime<Utc>) -> Event {
    Event::PlatformMessageCreated(IncomingMessage {
        id: MessageRef {
            context: ctx.clone(),
            id: format!("{who}-{}", ts.timestamp_millis()),
        },
        author: Author {
            account: acct(who),
            display_name: who.to_owned(),
            is_bot,
        },
        text: "hi".to_owned(),
        mentions_self: false,
        reply_to_self: false,
        attachments: Vec::new(),
        ts,
    })
}

fn ready() -> Event {
    Event::PlatformReady {
        platform: PlatformId::new("discord"),
        self_account: acct("me"),
    }
}

fn participant(id: &str) -> VoiceParticipant {
    VoiceParticipant {
        account: acct(id),
        display_name: id.to_owned(),
        is_self: id == "me",
        muted: false,
        deafened: false,
    }
}

fn voice_joined(ctx: &ContextKey, ids: &[&str]) -> Event {
    Event::VoiceJoined {
        context: ctx.clone(),
        participants: ids.iter().map(|i| participant(i)).collect(),
    }
}

fn voice_members(ctx: &ContextKey, ids: &[&str]) -> Event {
    Event::VoiceParticipants {
        context: ctx.clone(),
        participants: ids.iter().map(|i| participant(i)).collect(),
    }
}

/// Fake `SocialSignals`; accounts without an entry are unknown.
#[derive(Default)]
struct FakeSocial(Mutex<HashMap<AccountRef, Attitude>>);

impl FakeSocial {
    fn set(&self, id: &str, label: &str, affinity: f32) -> PersonId {
        let person = PersonId::new();
        self.set_person(id, person, label, affinity);
        person
    }

    fn set_person(&self, id: &str, person: PersonId, label: &str, affinity: f32) {
        self.0.lock().insert(
            acct(id),
            Attitude {
                person,
                affinity,
                trust: 50.0,
                familiarity: 50.0,
                blocked: false,
                label: label.to_owned(),
                call_name: None,
            },
        );
    }

    fn block(&self, id: &str) {
        self.0.lock().get_mut(&acct(id)).unwrap().blocked = true;
    }
}

impl SocialSignals for FakeSocial {
    fn attitude(&self, account: &AccountRef) -> Option<Attitude> {
        self.0.lock().get(account).cloned()
    }
}

struct FakeMood(f32);

impl MoodSignals for FakeMood {
    fn mood(&self) -> Mood {
        Mood {
            valence: 0.0,
            arousal: 0.5,
            energy: self.0,
        }
    }
}

#[derive(Default)]
struct FakeFollowups {
    due: Mutex<Vec<Followup>>,
    done: Mutex<Vec<String>>,
}

#[async_trait]
impl FollowupSource for FakeFollowups {
    async fn due(&self, _: &ProfileId, _: DateTime<Utc>) -> anyhow::Result<Vec<Followup>> {
        let done = self.done.lock();
        Ok(self
            .due
            .lock()
            .iter()
            .filter(|f| !done.contains(&f.id))
            .cloned()
            .collect())
    }

    async fn mark_done(&self, id: &str) -> anyhow::Result<()> {
        self.done.lock().push(id.to_owned());
        Ok(())
    }
}

fn followup(person: Option<PersonId>, context: Option<ContextKey>) -> Followup {
    Followup {
        id: "f1".to_owned(),
        profile: ProfileId::from("p"),
        person,
        context,
        about: "你說今天要考試,考得怎樣?".to_owned(),
        due: t0(),
    }
}

// --- engine rig -------------------------------------------------------

struct Rig {
    eng: Engine,
    social: Arc<FakeSocial>,
    mood: Option<FakeMood>,
}

impl Rig {
    fn new(cfg: InitiativeConfig) -> Self {
        let mut rig = Self {
            eng: Engine::new(cfg),
            social: Arc::default(),
            mood: None,
        };
        rig.event(t0(), &ready());
        rig
    }

    fn standard() -> Self {
        Self::new(InitiativeConfig::default())
    }

    fn event(&mut self, t: DateTime<Utc>, ev: &Event) -> Vec<Emission> {
        let sig = Signals {
            social: Some(self.social.as_ref()),
            mood: self.mood.as_ref().map(|m| m as &dyn MoodSignals),
        };
        self.eng.observe(t, ev, &sig)
    }

    fn tick(&mut self, t: DateTime<Utc>) -> Vec<Emission> {
        let sig = Signals {
            social: Some(self.social.as_ref()),
            mood: self.mood.as_ref().map(|m| m as &dyn MoodSignals),
        };
        self.eng.tick(t, &sig)
    }

    fn plan(&mut self, t: DateTime<Utc>, f: &Followup) -> Option<Emission> {
        let sig = Signals {
            social: Some(self.social.as_ref()),
            mood: None,
        };
        self.eng.plan_followup(t, f, &sig)
    }

    fn say(&mut self, ctx: &ContextKey, who: &str, t: DateTime<Utc>) -> Vec<Emission> {
        self.event(t, &message(ctx, who, false, t))
    }

    fn say_as_me(&mut self, ctx: &ContextKey, t: DateTime<Utc>) {
        assert!(self.event(t, &message(ctx, "me", true, t)).is_empty());
    }

    /// A lively conversation of six messages (two of them hers), 10 s apart.
    /// Returns the time of the last message.
    fn chat(&mut self, ctx: &ContextKey, start: DateTime<Utc>) -> DateTime<Utc> {
        let speakers = ["a", "me", "b", "me", "a", "b"];
        let mut t = start;
        for (i, who) in speakers.iter().enumerate() {
            t = at(start, 10 * i as i64);
            if *who == "me" {
                self.say_as_me(ctx, t);
            } else {
                assert!(self.say(ctx, who, t).is_empty());
            }
        }
        t
    }

    /// A conversation, its idle initiative and the wait until the unanswered
    /// initiative is settled. Returns the emissions and the time afterwards.
    fn cycle(&mut self, ctx: &ContextKey, start: DateTime<Utc>) -> (Vec<Emission>, DateTime<Utc>) {
        let last = self.chat(ctx, start);
        let out = self.tick(at(last, 20 * MIN));
        self.tick(at(last, 32 * MIN));
        (out, at(last, 33 * MIN))
    }
}

fn reasons(e: &[Emission]) -> Vec<&'static str> {
    e.iter().map(|e| e.reason).collect()
}

// --- idle_channel -----------------------------------------------------

#[test]
fn idle_channel_fires_once_after_threshold() {
    let mut rig = Rig::standard();
    let ctx = text_ctx("c1");
    let last = rig.chat(&ctx, t0());
    assert!(rig.tick(at(last, 19 * MIN)).is_empty());
    let out = rig.tick(at(last, 20 * MIN));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].context, ctx);
    assert_eq!(out[0].reason, "idle_channel");
    assert_eq!(out[0].hint, "頻道冷掉了,可以找點話題");
    assert!(out[0].about.is_empty());
    assert!(rig.tick(at(last, 21 * MIN)).is_empty());
    assert!(rig.tick(at(last, 60 * MIN)).is_empty());
}

#[test]
fn idle_channel_needs_a_lively_conversation_she_took_part_in() {
    let mut rig = Rig::standard();
    // Lively, but she never spoke.
    let quiet = text_ctx("no-her");
    let mut last = t0();
    for i in 0..8 {
        last = at(t0(), 10 * i);
        rig.say(&quiet, if i % 2 == 0 { "a" } else { "b" }, last);
    }
    assert!(rig.tick(at(last, 30 * MIN)).is_empty());

    // She spoke, but the conversation was too short.
    let short = text_ctx("short");
    rig.say(&short, "a", t0());
    rig.say_as_me(&short, at(t0(), 10));
    rig.say(&short, "a", at(t0(), 20));
    assert!(rig.tick(at(t0(), 30 * MIN)).is_empty());
}

#[test]
fn idle_channel_gives_up_after_idle_max() {
    let mut rig = Rig::standard();
    let ctx = text_ctx("c1");
    let last = rig.chat(&ctx, t0());
    assert!(rig.tick(at(last, 3 * 3600 + 1)).is_empty());
    assert!(rig.tick(at(last, 3 * 3600 + 2)).is_empty());
}

#[test]
fn idle_channel_can_be_switched_off() {
    let mut rig = Rig::new(InitiativeConfig {
        idle_channel: false,
        ..Default::default()
    });
    let last = rig.chat(&text_ctx("c1"), t0());
    assert!(rig.tick(at(last, 25 * MIN)).is_empty());
}

#[test]
fn a_new_conversation_after_a_gap_starts_from_scratch() {
    let mut rig = Rig::standard();
    let ctx = text_ctx("c1");
    // Three messages, a long gap, three more: neither segment is lively.
    for (i, who) in ["a", "me", "b"].iter().enumerate() {
        let t = at(t0(), 10 * i as i64);
        if *who == "me" {
            rig.say_as_me(&ctx, t);
        } else {
            rig.say(&ctx, who, t);
        }
    }
    let later = at(t0(), 25 * MIN);
    rig.say(&ctx, "a", later);
    rig.say_as_me(&ctx, at(later, 10));
    rig.say(&ctx, "b", at(later, 20));
    assert!(rig.tick(at(later, 40 * MIN)).is_empty());
}

#[test]
fn voice_idle_requires_her_to_be_in_the_channel_with_someone() {
    let mut rig = Rig::standard();
    let v = voice_ctx("v1");
    rig.event(t0(), &voice_joined(&v, &["me", "a"]));
    let mut last = t0();
    for i in 0..6 {
        last = at(t0(), 10 * i);
        let who = ["a", "me"][i as usize % 2];
        rig.event(
            last,
            &Event::VoiceUtterance(miyoria_types::VoiceUtterance {
                id: format!("u{i}"),
                context: v.clone(),
                speaker: Author {
                    account: acct(who),
                    display_name: who.to_owned(),
                    is_bot: false,
                },
                text: "...".to_owned(),
                language: None,
                emotion: None,
                audio_events: Vec::new(),
                started_at: last,
                ended_at: last,
                asr_ms: 0,
            }),
        );
    }
    let out = rig.tick(at(last, 20 * MIN));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].context, v);
    assert_eq!(out[0].hint, "語音頻道安靜下來了,可以找點話題");

    // Same conversation, but everybody left: nothing to say to.
    let mut rig = Rig::standard();
    rig.event(t0(), &voice_joined(&v, &["me", "a"]));
    for i in 0..6 {
        let t = at(t0(), 10 * i);
        if i % 2 == 0 {
            rig.say(&v, "a", t);
        } else {
            rig.say_as_me(&v, t);
        }
    }
    rig.event(at(t0(), 60), &voice_members(&v, &["me"]));
    assert!(rig.tick(at(t0(), 25 * MIN)).is_empty());
    // She left the channel altogether.
    rig.event(
        at(t0(), 61),
        &Event::VoiceLeft {
            context: v.clone(),
            reason: None,
        },
    );
    assert!(rig.tick(at(t0(), 30 * MIN)).is_empty());
}

#[test]
fn bots_are_not_conversation() {
    let mut rig = Rig::standard();
    rig.social.set("bot1", "朋友", 90.0);
    let ctx = text_ctx("c1");
    let t = t0();
    assert!(rig.event(t, &message(&ctx, "bot1", true, t)).is_empty());
    let mut last = t;
    for i in 0..8 {
        last = at(t0(), i);
        rig.event(last, &message(&ctx, "bot1", true, last));
    }
    rig.say_as_me(&ctx, last);
    assert!(rig.tick(at(last, 30 * MIN)).is_empty());
}

// --- budget -----------------------------------------------------------

#[test]
fn per_context_daily_cap_resets_next_day() {
    let mut rig = Rig::new(InitiativeConfig {
        max_per_context_per_day: 2,
        ..Default::default()
    });
    let ctx = text_ctx("c1");
    let mut t = t0();
    let mut fired = Vec::new();
    for _ in 0..4 {
        let (out, next) = rig.cycle(&ctx, t);
        fired.push(out.len());
        t = next;
    }
    assert_eq!(fired, [1, 1, 0, 0]);
    // Another context is unaffected.
    let (out, _) = rig.cycle(&text_ctx("c2"), t);
    assert_eq!(out.len(), 1);
    // The next day the cap is fresh.
    let (out, _) = rig.cycle(&ctx, at(t0(), 24 * 3600));
    assert_eq!(out.len(), 1);
}

#[test]
fn global_daily_cap_spans_contexts() {
    let mut rig = Rig::new(InitiativeConfig {
        max_per_day: 2,
        ..Default::default()
    });
    let mut t = t0();
    let mut fired = 0;
    for ch in ["c1", "c2", "c3"] {
        let (out, next) = rig.cycle(&text_ctx(ch), t);
        fired += out.len();
        t = next;
    }
    assert_eq!(fired, 2);
    let (out, _) = rig.cycle(&text_ctx("c3"), at(t0(), 24 * 3600));
    assert_eq!(out.len(), 1);
}

#[test]
fn day_rolls_over_at_day_start_hour() {
    let mut rig = Rig::new(InitiativeConfig {
        max_per_context_per_day: 1,
        quiet_start_hour: 0,
        quiet_end_hour: 0,
        ..Default::default()
    });
    let ctx = text_ctx("c1");
    // 23:00 local.
    let (out, _) = rig.cycle(&ctx, at(t0(), 11 * 3600));
    assert_eq!(out.len(), 1);
    // 02:00 local the next calendar day is still the same "day".
    let (out, _) = rig.cycle(&ctx, at(t0(), 14 * 3600));
    assert!(out.is_empty());
    // 05:00 local is a new one.
    let (out, _) = rig.cycle(&ctx, at(t0(), 17 * 3600));
    assert_eq!(out.len(), 1);
}

#[test]
fn never_interrupts_an_active_conversation() {
    let mut rig = Rig::standard();
    let ctx = text_ctx("c1");
    let last = rig.chat(&ctx, t0());
    // Followup for a person while others are chatting.
    let pid = rig.social.set("p", "路人", 10.0);
    let f = followup(Some(pid), Some(ctx.clone()));
    rig.say(&ctx, "p", at(last, 60));
    rig.say(&ctx, "b", at(last, 70));
    assert!(rig.plan(at(last, 80), &f).is_none());
    // Two minutes later it is a lull, and she is still around.
    let e = rig.plan(at(last, 70 + 2 * MIN + 1), &f).unwrap();
    assert_eq!(e.reason, "followup");
}

#[test]
fn her_own_recent_message_counts_as_active() {
    let mut rig = Rig::standard();
    rig.social.set("a", "朋友", 80.0);
    let ctx = text_ctx("c1");
    rig.say_as_me(&ctx, t0());
    // The friend's first message arrives right after she spoke.
    assert!(rig.say(&ctx, "a", at(t0(), 5)).is_empty());
}

#[test]
fn disabled_contexts_get_nothing() {
    let mut rig = Rig::new(InitiativeConfig {
        disabled_contexts: vec!["discord:g:c1".into(), "c2".into()],
        ..Default::default()
    });
    rig.social.set("a", "朋友", 80.0);
    for ch in ["c1", "c2"] {
        let ctx = text_ctx(ch);
        let last = rig.chat(&ctx, t0());
        assert!(rig.tick(at(last, 30 * MIN)).is_empty(), "{ch}");
        assert!(rig.say(&ctx, "fresh", at(last, 40 * MIN)).is_empty());
    }
    // Greetings are blocked as well; other channels are fine.
    rig.social.set("z", "朋友", 80.0);
    rig.social.set("y", "朋友", 80.0);
    assert!(rig.say(&text_ctx("c2"), "z", at(t0(), 3600)).is_empty());
    assert_eq!(rig.say(&text_ctx("c3"), "y", at(t0(), 3600 + 1)).len(), 1);
    let (out, _) = rig.cycle(&text_ctx("c3"), at(t0(), 7200));
    assert_eq!(out.len(), 1);
}

#[test]
fn quiet_hours_stop_idle_nudges_until_morning() {
    // 00:50 local (16:50 UTC the day before).
    let start = Utc.with_ymd_and_hms(2025, 3, 9, 16, 50, 0).unwrap();
    let mut rig = Rig::new(InitiativeConfig {
        idle_max_secs: 10 * 3600,
        ..Default::default()
    });
    let ctx = text_ctx("c1");
    let last = rig.chat(&ctx, start);
    // 01:10 local and 03:00 local: quiet.
    assert!(rig.tick(at(last, 25 * MIN)).is_empty());
    assert!(rig.tick(at(last, 2 * 3600 + 10 * MIN)).is_empty());
    // 07:00 local: quiet hours are over and the conversation is still recent enough.
    let out = rig.tick(at(last, 6 * 3600 + 10 * MIN));
    assert_eq!(reasons(&out), ["idle_channel"]);
}

#[test]
fn quiet_hours_wrap_around_midnight() {
    let start = Utc.with_ymd_and_hms(2025, 3, 10, 14, 50, 0).unwrap(); // 22:50 local
    let mut rig = Rig::new(InitiativeConfig {
        quiet_start_hour: 22,
        quiet_end_hour: 6,
        ..Default::default()
    });
    let ctx = text_ctx("c1");
    let last = rig.chat(&ctx, start);
    assert!(rig.tick(at(last, 25 * MIN)).is_empty());
    // Disabled when start == end.
    let mut rig = Rig::new(InitiativeConfig {
        quiet_start_hour: 5,
        quiet_end_hour: 5,
        ..Default::default()
    });
    let last = rig.chat(&ctx, start);
    assert_eq!(rig.tick(at(last, 25 * MIN)).len(), 1);
}

#[test]
fn quiet_hours_do_not_stop_reactions_to_a_present_friend() {
    let night = Utc.with_ymd_and_hms(2025, 3, 9, 18, 0, 0).unwrap(); // 02:00 local
    let mut rig = Rig::standard();
    rig.social.set("a", "朋友", 80.0);
    let out = rig.say(&text_ctx("c1"), "a", night);
    assert_eq!(reasons(&out), ["greeting"]);
}

#[test]
fn mood_energy_scales_the_idle_threshold() {
    for (energy, minutes) in [(1.0, 10), (0.5, 20), (0.0, 40)] {
        let mut rig = Rig::standard();
        rig.mood = Some(FakeMood(energy));
        let ctx = text_ctx("c1");
        let last = rig.chat(&ctx, t0());
        assert!(
            rig.tick(at(last, minutes * MIN - 1)).is_empty(),
            "energy {energy}"
        );
        assert_eq!(
            rig.tick(at(last, minutes * MIN)).len(),
            1,
            "energy {energy}"
        );
    }
}

// --- adaptive backoff -------------------------------------------------

/// Conversation, idle initiative, she speaks, nobody replies, window passes.
fn ignored_initiative(rig: &mut Rig, ctx: &ContextKey, start: DateTime<Utc>) -> DateTime<Utc> {
    let last = rig.chat(ctx, start);
    let t = at(last, 20 * MIN);
    assert_eq!(rig.tick(t).len(), 1);
    rig.say_as_me(ctx, at(t, 5));
    rig.tick(at(t, 5 + 10 * MIN + 1));
    at(t, 11 * MIN)
}

#[test]
fn ignored_initiative_doubles_the_idle_threshold() {
    let mut rig = Rig::standard();
    let ctx = text_ctx("c1");
    let t = ignored_initiative(&mut rig, &ctx, t0());
    let last = rig.chat(&ctx, at(t, 20 * MIN));
    assert!(rig.tick(at(last, 39 * MIN)).is_empty());
    assert_eq!(rig.tick(at(last, 40 * MIN)).len(), 1);
    // Ignored again: 80 minutes.
    rig.say_as_me(&ctx, at(last, 41 * MIN));
    rig.tick(at(last, 52 * MIN));
    let last = rig.chat(&ctx, at(last, 60 * MIN));
    assert!(rig.tick(at(last, 79 * MIN)).is_empty());
    assert_eq!(rig.tick(at(last, 80 * MIN)).len(), 1);
}

#[test]
fn backoff_is_capped() {
    let mut rig = Rig::new(InitiativeConfig {
        max_backoff_doublings: 1,
        max_per_context_per_day: 100,
        max_per_day: 100,
        quiet_start_hour: 0,
        quiet_end_hour: 0,
        ..Default::default()
    });
    let ctx = text_ctx("c1");
    let mut t = t0();
    for _ in 0..3 {
        let last = rig.chat(&ctx, t);
        // Past 40 minutes it always fires, however often it was ignored.
        let now = at(last, 40 * MIN);
        assert_eq!(rig.tick(now).len(), 1);
        rig.say_as_me(&ctx, at(now, 5));
        rig.tick(at(now, 5 + 10 * MIN + 1));
        t = at(now, 12 * MIN);
    }
    let last = rig.chat(&ctx, t);
    assert!(rig.tick(at(last, 39 * MIN)).is_empty());
    assert_eq!(rig.tick(at(last, 40 * MIN)).len(), 1);
}

#[test]
fn a_reply_relaxes_the_backoff() {
    let mut rig = Rig::standard();
    let ctx = text_ctx("c1");
    let t = ignored_initiative(&mut rig, &ctx, t0());
    // Second initiative at 40 minutes; this time somebody answers.
    let last = rig.chat(&ctx, at(t, 20 * MIN));
    let now = at(last, 40 * MIN);
    assert_eq!(rig.tick(now).len(), 1);
    rig.say_as_me(&ctx, at(now, 5));
    rig.say(&ctx, "a", at(now, 30));
    // Back to 20 minutes.
    let last = rig.chat(&ctx, at(now, 60 * MIN));
    assert_eq!(rig.tick(at(last, 20 * MIN)).len(), 1);
}

#[test]
fn nothing_is_learned_when_she_did_not_actually_speak() {
    let mut rig = Rig::standard();
    let ctx = text_ctx("c1");
    let last = rig.chat(&ctx, t0());
    let now = at(last, 20 * MIN);
    assert_eq!(rig.tick(now).len(), 1);
    // The agent stayed silent (e.g. channel muted); humans chat on.
    rig.say(&ctx, "a", at(now, 30));
    rig.tick(at(now, 11 * MIN));
    let last = rig.chat(&ctx, at(now, 30 * MIN));
    assert_eq!(rig.tick(at(last, 20 * MIN)).len(), 1);
}

#[test]
fn unanswered_nudge_blocks_another_nudge_in_the_same_context() {
    let mut rig = Rig::new(InitiativeConfig {
        idle_after_secs: 120,
        busy_window_secs: 30,
        ..Default::default()
    });
    let ctx = text_ctx("c1");
    let last = rig.chat(&ctx, t0());
    assert_eq!(rig.tick(at(last, 120)).len(), 1);
    // Humans chat on and she gets the last word: the nudge is still unanswered.
    let start = at(last, 130);
    for i in 0..5 {
        rig.say(&ctx, ["a", "b"][i % 2], at(start, 10 * i as i64));
    }
    rig.say_as_me(&ctx, at(start, 50));
    assert!(rig.tick(at(start, 50 + 120)).is_empty());
    // Window over: it may nudge again once things get quiet again.
    rig.tick(at(last, 14 * MIN));
    let last3 = rig.chat(&ctx, at(last, 15 * MIN));
    assert_eq!(rig.tick(at(last3, 120)).len(), 1);
}

#[test]
fn backoff_decays_over_days() {
    let mut rig = Rig::standard();
    let ctx = text_ctx("c1");
    ignored_initiative(&mut rig, &ctx, t0());
    // A day later it is back to normal.
    let day_later = at(t0(), 24 * 3600 + 3600);
    let last = rig.chat(&ctx, day_later);
    assert_eq!(rig.tick(at(last, 20 * MIN)).len(), 1);
}

#[test]
fn counters_and_backoff_survive_a_snapshot() {
    let cfg = InitiativeConfig {
        max_per_context_per_day: 2,
        ..Default::default()
    };
    let mut rig = Rig::new(cfg.clone());
    let ctx = text_ctx("c1");
    let t = ignored_initiative(&mut rig, &ctx, t0());
    let snapshot = rig.eng.take_snapshot().expect("state changed");
    assert!(rig.eng.take_snapshot().is_none());
    let json = serde_json::to_value(&snapshot).unwrap();

    let mut rig = Rig::new(cfg);
    rig.eng.restore(serde_json::from_value(json).unwrap());
    // Backoff (40 minutes) is kept.
    let last = rig.chat(&ctx, at(t, 20 * MIN));
    assert!(rig.tick(at(last, 39 * MIN)).is_empty());
    assert_eq!(rig.tick(at(last, 40 * MIN)).len(), 1);
    // That was the second one today: the cap of two is exhausted.
    rig.tick(at(last, 52 * MIN));
    let last = rig.chat(&ctx, at(last, 60 * MIN));
    assert!(rig.tick(at(last, 90 * MIN)).is_empty());
}

// --- greeting ---------------------------------------------------------

#[test]
fn friend_is_greeted_on_first_message_of_the_day() {
    let mut rig = Rig::standard();
    rig.social.set("a", "朋友", 80.0);
    let ctx = text_ctx("c1");
    let out = rig.say(&ctx, "a", t0());
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].context, ctx);
    assert_eq!(out[0].reason, "greeting");
    assert_eq!(out[0].hint, "跟他打招呼");
    assert_eq!(out[0].about, [acct("a")]);
    // Once per day, whichever channel.
    assert!(rig.say(&ctx, "a", at(t0(), MIN)).is_empty());
    assert!(rig.say(&text_ctx("c2"), "a", at(t0(), 2 * MIN)).is_empty());
    // Next morning again.
    let next = at(t0(), 24 * 3600);
    assert_eq!(reasons(&rig.say(&ctx, "a", next)), ["greeting"]);
}

#[test]
fn greeting_day_starts_at_day_start_hour() {
    let mut rig = Rig::standard();
    rig.social.set("a", "朋友", 80.0);
    let ctx = text_ctx("c1");
    // 22:00 local.
    assert_eq!(rig.say(&ctx, "a", at(t0(), 10 * 3600)).len(), 1);
    // 00:30 local: same day as far as greetings go.
    assert!(
        rig.say(&ctx, "a", at(t0(), 12 * 3600 + 30 * MIN))
            .is_empty()
    );
    // 04:30 local.
    assert_eq!(rig.say(&ctx, "a", at(t0(), 16 * 3600 + 30 * MIN)).len(), 1);
}

#[test]
fn only_friends_are_greeted() {
    let mut rig = Rig::standard();
    rig.social.set("stranger", "陌生人", 5.0);
    rig.social.set("blocked", "朋友", 80.0);
    rig.social.block("blocked");
    let ctx = text_ctx("c1");
    assert!(rig.say(&ctx, "stranger", t0()).is_empty());
    assert!(rig.say(&ctx, "blocked", at(t0(), 300)).is_empty());
    assert!(rig.say(&ctx, "unknown", at(t0(), 600)).is_empty());
    // Becoming a friend later the same day does not trigger a late greeting.
    rig.social.set("stranger", "朋友", 60.0);
    assert!(rig.say(&ctx, "stranger", at(t0(), 900)).is_empty());
}

#[test]
fn greeting_needs_social_signals_and_can_be_disabled() {
    let mut eng = Engine::new(InitiativeConfig::default());
    let ctx = text_ctx("c1");
    let sig = Signals::default();
    eng.observe(t0(), &ready(), &sig);
    assert!(
        eng.observe(t0(), &message(&ctx, "a", false, t0()), &sig)
            .is_empty()
    );

    let mut rig = Rig::new(InitiativeConfig {
        greeting: false,
        ..Default::default()
    });
    rig.social.set("a", "朋友", 80.0);
    assert!(rig.say(&ctx, "a", t0()).is_empty());
}

#[test]
fn greeting_waits_when_others_are_mid_conversation() {
    let mut rig = Rig::standard();
    rig.social.set("a", "朋友", 80.0);
    let ctx = text_ctx("c1");
    rig.say(&ctx, "b", t0());
    assert!(rig.say(&ctx, "a", at(t0(), 30)).is_empty());
    // It does not come back later in the day either: the first message is gone.
    assert!(rig.say(&ctx, "a", at(t0(), 20 * MIN)).is_empty());
}

// --- voice join -------------------------------------------------------

#[test]
fn voice_join_greets_new_arrivals_with_good_affinity() {
    let mut rig = Rig::standard();
    rig.social.set("a", "路人", 5.0);
    rig.social.set("b", "路人", 50.0);
    rig.social.set("c", "朋友", 10.0);
    let v = voice_ctx("v1");
    // People already there when she joins are not greeted.
    assert!(
        rig.event(t0(), &voice_joined(&v, &["me", "a", "b"]))
            .is_empty()
    );
    let out = rig.event(at(t0(), 30), &voice_members(&v, &["me", "a", "b", "c"]));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].context, v);
    assert_eq!(out[0].reason, "voice_join");
    assert_eq!(out[0].about, [acct("c")]);
    // Nothing for someone with too little affinity.
    rig.tick(at(t0(), 15 * MIN));
    rig.social.set("d", "陌生人", 0.0);
    assert!(
        rig.event(
            at(t0(), 16 * MIN),
            &voice_members(&v, &["me", "a", "b", "c", "d"])
        )
        .is_empty()
    );
}

#[test]
fn voice_join_greets_several_arrivals_at_once() {
    let mut rig = Rig::standard();
    rig.social.set("a", "路人", 50.0);
    rig.social.set("b", "路人", 50.0);
    let v = voice_ctx("v1");
    rig.event(t0(), &voice_joined(&v, &["me"]));
    let out = rig.event(at(t0(), 5), &voice_members(&v, &["me", "a", "b"]));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].about, [acct("a"), acct("b")]);
}

#[test]
fn voice_join_has_a_cooldown_per_person() {
    let mut rig = Rig::standard();
    rig.social.set("a", "路人", 50.0);
    let v = voice_ctx("v1");
    rig.event(t0(), &voice_joined(&v, &["me"]));
    assert_eq!(rig.event(t0(), &voice_members(&v, &["me", "a"])).len(), 1);
    rig.tick(at(t0(), 11 * MIN));
    rig.event(at(t0(), 12 * MIN), &voice_members(&v, &["me"]));
    assert!(
        rig.event(at(t0(), 15 * MIN), &voice_members(&v, &["me", "a"]))
            .is_empty()
    );
    rig.event(at(t0(), 16 * MIN), &voice_members(&v, &["me"]));
    assert_eq!(
        rig.event(at(t0(), 35 * MIN), &voice_members(&v, &["me", "a"]))
            .len(),
        1
    );
}

#[test]
fn voice_join_counts_as_the_greeting_of_the_day() {
    let mut rig = Rig::standard();
    rig.social.set("a", "朋友", 50.0);
    let v = voice_ctx("v1");
    rig.event(t0(), &voice_joined(&v, &["me"]));
    assert_eq!(rig.event(t0(), &voice_members(&v, &["me", "a"])).len(), 1);
    assert!(rig.say(&text_ctx("c1"), "a", at(t0(), 5 * MIN)).is_empty());
}

#[test]
fn voice_join_ignores_blocked_and_disabled() {
    let mut rig = Rig::standard();
    rig.social.set("a", "朋友", 90.0);
    rig.social.block("a");
    let v = voice_ctx("v1");
    rig.event(t0(), &voice_joined(&v, &["me"]));
    assert!(rig.event(t0(), &voice_members(&v, &["me", "a"])).is_empty());

    let mut rig = Rig::new(InitiativeConfig {
        voice_join: false,
        ..Default::default()
    });
    rig.social.set("a", "朋友", 90.0);
    rig.event(t0(), &voice_joined(&v, &["me"]));
    assert!(rig.event(t0(), &voice_members(&v, &["me", "a"])).is_empty());
}

// --- followup ---------------------------------------------------------

#[test]
fn followup_is_brought_up_where_the_person_is() {
    let mut rig = Rig::standard();
    let pid = rig.social.set("a", "路人", 10.0);
    let f = followup(Some(pid), Some(text_ctx("home")));
    // Not around yet.
    assert!(rig.plan(t0(), &f).is_none());
    let other = text_ctx("elsewhere");
    rig.say(&other, "a", t0());
    let e = rig.plan(at(t0(), 30), &f).unwrap();
    assert_eq!(e.context, other);
    assert_eq!(e.reason, "followup");
    assert_eq!(e.hint, "你說今天要考試,考得怎樣?");
    assert_eq!(e.about, [acct("a")]);
}

#[test]
fn followup_prefers_its_own_context_and_needs_recent_activity() {
    let mut rig = Rig::standard();
    let pid = rig.social.set("a", "路人", 10.0);
    rig.social.set_person("a2", pid, "路人", 10.0);
    let home = text_ctx("home");
    let other = text_ctx("other");
    rig.say(&home, "a", t0());
    rig.say(&other, "a2", at(t0(), 60));
    let f = followup(Some(pid), Some(home.clone()));
    let e = rig.plan(at(t0(), 3 * MIN), &f).unwrap();
    assert_eq!(e.context, home);
    assert_eq!(e.about, [acct("a")]);

    // Long gone: nothing.
    let mut rig = Rig::standard();
    let pid = rig.social.set("a", "路人", 10.0);
    rig.say(&home, "a", t0());
    let f = followup(Some(pid), Some(home));
    assert!(rig.plan(at(t0(), 10 * MIN + 1), &f).is_none());
}

#[test]
fn followup_reaches_a_person_who_joined_voice() {
    let mut rig = Rig::standard();
    let pid = rig.social.set("a", "陌生人", 0.0);
    let v = voice_ctx("v1");
    rig.event(t0(), &voice_joined(&v, &["me"]));
    rig.event(at(t0(), 5), &voice_members(&v, &["me", "a"]));
    let f = followup(Some(pid), Some(text_ctx("home")));
    let e = rig.plan(at(t0(), 20 * MIN), &f).unwrap();
    assert_eq!(e.context, v);
    assert_eq!(e.about, [acct("a")]);
}

#[test]
fn followup_without_a_person_uses_its_context() {
    let mut rig = Rig::standard();
    let ctx = text_ctx("home");
    let f = followup(None, Some(ctx.clone()));
    assert!(rig.plan(t0(), &f).is_none());
    rig.say(&ctx, "x", t0());
    let e = rig.plan(at(t0(), MIN), &f).unwrap();
    assert_eq!(e.context, ctx);
    assert!(e.about.is_empty());
    // Without a context there is nowhere to go.
    let mut rig = Rig::standard();
    rig.say(&ctx, "x", t0());
    assert!(rig.plan(at(t0(), MIN), &followup(None, None)).is_none());
}

#[test]
fn followup_respects_caps_and_opt_outs_and_stays_due() {
    let mut rig = Rig::new(InitiativeConfig {
        disabled_contexts: vec!["off".into()],
        max_per_context_per_day: 1,
        ..Default::default()
    });
    let pid = rig.social.set("a", "路人", 10.0);
    let f = followup(Some(pid), None);
    rig.say(&text_ctx("off"), "a", t0());
    assert!(rig.plan(at(t0(), 30), &f).is_none());
    // Active in a second context as well: that one is used.
    let on = text_ctx("on");
    rig.say(&on, "a", at(t0(), 60));
    assert_eq!(rig.plan(at(t0(), 3 * MIN), &f).unwrap().context, on);
    // Per-context cap used up.
    assert!(rig.plan(at(t0(), 4 * MIN), &f).is_none());

    // No social service: a person cannot be resolved.
    let mut eng = Engine::new(InitiativeConfig::default());
    let sig = Signals::default();
    eng.observe(t0(), &message(&on, "a", false, t0()), &sig);
    assert!(eng.plan_followup(at(t0(), 30), &f, &sig).is_none());
}

#[test]
fn followup_can_be_switched_off() {
    let mut rig = Rig::new(InitiativeConfig {
        followup: false,
        ..Default::default()
    });
    let ctx = text_ctx("home");
    rig.say(&ctx, "x", t0());
    assert!(
        rig.plan(at(t0(), MIN), &followup(None, Some(ctx)))
            .is_none()
    );
}

// --- module (paused time, fake services) -------------------------------

struct Harness {
    sup: Supervisor,
    events: Subscription,
    social: Arc<FakeSocial>,
    followups: Arc<FakeFollowups>,
    store: Store,
}

impl Harness {
    async fn new(config: serde_json::Value) -> Self {
        Self::build(config, Store::memory(), t0()).await
    }

    async fn build(config: serde_json::Value, store: Store, start: DateTime<Utc>) -> Self {
        let sup = Supervisor::new(EventBus::default(), Arc::new(ServiceRegistry::new()));
        let owner = ModuleId::from("app");
        let social = Arc::new(FakeSocial::default());
        let followups = Arc::new(FakeFollowups::default());
        sup.services()
            .provide::<dyn SocialSignals>(&owner, social.clone());
        sup.services()
            .provide::<dyn FollowupSource>(&owner, followups.clone());
        sup.services()
            .provide::<dyn SettingsStore>(&owner, store.settings.clone());
        let events = sup.bus().subscribe(TopicFilter::new(["agent.initiative"]));
        let module = InitiativeModule::new(ProfileId::from("p"))
            .with_clock(Arc::new(TokioClock::new(start)));
        sup.register(Arc::new(module), config, true).await;
        sup.start_all().await.unwrap();
        let h = Self {
            sup,
            events,
            social,
            followups,
            store,
        };
        h.publish(ready()).await;
        h
    }

    async fn publish(&self, event: Event) {
        self.sup.bus().publish(&ModuleId::from("test"), event, None);
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    /// Time as the module sees it.
    async fn say(&self, ctx: &ContextKey, who: &str) {
        self.publish(message(ctx, who, false, t0())).await;
    }

    async fn say_as_me(&self, ctx: &ContextKey) {
        self.publish(message(ctx, "me", true, t0())).await;
    }

    async fn chat(&self, ctx: &ContextKey) {
        for who in ["a", "me", "b", "me", "a", "b"] {
            if who == "me" {
                self.say_as_me(ctx).await;
            } else {
                self.say(ctx, who).await;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    async fn next(&mut self) -> Option<(ContextKey, String, String, Vec<AccountRef>)> {
        let env = tokio::time::timeout(Duration::from_millis(10), self.events.recv())
            .await
            .ok()??;
        match &env.event {
            Event::AgentInitiative {
                context,
                reason,
                hint,
                about,
            } => Some((context.clone(), reason.clone(), hint.clone(), about.clone())),
            other => panic!("unexpected event {other:?}"),
        }
    }
}

fn sleep_min(m: u64) -> impl std::future::Future<Output = ()> {
    tokio::time::sleep(Duration::from_secs(m * 60))
}

#[tokio::test(start_paused = true)]
async fn module_idle_channel() {
    let mut h = Harness::new(serde_json::Value::Null).await;
    let ctx = text_ctx("c1");
    h.chat(&ctx).await;
    sleep_min(15).await;
    assert!(h.next().await.is_none());
    sleep_min(10).await;
    let (context, reason, hint, about) = h.next().await.expect("idle initiative");
    assert_eq!(context, ctx);
    assert_eq!(reason, "idle_channel");
    assert_eq!(hint, "頻道冷掉了,可以找點話題");
    assert!(about.is_empty());
    sleep_min(60).await;
    assert!(h.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn module_greeting() {
    let mut h = Harness::new(serde_json::Value::Null).await;
    h.social.set("a", "朋友", 70.0);
    h.social.set("s", "陌生人", 0.0);
    let ctx = text_ctx("c1");
    h.say(&ctx, "s").await;
    assert!(h.next().await.is_none());
    sleep_min(3).await;
    h.say(&ctx, "a").await;
    let (context, reason, hint, about) = h.next().await.expect("greeting");
    assert_eq!(
        (context, reason.as_str(), hint.as_str()),
        (ctx.clone(), "greeting", "跟他打招呼")
    );
    assert_eq!(about, [acct("a")]);
    h.say(&ctx, "a").await;
    assert!(h.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn module_voice_join() {
    let mut h = Harness::new(serde_json::Value::Null).await;
    h.social.set("a", "路人", 60.0);
    let v = voice_ctx("v1");
    h.publish(voice_joined(&v, &["me"])).await;
    assert!(h.next().await.is_none());
    h.publish(voice_members(&v, &["me", "a"])).await;
    let (context, reason, _, about) = h.next().await.expect("voice join greeting");
    assert_eq!((context, reason.as_str()), (v, "voice_join"));
    assert_eq!(about, [acct("a")]);
}

#[tokio::test(start_paused = true)]
async fn module_followup_polled_every_minute() {
    let mut h = Harness::new(serde_json::Value::Null).await;
    let pid = h.social.set("a", "路人", 10.0);
    let home = text_ctx("home");
    *h.followups.due.lock() = vec![followup(Some(pid), Some(home.clone()))];
    // Person not around: it stays due.
    sleep_min(3).await;
    assert!(h.next().await.is_none());
    assert!(h.followups.done.lock().is_empty());
    // She shows up; the next poll brings it up and marks it done.
    h.say(&home, "a").await;
    sleep_min(1).await;
    let (context, reason, hint, about) = h.next().await.expect("followup");
    assert_eq!((context, reason.as_str()), (home, "followup"));
    assert_eq!(hint, "你說今天要考試,考得怎樣?");
    assert_eq!(about, [acct("a")]);
    assert_eq!(*h.followups.done.lock(), ["f1"]);
    sleep_min(3).await;
    assert!(h.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn module_backoff_after_an_ignored_initiative() {
    let mut h = Harness::new(serde_json::Value::Null).await;
    let ctx = text_ctx("c1");
    h.chat(&ctx).await;
    sleep_min(21).await;
    assert!(h.next().await.is_some());
    // She speaks; nobody answers within the reply window.
    h.say_as_me(&ctx).await;
    sleep_min(12).await;
    h.chat(&ctx).await;
    sleep_min(30).await;
    assert!(h.next().await.is_none(), "threshold should have doubled");
    sleep_min(11).await;
    assert!(h.next().await.is_some());
}

#[tokio::test(start_paused = true)]
async fn module_quiet_hours() {
    // 00:50 local; quiet 01:00-07:00.
    let start = Utc.with_ymd_and_hms(2025, 3, 9, 16, 50, 0).unwrap();
    let mut h = Harness::build(
        serde_json::json!({ "idle_max_secs": 36000 }),
        Store::memory(),
        start,
    )
    .await;
    let ctx = text_ctx("c1");
    h.chat(&ctx).await;
    sleep_min(60).await;
    assert!(h.next().await.is_none());
    // 07:00 local.
    sleep_min(5 * 60 + 15).await;
    assert!(h.next().await.is_some());
}

#[tokio::test(start_paused = true)]
async fn module_respects_disabled_contexts_and_caps_from_config() {
    let mut h = Harness::new(serde_json::json!({
        "disabled_contexts": ["off"],
        "max_per_context_per_day": 1,
    }))
    .await;
    let off = text_ctx("off");
    let on = text_ctx("on");
    h.chat(&off).await;
    h.chat(&on).await;
    sleep_min(25).await;
    let (context, ..) = h.next().await.expect("one initiative");
    assert_eq!(context, on);
    assert!(h.next().await.is_none());
    // Cap of one per day: a second conversation gets nothing.
    sleep_min(15).await;
    h.chat(&on).await;
    sleep_min(30).await;
    assert!(h.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn module_persists_counters_across_restarts() {
    let config = serde_json::json!({ "max_per_context_per_day": 1 });
    let mut h = Harness::new(config.clone()).await;
    let ctx = text_ctx("c1");
    h.chat(&ctx).await;
    sleep_min(25).await;
    assert!(h.next().await.is_some());
    let saved = h
        .store
        .settings
        .get(&ProfileId::from(crate::STATE_PROFILE), crate::STATE_KEY)
        .await
        .unwrap();
    assert!(saved.is_some(), "state was not persisted");
    let store = h.store.clone();
    h.sup.stop_all().await;

    // A restart later the same day remembers the day's budget.
    let start = at(t0(), 60 * MIN);
    let mut h = Harness::build(config, store, start).await;
    h.chat(&ctx).await;
    sleep_min(30).await;
    assert!(h.next().await.is_none());
}
