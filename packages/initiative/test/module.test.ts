import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  type Event,
  FollowupSourceKey,
  type JsonValue,
  SocialSignalsKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InitiativeModule, STATE_KEY, STATE_PROFILE } from "../src/index.js";
import {
  acct,
  FakeFollowups,
  FakeSocial,
  followup,
  message,
  ready,
  T0,
  textCtx,
  voiceCtx,
  voiceJoined,
  voiceMembers,
} from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

const minutes = (m: number) => m * 60_000;

class Harness {
  readonly sup = new Supervisor();
  readonly social = new FakeSocial();
  readonly followups = new FakeFollowups();
  readonly events = this.sup.bus.subscribe("agent.initiative");

  private constructor(readonly store: MemorySettingsStore) {}

  static async build(
    config: JsonValue | null = null,
    store = new MemorySettingsStore(),
  ): Promise<Harness> {
    const h = new Harness(store);
    h.sup.services.provide("app", SocialSignalsKey, h.social);
    h.sup.services.provide("app", FollowupSourceKey, h.followups);
    h.sup.services.provide("app", SettingsStoreKey, store);
    await h.sup.register(new InitiativeModule("p"), config, true);
    await h.sup.startAll();
    await h.publish(ready());
    return h;
  }

  async publish(event: Event): Promise<void> {
    this.sup.bus.publish("test", event);
    await vi.advanceTimersByTimeAsync(1);
  }

  async say(ctx: ContextKey, who: string): Promise<void> {
    await this.publish(message(ctx, who, false, Date.now()));
  }

  async sayAsMe(ctx: ContextKey): Promise<void> {
    await this.publish(message(ctx, "me", true, Date.now()));
  }

  async chat(ctx: ContextKey): Promise<void> {
    for (const who of ["a", "me", "b", "me", "a", "b"]) {
      if (who === "me") await this.sayAsMe(ctx);
      else await this.say(ctx, who);
      await vi.advanceTimersByTimeAsync(5000);
    }
  }

  next(): { context: ContextKey; reason: string; hint: string; about: AccountRef[] } | null {
    const env = this.events.tryRecv();
    if (!env) return null;
    if (env.event.type !== "agent_initiative")
      throw new Error(`unexpected event ${env.event.type}`);
    return env.event.data;
  }
}

async function start(at = T0): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime(at);
}

async function sleepMin(m: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(minutes(m));
}

describe("InitiativeModule", () => {
  it("module_idle_channel", async () => {
    await start();
    const h = await Harness.build();
    const ctx = textCtx("c1");
    await h.chat(ctx);
    await sleepMin(15);
    expect(h.next()).toBeNull();
    await sleepMin(10);
    const e = h.next();
    expect(e).not.toBeNull();
    expect(e?.context).toEqual(ctx);
    expect(e?.reason).toBe("idle_channel");
    expect(e?.hint).toBe("頻道冷掉了,可以找點話題");
    expect(e?.about).toEqual([]);
    await sleepMin(60);
    expect(h.next()).toBeNull();
    await h.sup.stopAll();
  });

  it("module_greeting", async () => {
    await start();
    const h = await Harness.build();
    h.social.set("a", "朋友", 70);
    h.social.set("s", "陌生人", 0);
    const ctx = textCtx("c1");
    await h.say(ctx, "s");
    expect(h.next()).toBeNull();
    await sleepMin(3);
    await h.say(ctx, "a");
    const e = h.next();
    expect(e).toMatchObject({ context: ctx, reason: "greeting", hint: "跟他打招呼" });
    expect(e?.about).toEqual([acct("a")]);
    await h.say(ctx, "a");
    expect(h.next()).toBeNull();
    await h.sup.stopAll();
  });

  it("module_voice_join", async () => {
    await start();
    const h = await Harness.build();
    h.social.set("a", "路人", 60);
    const v = voiceCtx("v1");
    await h.publish(voiceJoined(v, ["me"]));
    expect(h.next()).toBeNull();
    await h.publish(voiceMembers(v, ["me", "a"]));
    const e = h.next();
    expect(e).toMatchObject({ context: v, reason: "voice_join" });
    expect(e?.about).toEqual([acct("a")]);
    await h.sup.stopAll();
  });

  it("module_followup_polled_every_minute", async () => {
    await start();
    const h = await Harness.build();
    const pid = h.social.set("a", "路人", 10);
    const home = textCtx("home");
    h.followups.due_ = [followup(pid, home)];
    // Person not around: it stays due.
    await sleepMin(3);
    expect(h.next()).toBeNull();
    expect(h.followups.done).toEqual([]);
    // She shows up; the next poll brings it up and marks it done.
    await h.say(home, "a");
    await sleepMin(1);
    const e = h.next();
    expect(e).toMatchObject({
      context: home,
      reason: "followup",
      hint: "你說今天要考試,考得怎樣?",
    });
    expect(e?.about).toEqual([acct("a")]);
    expect(h.followups.done).toEqual(["f1"]);
    await sleepMin(3);
    expect(h.next()).toBeNull();
    await h.sup.stopAll();
  });

  it("module_backoff_after_an_ignored_initiative", async () => {
    await start();
    const h = await Harness.build();
    const ctx = textCtx("c1");
    await h.chat(ctx);
    await sleepMin(21);
    expect(h.next()).not.toBeNull();
    // She speaks; nobody answers within the reply window.
    await h.sayAsMe(ctx);
    await sleepMin(12);
    await h.chat(ctx);
    await sleepMin(30);
    expect(h.next(), "threshold should have doubled").toBeNull();
    await sleepMin(11);
    expect(h.next()).not.toBeNull();
    await h.sup.stopAll();
  });

  it("module_quiet_hours", async () => {
    // 00:50 local; quiet 01:00-07:00.
    await start(Date.UTC(2025, 2, 9, 16, 50, 0));
    const h = await Harness.build({ idle_max_secs: 36000 });
    const ctx = textCtx("c1");
    await h.chat(ctx);
    await sleepMin(60);
    expect(h.next()).toBeNull();
    // 07:00 local.
    await sleepMin(5 * 60 + 15);
    expect(h.next()).not.toBeNull();
    await h.sup.stopAll();
  });

  it("module_respects_disabled_contexts_and_caps_from_config", async () => {
    await start();
    const h = await Harness.build({ disabled_contexts: ["off"], max_per_context_per_day: 1 });
    const off = textCtx("off");
    const on = textCtx("on");
    await h.chat(off);
    await h.chat(on);
    await sleepMin(25);
    const e = h.next();
    expect(e?.context).toEqual(on);
    expect(h.next()).toBeNull();
    // Cap of one per day: a second conversation gets nothing.
    await sleepMin(15);
    await h.chat(on);
    await sleepMin(30);
    expect(h.next()).toBeNull();
    await h.sup.stopAll();
  });

  it("module_persists_counters_across_restarts", async () => {
    await start();
    const config = { max_per_context_per_day: 1 };
    let h = await Harness.build(config);
    const ctx = textCtx("c1");
    await h.chat(ctx);
    await sleepMin(25);
    expect(h.next()).not.toBeNull();
    const saved = await h.store.get(STATE_PROFILE, STATE_KEY);
    expect(saved, "state was not persisted").not.toBeNull();
    const store = h.store;
    await h.sup.stopAll();

    // A restart later the same day remembers the day's budget.
    h = await Harness.build(config, store);
    await h.chat(ctx);
    await sleepMin(30);
    expect(h.next()).toBeNull();
    await h.sup.stopAll();
  });

  it("module_rejects_an_invalid_config", async () => {
    await start();
    const sup = new Supervisor();
    await sup.register(new InitiativeModule("p"), { idle_after_secs: "soon" }, true);
    await sup.startAll();
    const status = sup.list().find((s) => s.id === "initiative");
    expect(status?.state).not.toBe("running");
    await sup.stopAll();
  });

  it("module_manifest_lists_optional_dependencies", () => {
    const m = new InitiativeModule("p").manifest;
    expect(m.id).toBe("initiative");
    expect(m.optional).toEqual(["memory", "social", "mood"]);
    expect(m.requires).toEqual([]);
  });

  it("module_stops_cleanly_and_publishes_nothing_afterwards", async () => {
    await start();
    const h = await Harness.build();
    const ctx = textCtx("c1");
    await h.chat(ctx);
    await h.sup.stopAll();
    await sleepMin(60);
    expect(h.next()).toBeNull();
    expect(h.sup.list().find((s) => s.id === "initiative")?.state).toBe("stopped");
  });
});
