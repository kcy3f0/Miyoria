import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  ARBITER_DECISION_TOPIC,
  ARBITER_IMPULSE_TOPIC,
  type ArbiterDecision,
  ArbiterKey,
  type Attitude,
  type ContextKey,
  type Event,
  type Followup,
  type FollowupSource,
  FollowupSourceKey,
  ImpulseHostKey,
  type JsonValue,
  newImpulse,
  type SocialSignals,
  SocialSignalsKey,
  toTimestamp,
  type VoiceParticipant,
  v2Event,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArbiterModule, arbiterConfig, Producers, STATE_KEY, STATE_PROFILE } from "../src/index.js";
import { acct, FakeHost, MIN, T0, textCtx, voiceCtx } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

class FakeSocial implements SocialSignals {
  readonly map = new Map<string, Attitude>();
  set(id: string, label: string, affinity: number, person = `person-${id}`): void {
    this.map.set(id, {
      person,
      affinity,
      trust: 50,
      familiarity: 50,
      blocked: false,
      label,
      call_name: null,
    });
  }
  attitude(account: AccountRef): Attitude | null {
    return this.map.get(account.id) ?? null;
  }
}

class FakeFollowups implements FollowupSource {
  due_: Followup[] = [];
  done: string[] = [];
  async due(): Promise<Followup[]> {
    return this.due_.filter((f) => !this.done.includes(f.id));
  }
  async markDone(id: string): Promise<void> {
    this.done.push(id);
  }
}

function message(ctx: ContextKey, who: string, at: number, mentions = false): Event {
  return {
    type: "platform_message_created",
    data: {
      id: { context: ctx, id: `${who}-${at}` },
      author: { account: acct(who), display_name: who, is_bot: who === "me" },
      text: "hi",
      mentions_self: mentions,
      reply_to_self: false,
      attachments: [],
      ts: toTimestamp(at),
    },
  };
}

function participant(id: string): VoiceParticipant {
  return {
    account: acct(id),
    display_name: id,
    is_self: id === "me",
    muted: false,
    deafened: false,
  };
}

describe("Producers", () => {
  it("greets a friend once a day, not strangers", () => {
    const p = new Producers(arbiterConfig());
    const social = new FakeSocial();
    social.set("a", "朋友", 60);
    social.set("b", "普通", 10);
    const here = textCtx("c1");
    const first = p.observe(T0, message(here, "a", T0), social);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      source: "world",
      hint: "跟他打招呼",
      args: { reason: "greeting" },
    });
    expect(p.observe(T0 + MIN, message(here, "a", T0 + MIN), social)).toEqual([]);
    expect(p.observe(T0, message(here, "b", T0), social)).toEqual([]);
  });

  it("greets people with good affinity who join her voice channel", () => {
    const p = new Producers(arbiterConfig());
    const social = new FakeSocial();
    social.set("a", "普通", 40);
    const v = voiceCtx("v1");
    p.observe(
      T0,
      { type: "voice_joined", data: { context: v, participants: [participant("me")] } },
      social,
    );
    const out = p.observe(
      T0 + MIN,
      {
        type: "voice_participants",
        data: { context: v, participants: [participant("me"), participant("a")] },
      },
      social,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "world", args: { reason: "voice_join" } });
    expect(out[0]?.target.context).toEqual(v);
  });

  it("brings up a followup where the person is around", () => {
    const p = new Producers(arbiterConfig());
    const social = new FakeSocial();
    social.set("a", "朋友", 60, "person-a");
    const here = textCtx("c1");
    p.observe(T0, message(here, "a", T0), social);
    const f: Followup = {
      id: "f1",
      profile: "p",
      person: "person-a",
      context: null,
      about: "考試考得怎樣?",
      due: toTimestamp(T0),
    };
    const imp = p.followup(T0 + MIN, f, social);
    expect(imp).toMatchObject({ source: "followup", hint: "考試考得怎樣?" });
    expect(imp?.target.context).toEqual(here);
    expect(p.followup(T0 + 30 * MIN, f, social)).toBeNull();
  });
});

describe("ArbiterModule", () => {
  async function build(config: JsonValue | null = null, legacy: JsonValue | null = null) {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const sup = new Supervisor();
    const host = new FakeHost();
    const social = new FakeSocial();
    const followups = new FakeFollowups();
    const store = new MemorySettingsStore();
    sup.services.provide("app", ImpulseHostKey, host);
    sup.services.provide("app", SocialSignalsKey, social);
    sup.services.provide("app", FollowupSourceKey, followups);
    sup.services.provide("app", SettingsStoreKey, store);
    const decisions = sup.bus.subscribe(ARBITER_DECISION_TOPIC);
    await sup.register(new ArbiterModule("p", { legacyInitiative: legacy }), config, true);
    await sup.startAll();
    return { sup, host, social, followups, store, decisions };
  }

  it("provides ArbiterKey and takes impulses from the topic", async () => {
    const h = await build();
    const arbiter = h.sup.services.get(ArbiterKey);
    expect(arbiter).toBeDefined();
    const imp = newImpulse(
      { source: "song", context: textCtx("c1"), ttlMs: MIN, why: "報幕", reason: "song_start" },
      Date.now(),
    );
    h.sup.bus.publish("sing", v2Event(ARBITER_IMPULSE_TOPIC, imp));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.host.opened.map((i) => i.id)).toEqual([imp.id]);
    const env = h.decisions.tryRecv();
    expect(
      env?.event.type === "custom" && (env.event.data.payload as unknown as ArbiterDecision),
    ).toMatchObject({ impulse: imp.id, verdict: "accepted" });
    await h.sup.stopAll();
  });

  it("brings up due followups through the arbiter and marks them done", async () => {
    const h = await build();
    h.social.set("a", "朋友", 60, "person-a");
    h.followups.due_.push({
      id: "f1",
      profile: "p",
      person: "person-a",
      context: null,
      about: "考試考得怎樣?",
      due: toTimestamp(T0),
    });
    h.sup.bus.publish("test", message(textCtx("c1"), "a", Date.now()));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.host.opened.map((i) => i.source)).toEqual(["world", "followup"]);
    expect(h.followups.done).toEqual(["f1"]);
    await h.sup.stopAll();
    expect(await h.store.get(STATE_PROFILE, STATE_KEY)).not.toBeNull();
  });

  it("reads the old [modules.initiative] keys it replaced", async () => {
    const h = await build(
      { max_per_day: 7 },
      { max_per_day: 3, quiet_start_hour: 2, to_mind: true },
    );
    const limits = h.sup.services.get(ArbiterKey)?.ledger().limits;
    // Its own section wins; moved keys carry over.
    expect(limits?.initiative_cap).toBe(7);
    expect(limits?.quiet_hours?.start_hour).toBe(2);
    await h.sup.stopAll();
  });
});
