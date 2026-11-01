import type {
  AccountRef,
  Attitude,
  ContextKey,
  Event,
  Followup,
  FollowupSource,
  Mood,
  MoodSignals,
  SocialSignals,
  VoiceParticipant,
} from "@miyoria/types";
import { toTimestamp } from "@miyoria/types";
import { expect } from "vitest";
import type { InitiativeConfig } from "../src/index.js";
import { type Emission, Engine, InitiativeConfigSchema, type Signals } from "../src/index.js";

export const MIN = 60;

/** 2025-03-10 12:00 in UTC+8. */
export const T0 = Date.UTC(2025, 2, 10, 4, 0, 0);

export function at(base: number, secs: number): number {
  return base + secs * 1000;
}

export function cfgWith(overrides: Partial<InitiativeConfig> = {}): InitiativeConfig {
  return { ...InitiativeConfigSchema.parse({}), ...overrides };
}

export function acct(id: string): AccountRef {
  return { platform: "discord", id };
}

export function textCtx(channel: string): ContextKey {
  return { platform: "discord", scope: "g", channel, kind: "channel" };
}

export function voiceCtx(channel: string): ContextKey {
  return { ...textCtx(channel), kind: "voice" };
}

export function message(ctx: ContextKey, who: string, isBot: boolean, ts: number): Event {
  return {
    type: "platform_message_created",
    data: {
      id: { context: ctx, id: `${who}-${ts}` },
      author: { account: acct(who), display_name: who, is_bot: isBot },
      text: "hi",
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts: toTimestamp(ts),
    },
  };
}

export function ready(): Event {
  return { type: "platform_ready", data: { platform: "discord", self_account: acct("me") } };
}

export function participant(id: string): VoiceParticipant {
  return {
    account: acct(id),
    display_name: id,
    is_self: id === "me",
    muted: false,
    deafened: false,
  };
}

export function voiceJoined(ctx: ContextKey, ids: string[]): Event {
  return { type: "voice_joined", data: { context: ctx, participants: ids.map(participant) } };
}

export function voiceMembers(ctx: ContextKey, ids: string[]): Event {
  return { type: "voice_participants", data: { context: ctx, participants: ids.map(participant) } };
}

/** Fake `SocialSignals`; accounts without an entry are unknown. */
export class FakeSocial implements SocialSignals {
  readonly #map = new Map<string, Attitude>();
  #next = 0;

  set(id: string, label: string, affinity: number): string {
    const person = `person-${++this.#next}`;
    this.setPerson(id, person, label, affinity);
    return person;
  }

  setPerson(id: string, person: string, label: string, affinity: number): void {
    this.#map.set(id, {
      person,
      affinity,
      trust: 50,
      familiarity: 50,
      blocked: false,
      label,
      call_name: null,
    });
  }

  block(id: string): void {
    const a = this.#map.get(id);
    if (a) a.blocked = true;
  }

  attitude(account: AccountRef): Attitude | null {
    const a = this.#map.get(account.id);
    return a ? { ...a } : null;
  }
}

export class FakeMood implements MoodSignals {
  constructor(readonly energy: number) {}
  mood(): Mood {
    return { valence: 0, arousal: 0.5, energy: this.energy };
  }
}

export class FakeFollowups implements FollowupSource {
  due_: Followup[] = [];
  done: string[] = [];

  async due(): Promise<Followup[]> {
    return this.due_.filter((f) => !this.done.includes(f.id));
  }

  async markDone(id: string): Promise<void> {
    this.done.push(id);
  }
}

export function followup(person: string | null, context: ContextKey | null): Followup {
  return {
    id: "f1",
    profile: "p",
    person,
    context,
    about: "你說今天要考試,考得怎樣?",
    due: toTimestamp(T0),
  };
}

export class Rig {
  readonly eng: Engine;
  readonly social = new FakeSocial();
  mood: FakeMood | null = null;

  constructor(cfg: InitiativeConfig = cfgWith()) {
    this.eng = new Engine(cfg);
    this.event(T0, ready());
  }

  static standard(): Rig {
    return new Rig();
  }

  #signals(): Signals {
    return { social: this.social, mood: this.mood };
  }

  event(t: number, ev: Event): Emission[] {
    return this.eng.observe(t, ev, this.#signals());
  }

  tick(t: number): Emission[] {
    return this.eng.tick(t, this.#signals());
  }

  plan(t: number, f: Followup): Emission | null {
    return this.eng.planFollowup(t, f, { social: this.social, mood: null });
  }

  say(ctx: ContextKey, who: string, t: number): Emission[] {
    return this.event(t, message(ctx, who, false, t));
  }

  sayAsMe(ctx: ContextKey, t: number): void {
    expect(this.event(t, message(ctx, "me", true, t))).toEqual([]);
  }

  /** A lively conversation of six messages (two of them hers), 10 s apart. Returns the last time. */
  chat(ctx: ContextKey, start: number): number {
    const speakers = ["a", "me", "b", "me", "a", "b"];
    let t = start;
    speakers.forEach((who, i) => {
      t = at(start, 10 * i);
      if (who === "me") this.sayAsMe(ctx, t);
      else expect(this.say(ctx, who, t)).toEqual([]);
    });
    return t;
  }

  /**
   * A conversation, its idle initiative and the wait until the unanswered initiative is
   * settled. Returns the emissions and the time afterwards.
   */
  cycle(ctx: ContextKey, start: number): [Emission[], number] {
    const last = this.chat(ctx, start);
    const out = this.tick(at(last, 20 * MIN));
    this.tick(at(last, 32 * MIN));
    return [out, at(last, 33 * MIN)];
  }
}

export function reasons(e: Emission[]): string[] {
  return e.map((x) => x.reason);
}
