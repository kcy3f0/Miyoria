import { toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { Engine, emissionEvent, SnapshotSchema } from "../src/index.js";
import {
  acct,
  at,
  cfgWith,
  FakeMood,
  followup,
  MIN,
  message,
  Rig,
  ready,
  reasons,
  T0,
  textCtx,
  voiceCtx,
  voiceJoined,
  voiceMembers,
} from "./helpers.js";

// --- idle_channel ---

describe("idle_channel", () => {
  it("idle_channel_fires_once_after_threshold", () => {
    const rig = Rig.standard();
    const ctx = textCtx("c1");
    const last = rig.chat(ctx, T0);
    expect(rig.tick(at(last, 19 * MIN))).toEqual([]);
    const out = rig.tick(at(last, 20 * MIN));
    expect(out).toHaveLength(1);
    expect(out[0]?.context).toEqual(ctx);
    expect(out[0]?.reason).toBe("idle_channel");
    expect(out[0]?.hint).toBe("頻道冷掉了,可以找點話題");
    expect(out[0]?.about).toEqual([]);
    expect(rig.tick(at(last, 21 * MIN))).toEqual([]);
    expect(rig.tick(at(last, 60 * MIN))).toEqual([]);
  });

  it("idle_channel_needs_a_lively_conversation_she_took_part_in", () => {
    const rig = Rig.standard();
    // Lively, but she never spoke.
    const quiet = textCtx("no-her");
    let last = T0;
    for (let i = 0; i < 8; i++) {
      last = at(T0, 10 * i);
      rig.say(quiet, i % 2 === 0 ? "a" : "b", last);
    }
    expect(rig.tick(at(last, 30 * MIN))).toEqual([]);

    // She spoke, but the conversation was too short.
    const short = textCtx("short");
    rig.say(short, "a", T0);
    rig.sayAsMe(short, at(T0, 10));
    rig.say(short, "a", at(T0, 20));
    expect(rig.tick(at(T0, 30 * MIN))).toEqual([]);
  });

  it("idle_channel_gives_up_after_idle_max", () => {
    const rig = Rig.standard();
    const last = rig.chat(textCtx("c1"), T0);
    expect(rig.tick(at(last, 3 * 3600 + 1))).toEqual([]);
    expect(rig.tick(at(last, 3 * 3600 + 2))).toEqual([]);
  });

  it("idle_channel_can_be_switched_off", () => {
    const rig = new Rig(cfgWith({ idle_channel: false }));
    const last = rig.chat(textCtx("c1"), T0);
    expect(rig.tick(at(last, 25 * MIN))).toEqual([]);
  });

  it("a_new_conversation_after_a_gap_starts_from_scratch", () => {
    const rig = Rig.standard();
    const ctx = textCtx("c1");
    // Three messages, a long gap, three more: neither segment is lively.
    ["a", "me", "b"].forEach((who, i) => {
      const t = at(T0, 10 * i);
      if (who === "me") rig.sayAsMe(ctx, t);
      else rig.say(ctx, who, t);
    });
    const later = at(T0, 25 * MIN);
    rig.say(ctx, "a", later);
    rig.sayAsMe(ctx, at(later, 10));
    rig.say(ctx, "b", at(later, 20));
    expect(rig.tick(at(later, 40 * MIN))).toEqual([]);
  });

  it("voice_idle_requires_her_to_be_in_the_channel_with_someone", () => {
    let rig = Rig.standard();
    const v = voiceCtx("v1");
    rig.event(T0, voiceJoined(v, ["me", "a"]));
    let last = T0;
    for (let i = 0; i < 6; i++) {
      last = at(T0, 10 * i);
      const who = ["a", "me"][i % 2] as string;
      rig.event(last, {
        type: "voice_utterance",
        data: {
          id: `u${i}`,
          context: v,
          speaker: { account: acct(who), display_name: who, is_bot: false },
          text: "...",
          language: null,
          emotion: null,
          audio_events: [],
          started_at: toTimestamp(last),
          ended_at: toTimestamp(last),
          asr_ms: 0,
        },
      });
    }
    const out = rig.tick(at(last, 20 * MIN));
    expect(out).toHaveLength(1);
    expect(out[0]?.context).toEqual(v);
    expect(out[0]?.hint).toBe("語音頻道安靜下來了,可以找點話題");

    // Same conversation, but everybody left: nothing to say to.
    rig = Rig.standard();
    rig.event(T0, voiceJoined(v, ["me", "a"]));
    for (let i = 0; i < 6; i++) {
      const t = at(T0, 10 * i);
      if (i % 2 === 0) rig.say(v, "a", t);
      else rig.sayAsMe(v, t);
    }
    rig.event(at(T0, 60), voiceMembers(v, ["me"]));
    expect(rig.tick(at(T0, 25 * MIN))).toEqual([]);
    // She left the channel altogether.
    rig.event(at(T0, 61), { type: "voice_left", data: { context: v, reason: null } });
    expect(rig.tick(at(T0, 30 * MIN))).toEqual([]);
  });

  it("bots_are_not_conversation", () => {
    const rig = Rig.standard();
    rig.social.set("bot1", "朋友", 90);
    const ctx = textCtx("c1");
    expect(rig.event(T0, message(ctx, "bot1", true, T0))).toEqual([]);
    let last = T0;
    for (let i = 0; i < 8; i++) {
      last = at(T0, i);
      rig.event(last, message(ctx, "bot1", true, last));
    }
    rig.sayAsMe(ctx, last);
    expect(rig.tick(at(last, 30 * MIN))).toEqual([]);
  });
});

// --- budget ---

describe("budget", () => {
  it("per_context_daily_cap_resets_next_day", () => {
    const rig = new Rig(cfgWith({ max_per_context_per_day: 2 }));
    const ctx = textCtx("c1");
    let t = T0;
    const fired: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [out, next] = rig.cycle(ctx, t);
      fired.push(out.length);
      t = next;
    }
    expect(fired).toEqual([1, 1, 0, 0]);
    // Another context is unaffected.
    expect(rig.cycle(textCtx("c2"), t)[0]).toHaveLength(1);
    // The next day the cap is fresh.
    expect(rig.cycle(ctx, at(T0, 24 * 3600))[0]).toHaveLength(1);
  });

  it("global_daily_cap_spans_contexts", () => {
    const rig = new Rig(cfgWith({ max_per_day: 2 }));
    let t = T0;
    let fired = 0;
    for (const ch of ["c1", "c2", "c3"]) {
      const [out, next] = rig.cycle(textCtx(ch), t);
      fired += out.length;
      t = next;
    }
    expect(fired).toBe(2);
    expect(rig.cycle(textCtx("c3"), at(T0, 24 * 3600))[0]).toHaveLength(1);
  });

  it("day_rolls_over_at_day_start_hour", () => {
    const rig = new Rig(
      cfgWith({ max_per_context_per_day: 1, quiet_start_hour: 0, quiet_end_hour: 0 }),
    );
    const ctx = textCtx("c1");
    // 23:00 local.
    expect(rig.cycle(ctx, at(T0, 11 * 3600))[0]).toHaveLength(1);
    // 02:00 local the next calendar day is still the same "day".
    expect(rig.cycle(ctx, at(T0, 14 * 3600))[0]).toEqual([]);
    // 05:00 local is a new one.
    expect(rig.cycle(ctx, at(T0, 17 * 3600))[0]).toHaveLength(1);
  });

  it("never_interrupts_an_active_conversation", () => {
    const rig = Rig.standard();
    const ctx = textCtx("c1");
    const last = rig.chat(ctx, T0);
    // Followup for a person while others are chatting.
    const pid = rig.social.set("p", "路人", 10);
    const f = followup(pid, ctx);
    rig.say(ctx, "p", at(last, 60));
    rig.say(ctx, "b", at(last, 70));
    expect(rig.plan(at(last, 80), f)).toBeNull();
    // Two minutes later it is a lull, and she is still around.
    const e = rig.plan(at(last, 70 + 2 * MIN + 1), f);
    expect(e?.reason).toBe("followup");
  });

  it("her_own_recent_message_counts_as_active", () => {
    const rig = Rig.standard();
    rig.social.set("a", "朋友", 80);
    const ctx = textCtx("c1");
    rig.sayAsMe(ctx, T0);
    // The friend's first message arrives right after she spoke.
    expect(rig.say(ctx, "a", at(T0, 5))).toEqual([]);
  });

  it("disabled_contexts_get_nothing", () => {
    const rig = new Rig(cfgWith({ disabled_contexts: ["discord:g:c1", "c2"] }));
    rig.social.set("a", "朋友", 80);
    for (const ch of ["c1", "c2"]) {
      const ctx = textCtx(ch);
      const last = rig.chat(ctx, T0);
      expect(rig.tick(at(last, 30 * MIN)), ch).toEqual([]);
      expect(rig.say(ctx, "fresh", at(last, 40 * MIN))).toEqual([]);
    }
    // Greetings are blocked as well; other channels are fine.
    rig.social.set("z", "朋友", 80);
    rig.social.set("y", "朋友", 80);
    expect(rig.say(textCtx("c2"), "z", at(T0, 3600))).toEqual([]);
    expect(rig.say(textCtx("c3"), "y", at(T0, 3600 + 1))).toHaveLength(1);
    expect(rig.cycle(textCtx("c3"), at(T0, 7200))[0]).toHaveLength(1);
  });

  it("quiet_hours_stop_idle_nudges_until_morning", () => {
    // 00:50 local (16:50 UTC the day before).
    const start = Date.UTC(2025, 2, 9, 16, 50, 0);
    const rig = new Rig(cfgWith({ idle_max_secs: 10 * 3600 }));
    const ctx = textCtx("c1");
    const last = rig.chat(ctx, start);
    // 01:10 local and 03:00 local: quiet.
    expect(rig.tick(at(last, 25 * MIN))).toEqual([]);
    expect(rig.tick(at(last, 2 * 3600 + 10 * MIN))).toEqual([]);
    // 07:00 local: quiet hours are over and the conversation is still recent enough.
    expect(reasons(rig.tick(at(last, 6 * 3600 + 10 * MIN)))).toEqual(["idle_channel"]);
  });

  it("quiet_hours_wrap_around_midnight", () => {
    const start = Date.UTC(2025, 2, 10, 14, 50, 0); // 22:50 local
    let rig = new Rig(cfgWith({ quiet_start_hour: 22, quiet_end_hour: 6 }));
    const ctx = textCtx("c1");
    let last = rig.chat(ctx, start);
    expect(rig.tick(at(last, 25 * MIN))).toEqual([]);
    // Disabled when start == end.
    rig = new Rig(cfgWith({ quiet_start_hour: 5, quiet_end_hour: 5 }));
    last = rig.chat(ctx, start);
    expect(rig.tick(at(last, 25 * MIN))).toHaveLength(1);
  });

  it("quiet_hours_do_not_stop_reactions_to_a_present_friend", () => {
    const night = Date.UTC(2025, 2, 9, 18, 0, 0); // 02:00 local
    const rig = Rig.standard();
    rig.social.set("a", "朋友", 80);
    expect(reasons(rig.say(textCtx("c1"), "a", night))).toEqual(["greeting"]);
  });

  it("mood_energy_scales_the_idle_threshold", () => {
    for (const [energy, minutes] of [
      [1.0, 10],
      [0.5, 20],
      [0.0, 40],
    ] as const) {
      const rig = Rig.standard();
      rig.mood = new FakeMood(energy);
      const ctx = textCtx("c1");
      const last = rig.chat(ctx, T0);
      expect(rig.tick(at(last, minutes * MIN - 1)), `energy ${energy}`).toEqual([]);
      expect(rig.tick(at(last, minutes * MIN)), `energy ${energy}`).toHaveLength(1);
    }
  });
});

// --- adaptive backoff ---

/** Conversation, idle initiative, she speaks, nobody replies, window passes. */
function ignoredInitiative(rig: Rig, ctx: ReturnType<typeof textCtx>, start: number): number {
  const last = rig.chat(ctx, start);
  const t = at(last, 20 * MIN);
  expect(rig.tick(t)).toHaveLength(1);
  rig.sayAsMe(ctx, at(t, 5));
  rig.tick(at(t, 5 + 10 * MIN + 1));
  return at(t, 11 * MIN);
}

describe("adaptive backoff", () => {
  it("ignored_initiative_doubles_the_idle_threshold", () => {
    const rig = Rig.standard();
    const ctx = textCtx("c1");
    const t = ignoredInitiative(rig, ctx, T0);
    let last = rig.chat(ctx, at(t, 20 * MIN));
    expect(rig.tick(at(last, 39 * MIN))).toEqual([]);
    expect(rig.tick(at(last, 40 * MIN))).toHaveLength(1);
    // Ignored again: 80 minutes.
    rig.sayAsMe(ctx, at(last, 41 * MIN));
    rig.tick(at(last, 52 * MIN));
    last = rig.chat(ctx, at(last, 60 * MIN));
    expect(rig.tick(at(last, 79 * MIN))).toEqual([]);
    expect(rig.tick(at(last, 80 * MIN))).toHaveLength(1);
  });

  it("backoff_is_capped", () => {
    const rig = new Rig(
      cfgWith({
        max_backoff_doublings: 1,
        max_per_context_per_day: 100,
        max_per_day: 100,
        quiet_start_hour: 0,
        quiet_end_hour: 0,
      }),
    );
    const ctx = textCtx("c1");
    let t = T0;
    for (let i = 0; i < 3; i++) {
      const last = rig.chat(ctx, t);
      // Past 40 minutes it always fires, however often it was ignored.
      const now = at(last, 40 * MIN);
      expect(rig.tick(now)).toHaveLength(1);
      rig.sayAsMe(ctx, at(now, 5));
      rig.tick(at(now, 5 + 10 * MIN + 1));
      t = at(now, 12 * MIN);
    }
    const last = rig.chat(ctx, t);
    expect(rig.tick(at(last, 39 * MIN))).toEqual([]);
    expect(rig.tick(at(last, 40 * MIN))).toHaveLength(1);
  });

  it("a_reply_relaxes_the_backoff", () => {
    const rig = Rig.standard();
    const ctx = textCtx("c1");
    const t = ignoredInitiative(rig, ctx, T0);
    // Second initiative at 40 minutes; this time somebody answers.
    let last = rig.chat(ctx, at(t, 20 * MIN));
    const now = at(last, 40 * MIN);
    expect(rig.tick(now)).toHaveLength(1);
    rig.sayAsMe(ctx, at(now, 5));
    rig.say(ctx, "a", at(now, 30));
    // Back to 20 minutes.
    last = rig.chat(ctx, at(now, 60 * MIN));
    expect(rig.tick(at(last, 20 * MIN))).toHaveLength(1);
  });

  it("nothing_is_learned_when_she_did_not_actually_speak", () => {
    const rig = Rig.standard();
    const ctx = textCtx("c1");
    let last = rig.chat(ctx, T0);
    const now = at(last, 20 * MIN);
    expect(rig.tick(now)).toHaveLength(1);
    // The agent stayed silent (e.g. channel muted); humans chat on.
    rig.say(ctx, "a", at(now, 30));
    rig.tick(at(now, 11 * MIN));
    last = rig.chat(ctx, at(now, 30 * MIN));
    expect(rig.tick(at(last, 20 * MIN))).toHaveLength(1);
  });

  it("unanswered_nudge_blocks_another_nudge_in_the_same_context", () => {
    const rig = new Rig(cfgWith({ idle_after_secs: 120, busy_window_secs: 30 }));
    const ctx = textCtx("c1");
    const last = rig.chat(ctx, T0);
    expect(rig.tick(at(last, 120))).toHaveLength(1);
    // Humans chat on and she gets the last word: the nudge is still unanswered.
    const start = at(last, 130);
    for (let i = 0; i < 5; i++) rig.say(ctx, ["a", "b"][i % 2] as string, at(start, 10 * i));
    rig.sayAsMe(ctx, at(start, 50));
    expect(rig.tick(at(start, 50 + 120))).toEqual([]);
    // Window over: it may nudge again once things get quiet again.
    rig.tick(at(last, 14 * MIN));
    const last3 = rig.chat(ctx, at(last, 15 * MIN));
    expect(rig.tick(at(last3, 120))).toHaveLength(1);
  });

  it("backoff_decays_over_days", () => {
    const rig = Rig.standard();
    const ctx = textCtx("c1");
    ignoredInitiative(rig, ctx, T0);
    // A day later it is back to normal.
    const dayLater = at(T0, 24 * 3600 + 3600);
    const last = rig.chat(ctx, dayLater);
    expect(rig.tick(at(last, 20 * MIN))).toHaveLength(1);
  });

  it("counters_and_backoff_survive_a_snapshot", () => {
    const cfg = cfgWith({ max_per_context_per_day: 2 });
    let rig = new Rig(cfg);
    const ctx = textCtx("c1");
    const t = ignoredInitiative(rig, ctx, T0);
    const snapshot = rig.eng.takeSnapshot();
    expect(snapshot).not.toBeNull();
    expect(rig.eng.takeSnapshot()).toBeNull();
    const json = JSON.parse(JSON.stringify(snapshot));

    rig = new Rig(cfg);
    rig.eng.restore(SnapshotSchema.parse(json));
    // Backoff (40 minutes) is kept.
    let last = rig.chat(ctx, at(t, 20 * MIN));
    expect(rig.tick(at(last, 39 * MIN))).toEqual([]);
    expect(rig.tick(at(last, 40 * MIN))).toHaveLength(1);
    // That was the second one today: the cap of two is exhausted.
    rig.tick(at(last, 52 * MIN));
    last = rig.chat(ctx, at(last, 60 * MIN));
    expect(rig.tick(at(last, 90 * MIN))).toEqual([]);
  });

  it("snapshot_json_mirrors_the_rust_serde_shape", () => {
    const rig = Rig.standard();
    rig.social.set("a", "朋友", 80);
    rig.say(textCtx("c1"), "a", T0);
    const snap = JSON.parse(JSON.stringify(rig.eng.takeSnapshot()));
    // chrono `num_days_from_ce` of 2025-03-10 (day starts at 04:00 local, 12:00 local here).
    expect(snap.global).toEqual({ day: 739320, count: 1 });
    expect(snap.contexts).toEqual([
      {
        context: textCtx("c1"),
        count: { day: 739320, count: 1 },
        backoff_level: 0,
        backoff_at: null,
      },
    ]);
    expect(snap.seen).toEqual([[acct("a"), 739320]]);
  });
});

// --- greeting ---

describe("greeting", () => {
  it("friend_is_greeted_on_first_message_of_the_day", () => {
    const rig = Rig.standard();
    rig.social.set("a", "朋友", 80);
    const ctx = textCtx("c1");
    const out = rig.say(ctx, "a", T0);
    expect(out).toHaveLength(1);
    expect(out[0]?.context).toEqual(ctx);
    expect(out[0]?.reason).toBe("greeting");
    expect(out[0]?.hint).toBe("跟他打招呼");
    expect(out[0]?.about).toEqual([acct("a")]);
    // Once per day, whichever channel.
    expect(rig.say(ctx, "a", at(T0, MIN))).toEqual([]);
    expect(rig.say(textCtx("c2"), "a", at(T0, 2 * MIN))).toEqual([]);
    // Next morning again.
    const next = at(T0, 24 * 3600);
    expect(reasons(rig.say(ctx, "a", next))).toEqual(["greeting"]);
  });

  it("good_friend_label_counts_as_friend", () => {
    const rig = Rig.standard();
    rig.social.set("a", "好朋友", 80);
    expect(reasons(rig.say(textCtx("c1"), "a", T0))).toEqual(["greeting"]);
  });

  it("greeting_day_starts_at_day_start_hour", () => {
    const rig = Rig.standard();
    rig.social.set("a", "朋友", 80);
    const ctx = textCtx("c1");
    // 22:00 local.
    expect(rig.say(ctx, "a", at(T0, 10 * 3600))).toHaveLength(1);
    // 00:30 local: same day as far as greetings go.
    expect(rig.say(ctx, "a", at(T0, 12 * 3600 + 30 * MIN))).toEqual([]);
    // 04:30 local.
    expect(rig.say(ctx, "a", at(T0, 16 * 3600 + 30 * MIN))).toHaveLength(1);
  });

  it("only_friends_are_greeted", () => {
    const rig = Rig.standard();
    rig.social.set("stranger", "陌生人", 5);
    rig.social.set("blocked", "朋友", 80);
    rig.social.block("blocked");
    const ctx = textCtx("c1");
    expect(rig.say(ctx, "stranger", T0)).toEqual([]);
    expect(rig.say(ctx, "blocked", at(T0, 300))).toEqual([]);
    expect(rig.say(ctx, "unknown", at(T0, 600))).toEqual([]);
    // Becoming a friend later the same day does not trigger a late greeting.
    rig.social.set("stranger", "朋友", 60);
    expect(rig.say(ctx, "stranger", at(T0, 900))).toEqual([]);
  });

  it("greeting_needs_social_signals_and_can_be_disabled", () => {
    const eng = new Engine(cfgWith());
    const ctx = textCtx("c1");
    eng.observe(T0, ready(), {});
    expect(eng.observe(T0, message(ctx, "a", false, T0), {})).toEqual([]);

    const rig = new Rig(cfgWith({ greeting: false }));
    rig.social.set("a", "朋友", 80);
    expect(rig.say(ctx, "a", T0)).toEqual([]);
  });

  it("greeting_waits_when_others_are_mid_conversation", () => {
    const rig = Rig.standard();
    rig.social.set("a", "朋友", 80);
    const ctx = textCtx("c1");
    rig.say(ctx, "b", T0);
    expect(rig.say(ctx, "a", at(T0, 30))).toEqual([]);
    // It does not come back later in the day either: the first message is gone.
    expect(rig.say(ctx, "a", at(T0, 20 * MIN))).toEqual([]);
  });
});

// --- voice join ---

describe("voice join", () => {
  it("voice_join_greets_new_arrivals_with_good_affinity", () => {
    const rig = Rig.standard();
    rig.social.set("a", "路人", 5);
    rig.social.set("b", "路人", 50);
    rig.social.set("c", "朋友", 10);
    const v = voiceCtx("v1");
    // People already there when she joins are not greeted.
    expect(rig.event(T0, voiceJoined(v, ["me", "a", "b"]))).toEqual([]);
    const out = rig.event(at(T0, 30), voiceMembers(v, ["me", "a", "b", "c"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.context).toEqual(v);
    expect(out[0]?.reason).toBe("voice_join");
    expect(out[0]?.hint).toBe("他剛進語音頻道,跟他打個招呼");
    expect(out[0]?.about).toEqual([acct("c")]);
    // Nothing for someone with too little affinity.
    rig.tick(at(T0, 15 * MIN));
    rig.social.set("d", "陌生人", 0);
    expect(rig.event(at(T0, 16 * MIN), voiceMembers(v, ["me", "a", "b", "c", "d"]))).toEqual([]);
  });

  it("voice_join_greets_several_arrivals_at_once", () => {
    const rig = Rig.standard();
    rig.social.set("a", "路人", 50);
    rig.social.set("b", "路人", 50);
    const v = voiceCtx("v1");
    rig.event(T0, voiceJoined(v, ["me"]));
    const out = rig.event(at(T0, 5), voiceMembers(v, ["me", "a", "b"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.hint).toBe("他們剛進語音頻道,跟大家打個招呼");
    expect(out[0]?.about).toEqual([acct("a"), acct("b")]);
  });

  it("voice_join_has_a_cooldown_per_person", () => {
    const rig = Rig.standard();
    rig.social.set("a", "路人", 50);
    const v = voiceCtx("v1");
    rig.event(T0, voiceJoined(v, ["me"]));
    expect(rig.event(T0, voiceMembers(v, ["me", "a"]))).toHaveLength(1);
    rig.tick(at(T0, 11 * MIN));
    rig.event(at(T0, 12 * MIN), voiceMembers(v, ["me"]));
    expect(rig.event(at(T0, 15 * MIN), voiceMembers(v, ["me", "a"]))).toEqual([]);
    rig.event(at(T0, 16 * MIN), voiceMembers(v, ["me"]));
    expect(rig.event(at(T0, 35 * MIN), voiceMembers(v, ["me", "a"]))).toHaveLength(1);
  });

  it("voice_join_counts_as_the_greeting_of_the_day", () => {
    const rig = Rig.standard();
    rig.social.set("a", "朋友", 50);
    const v = voiceCtx("v1");
    rig.event(T0, voiceJoined(v, ["me"]));
    expect(rig.event(T0, voiceMembers(v, ["me", "a"]))).toHaveLength(1);
    expect(rig.say(textCtx("c1"), "a", at(T0, 5 * MIN))).toEqual([]);
  });

  it("voice_join_ignores_blocked_and_disabled", () => {
    let rig = Rig.standard();
    rig.social.set("a", "朋友", 90);
    rig.social.block("a");
    const v = voiceCtx("v1");
    rig.event(T0, voiceJoined(v, ["me"]));
    expect(rig.event(T0, voiceMembers(v, ["me", "a"]))).toEqual([]);

    rig = new Rig(cfgWith({ voice_join: false }));
    rig.social.set("a", "朋友", 90);
    rig.event(T0, voiceJoined(v, ["me"]));
    expect(rig.event(T0, voiceMembers(v, ["me", "a"]))).toEqual([]);
  });
});

// --- followup ---

describe("followup", () => {
  it("followup_is_brought_up_where_the_person_is", () => {
    const rig = Rig.standard();
    const pid = rig.social.set("a", "路人", 10);
    const f = followup(pid, textCtx("home"));
    // Not around yet.
    expect(rig.plan(T0, f)).toBeNull();
    const other = textCtx("elsewhere");
    rig.say(other, "a", T0);
    const e = rig.plan(at(T0, 30), f);
    expect(e?.context).toEqual(other);
    expect(e?.reason).toBe("followup");
    expect(e?.hint).toBe("你說今天要考試,考得怎樣?");
    expect(e?.about).toEqual([acct("a")]);
  });

  it("followup_prefers_its_own_context_and_needs_recent_activity", () => {
    let rig = Rig.standard();
    let pid = rig.social.set("a", "路人", 10);
    rig.social.setPerson("a2", pid, "路人", 10);
    const home = textCtx("home");
    const other = textCtx("other");
    rig.say(home, "a", T0);
    rig.say(other, "a2", at(T0, 60));
    let f = followup(pid, home);
    const e = rig.plan(at(T0, 3 * MIN), f);
    expect(e?.context).toEqual(home);
    expect(e?.about).toEqual([acct("a")]);

    // Long gone: nothing.
    rig = Rig.standard();
    pid = rig.social.set("a", "路人", 10);
    rig.say(home, "a", T0);
    f = followup(pid, home);
    expect(rig.plan(at(T0, 10 * MIN + 1), f)).toBeNull();
  });

  it("followup_reaches_a_person_who_joined_voice", () => {
    const rig = Rig.standard();
    const pid = rig.social.set("a", "陌生人", 0);
    const v = voiceCtx("v1");
    rig.event(T0, voiceJoined(v, ["me"]));
    rig.event(at(T0, 5), voiceMembers(v, ["me", "a"]));
    const f = followup(pid, textCtx("home"));
    const e = rig.plan(at(T0, 20 * MIN), f);
    expect(e?.context).toEqual(v);
    expect(e?.about).toEqual([acct("a")]);
  });

  it("followup_without_a_person_uses_its_context", () => {
    let rig = Rig.standard();
    const ctx = textCtx("home");
    const f = followup(null, ctx);
    expect(rig.plan(T0, f)).toBeNull();
    rig.say(ctx, "x", T0);
    const e = rig.plan(at(T0, MIN), f);
    expect(e?.context).toEqual(ctx);
    expect(e?.about).toEqual([]);
    // Without a context there is nowhere to go.
    rig = Rig.standard();
    rig.say(ctx, "x", T0);
    expect(rig.plan(at(T0, MIN), followup(null, null))).toBeNull();
  });

  it("followup_respects_caps_and_opt_outs_and_stays_due", () => {
    const rig = new Rig(cfgWith({ disabled_contexts: ["off"], max_per_context_per_day: 1 }));
    const pid = rig.social.set("a", "路人", 10);
    const f = followup(pid, null);
    rig.say(textCtx("off"), "a", T0);
    expect(rig.plan(at(T0, 30), f)).toBeNull();
    // Active in a second context as well: that one is used.
    const on = textCtx("on");
    rig.say(on, "a", at(T0, 60));
    expect(rig.plan(at(T0, 3 * MIN), f)?.context).toEqual(on);
    // Per-context cap used up.
    expect(rig.plan(at(T0, 4 * MIN), f)).toBeNull();

    // No social service: a person cannot be resolved.
    const eng = new Engine(cfgWith());
    eng.observe(T0, message(on, "a", false, T0), {});
    expect(eng.planFollowup(at(T0, 30), f, {})).toBeNull();
  });

  it("followup_can_be_switched_off", () => {
    const rig = new Rig(cfgWith({ followup: false }));
    const ctx = textCtx("home");
    rig.say(ctx, "x", T0);
    expect(rig.plan(at(T0, MIN), followup(null, ctx))).toBeNull();
  });
});

describe("emission", () => {
  it("emission_event_is_the_agent_initiative_event", () => {
    const ctx = textCtx("c1");
    expect(
      emissionEvent({ context: ctx, reason: "greeting", hint: "h", about: [acct("a")] }),
    ).toEqual({
      type: "agent_initiative",
      data: { context: ctx, reason: "greeting", hint: "h", about: [acct("a")] },
    });
  });
});
