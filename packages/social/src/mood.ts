// Module `mood`: her global mood.
//
// Valence / arousal / energy drift back to the profile baseline with an exponential decay,
// energy follows a time-of-day curve (low late at night) and events nudge it:
//
// * `social.relationship` (praise, insults, ... from the social module),
// * `agent.emotion` (her own emotion tags),
// * `mood.nudge` with `{"valence": .., "arousal": .., "energy": .., "reason": ..}` (all
//   optional; for games and extensions).
//
// Publishes `mood.changed` when the mood moved noticeably.

import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
  SerialQueue,
} from "@miyoria/kernel";
import type { MoodBaseline } from "@miyoria/profile";
import { type SettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type Clock,
  customEvent,
  type Event,
  isJsonObject,
  type JsonValue,
  type Mood,
  type MoodSignals,
  MoodSignalsKey,
  type ProfileId,
  type PromptContributor,
  type PromptContributors,
  PromptContributorsKey,
  type PromptRequest,
  type PromptSection,
  serviceKey,
  systemClock,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";

/** Settings key of the persisted mood. */
export const SETTINGS_KEY = "mood:last";
/** Bus topic published when the mood moved. */
export const TOPIC_CHANGED = "mood.changed";

/** `[modules.mood]` config section. */
export const MoodConfigSchema = z.object({
  /** Time for half of a deviation from the baseline to fade. */
  half_life_secs: z.number().default(1800),
  tick_secs: z.number().int().nonnegative().default(30),
  /** Publish `mood.changed` once any dimension moved this much. */
  publish_threshold: z.number().default(0.05),
  /** Her local time zone as a UTC offset. */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /** How much energy drops at the deepest point of the night (0..1). */
  night_dip: z.number().default(0.4),
  /** Remember the last mood across restarts (needs `SettingsStoreKey`). */
  persist: z.boolean().default(true),
  /** Valence change per affinity point of a social event. */
  social_weight: z.number().default(0.03),
  /** Largest change of one dimension by a single event. */
  max_nudge: z.number().default(0.2),
});

export type MoodConfig = z.output<typeof MoodConfigSchema>;

/** The defaults (`MoodConfig::default()`), optionally overridden. */
export function moodConfig(overrides: Partial<MoodConfig> = {}): MoodConfig {
  return { ...MoodConfigSchema.parse({}), ...overrides };
}

/** Sleepiness per local hour (0 = awake, 1 = deepest night), interpolated. */
const NIGHT_SHAPE = [
  0.5, 0.7, 0.85, 0.95, 1.0, 0.9, 0.65, 0.35, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.05, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.1, 0.2, 0.35,
] as const;

function shapeAt(i: number): number {
  return NIGHT_SHAPE[((i % 24) + 24) % 24] ?? 0;
}

/** Sleepiness at a fractional local hour (0..24). */
export function nightShape(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const frac = h - i;
  const cur = shapeAt(i);
  return cur + (shapeAt(i + 1) - cur) * frac;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function clampMood(m: Mood): Mood {
  const fix = (v: number, lo: number, hi: number) =>
    Number.isFinite(v) ? clamp(v, lo, hi) : Math.max(lo, 0);
  return {
    valence: fix(m.valence, -1, 1),
    arousal: fix(m.arousal, 0, 1),
    energy: fix(m.energy, 0, 1),
  };
}

/** Pure mood dynamics; `now` (epoch ms) is passed in. */
export class MoodEngine {
  #baseline: Mood;
  #current: Mood;
  #at: number;
  readonly #config: MoodConfig;

  constructor(baseline: MoodBaseline, config: MoodConfig, now: number) {
    this.#baseline = clampMood({
      valence: baseline.valence,
      arousal: baseline.arousal,
      energy: baseline.energy,
    });
    this.#config = config;
    this.#at = now;
    this.#current = this.#baseline;
    this.#current = this.target(now);
  }

  baseline(): Mood {
    return { ...this.#baseline };
  }

  current(): Mood {
    return { ...this.#current };
  }

  clone(): MoodEngine {
    const copy = new MoodEngine(this.#baseline, this.#config, this.#at);
    copy.#current = this.#current;
    return copy;
  }

  #localHour(now: number): number {
    const minutes = this.#config.utc_offset_minutes;
    const offset = Math.abs(minutes) < 24 * 60 ? minutes : 0;
    const local = Math.floor((now + offset * 60_000) / 60_000);
    const minuteOfDay = ((local % 1440) + 1440) % 1440;
    return minuteOfDay / 60;
  }

  /** Where the mood drifts to at `now` (baseline shaped by the time of day). */
  target(now: number): Mood {
    const dip = clamp(this.#config.night_dip, 0, 1) * nightShape(this.#localHour(now));
    return clampMood({
      valence: this.#baseline.valence,
      arousal: this.#baseline.arousal * (1 - 0.5 * dip),
      energy: this.#baseline.energy * (1 - dip),
    });
  }

  /** The mood at `now` without changing the engine. */
  peek(now: number): Mood {
    const copy = this.clone();
    copy.advance(now);
    return copy.current();
  }

  /** Decays toward the target up to `now`. */
  advance(now: number): void {
    const dt = Math.trunc(now - this.#at);
    if (dt <= 0) return;
    const secs = dt / 1000;
    const halfLife = Math.max(this.#config.half_life_secs, 1);
    const alpha = 1 - 0.5 ** (secs / halfLife);
    const target = this.target(now);
    const step = (cur: number, tgt: number) => cur + (tgt - cur) * alpha;
    this.#current = clampMood({
      valence: step(this.#current.valence, target.valence),
      arousal: step(this.#current.arousal, target.arousal),
      energy: step(this.#current.energy, target.energy),
    });
    this.#at = now;
  }

  /** Adds a change (each dimension limited to `max_nudge`) at `now`. */
  nudge(now: number, valence: number, arousal: number, energy: number): void {
    this.advance(now);
    const max = Math.abs(this.#config.max_nudge);
    const lim = (v: number) => (Number.isFinite(v) ? clamp(v, -max, max) : 0);
    this.#current = clampMood({
      valence: this.#current.valence + lim(valence),
      arousal: this.#current.arousal + lim(arousal),
      energy: this.#current.energy + lim(energy),
    });
  }

  /** Restores a saved mood from `at` and decays it to `now`. */
  restore(mood: Mood, at: number, now: number): void {
    this.#current = clampMood(mood);
    this.#at = Math.min(at, now);
    this.advance(now);
  }
}

/** `[valence, arousal, energy]` nudge for one of her emotion tags. */
export function emotionNudge(emotion: string): [number, number, number] | null {
  switch (emotion.trim().toLowerCase()) {
    case "happy":
      return [0.06, 0.04, 0];
    case "smug":
      return [0.04, 0.02, 0];
    case "embarrassed":
      return [0.02, 0.05, 0];
    case "surprised":
      return [0, 0.06, 0];
    case "annoyed":
      return [-0.03, 0.03, 0];
    case "angry":
      return [-0.06, 0.08, 0];
    case "sad":
      return [-0.06, -0.03, -0.02];
    default:
      return null;
  }
}

function num(v: JsonValue, key: string): number {
  if (!isJsonObject(v)) return 0;
  const x = v[key];
  return typeof x === "number" ? x : 0;
}

function str(v: JsonValue, key: string): string | null {
  if (!isJsonObject(v)) return null;
  const x = v[key];
  return typeof x === "string" ? x : null;
}

/** A nudge with a short reason. */
export interface MoodNudge {
  valence: number;
  arousal: number;
  energy: number;
  reason: string;
}

/** The nudge an event causes, if any. */
export function eventNudge(event: Event, config: MoodConfig): MoodNudge | null {
  if (event.type !== "custom") return null;
  const { topic, payload } = event.data;
  switch (topic) {
    case "social.relationship": {
      const kind = str(payload, "kind");
      if (kind === null) return null;
      const affinity = num(payload, "affinity");
      if (Math.abs(affinity) < 1e-6) return null;
      const hostile = kind === "insult" || kind === "harassment" || kind === "flirt_too_far";
      return {
        valence: affinity * config.social_weight,
        arousal: Math.abs(affinity) * 0.01 + (hostile ? 0.05 : 0),
        energy: 0,
        reason: `social: ${kind}`,
      };
    }
    case "agent.emotion": {
      const emotion = str(payload, "emotion");
      if (emotion === null) return null;
      const n = emotionNudge(emotion);
      if (n === null) return null;
      return { valence: n[0], arousal: n[1], energy: n[2], reason: `emotion: ${emotion}` };
    }
    case "mood.nudge":
      return {
        valence: num(payload, "valence"),
        arousal: num(payload, "arousal"),
        energy: num(payload, "energy"),
        reason: str(payload, "reason") ?? "nudge",
      };
    default:
      return null;
  }
}

/** One-line hint for the prompt. */
export function describe(m: Mood): string {
  let v: string;
  if (m.valence >= 0.5) v = "心情很好";
  else if (m.valence >= 0.2) v = "心情不錯";
  else if (m.valence > -0.2) v = "心情普通";
  else if (m.valence > -0.5) v = "有點不爽";
  else v = "心情很差";
  let e: string;
  if (m.energy < 0.3) e = "很睏";
  else if (m.energy < 0.5) e = "有點累";
  else if (m.energy > 0.85) e = "精神很好";
  else e = "精神還可以";
  let a = "";
  if (m.arousal > 0.75) a = ",情緒有點激動";
  else if (m.arousal < 0.25) a = ",很平靜";
  return `你現在${v}、${e}${a}。語氣可以自然帶出來,但不用直接說出自己的心情。`;
}

/** Shared mood state. Provided as `MoodStateKey` and `MoodSignalsKey`. */
export class MoodState implements MoodSignals {
  readonly engine: MoodEngine;
  #lastPublished: Mood;
  readonly #threshold: number;
  readonly #config: MoodConfig;
  readonly #clock: Clock;

  constructor(baseline: MoodBaseline, config: MoodConfig, now: number, clock: Clock = systemClock) {
    this.engine = new MoodEngine(baseline, config, now);
    this.#lastPublished = this.engine.current();
    this.#threshold = Math.abs(config.publish_threshold);
    this.#config = config;
    this.#clock = clock;
  }

  at(now: number): Mood {
    return this.engine.peek(now);
  }

  /** Applies an event. Returns the new mood when it should be published. */
  handle(event: Event, now: number): { mood: Mood; reason: string } | null {
    const n = eventNudge(event, this.#config);
    if (n === null) return null;
    this.engine.nudge(now, n.valence, n.arousal, n.energy);
    const mood = this.#changed(now);
    return mood === null ? null : { mood, reason: n.reason };
  }

  /** Advances the decay. Returns the new mood when it should be published. */
  tick(now: number): Mood | null {
    this.engine.advance(now);
    return this.#changed(now);
  }

  #changed(now: number): Mood | null {
    const current = this.engine.peek(now);
    const last = this.#lastPublished;
    const moved = Math.max(
      Math.abs(current.valence - last.valence),
      Math.abs(current.arousal - last.arousal),
      Math.abs(current.energy - last.energy),
    );
    if (moved < this.#threshold) return null;
    this.#lastPublished = current;
    return current;
  }

  /** Restores `{"valence", "arousal", "energy", "at"}` as saved by `toJson`. */
  restoreJson(value: JsonValue, now: number): void {
    const rawAt = str(value, "at");
    let at = now;
    if (rawAt !== null) {
      const ms = Date.parse(rawAt);
      if (!Number.isNaN(ms)) at = ms;
    }
    const mood: Mood = {
      valence: num(value, "valence"),
      arousal: num(value, "arousal"),
      energy: num(value, "energy"),
    };
    this.engine.restore(mood, at, now);
    this.#lastPublished = this.engine.current();
  }

  toJson(now: number): JsonValue {
    const m = this.at(now);
    return { valence: m.valence, arousal: m.arousal, energy: m.energy, at: toTimestamp(now) };
  }

  mood(): Mood {
    return this.at(this.#clock.now());
  }
}

/** The service key of the shared mood state (Rust `Arc<MoodState>`). */
export const MoodStateKey = serviceKey<MoodState>("MoodState");

/** Prompt contributor `mood`: one line about how she feels. */
export class MoodPrompt implements PromptContributor {
  static readonly KEY = "mood";
  readonly key = MoodPrompt.KEY;
  readonly #state: MoodState;

  constructor(state: MoodState) {
    this.#state = state;
  }

  async contribute(request: PromptRequest): Promise<PromptSection[]> {
    return [
      {
        key: MoodPrompt.KEY,
        title: "你現在的狀態",
        body: describe(this.#state.at(timestampMs(request.now))),
        order: 30,
      },
    ];
  }
}

interface Running {
  state: MoodState;
  store: SettingsStore | undefined;
  contributors: PromptContributors | undefined;
  ctx: ModuleContext;
  saves: SerialQueue;
}

/**
 * Module `mood`. Requires nothing; uses `SettingsStoreKey` and `PromptContributorsKey` when
 * present.
 */
export class MoodModule implements Module {
  static readonly ID = "mood";
  readonly manifest = defineManifest(MoodModule.ID, "Mood", {
    description: "Her mood: decays to the persona baseline, nudged by events",
    configSchema: MoodConfigSchema,
  });
  readonly #profile: ProfileId;
  readonly #baseline: MoodBaseline;
  #running: Running | null = null;

  /** `baseline` is `Profile.manifest.mood`. */
  constructor(profile: ProfileId, baseline: MoodBaseline) {
    this.#profile = profile;
    this.#baseline = { ...baseline };
  }

  async #save(ctx: ModuleContext, store: SettingsStore, state: MoodState): Promise<void> {
    try {
      await store.set(this.#profile, SETTINGS_KEY, state.toJson(ctx.clock.now()));
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error) }, "cannot persist mood");
    }
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(MoodConfigSchema);
    const now = ctx.clock.now();
    const state = new MoodState(this.#baseline, config, now, ctx.clock);
    const store = config.persist ? ctx.services.get(SettingsStoreKey) : undefined;
    if (store) {
      try {
        const saved = await store.get(this.#profile, SETTINGS_KEY);
        if (saved !== null) state.restoreJson(saved, now);
      } catch (error) {
        ctx.log.warn({ err: errorMessage(error) }, "cannot load saved mood");
      }
    }
    ctx.provide(MoodSignalsKey, state);
    ctx.provide(MoodStateKey, state);
    const contributors = ctx.services.get(PromptContributorsKey);
    contributors?.register(new MoodPrompt(state));
    const saves = new SerialQueue();
    this.#running = { state, store, contributors, ctx, saves };

    const changed = async (mood: Mood, reason: string) => {
      ctx.log.debug({ mood, reason }, "mood changed");
      ctx.publish(
        customEvent(TOPIC_CHANGED, {
          valence: mood.valence,
          arousal: mood.arousal,
          energy: mood.energy,
          reason,
        }),
      );
      if (store) await saves.run(() => this.#save(ctx, store, state));
    };

    const sub = ctx.subscribe(["social.relationship", "agent.emotion", "mood.nudge"]);
    ctx.spawn("mood", async () => {
      for await (const env of sub) {
        const result = state.handle(env.event, ctx.clock.now());
        if (result) await changed(result.mood, result.reason);
      }
    });
    ctx.spawn("tick", async (signal) => {
      for await (const _ of interval(Math.max(config.tick_secs, 1) * 1000, signal)) {
        const mood = state.tick(ctx.clock.now());
        if (mood) await changed(mood, "decay");
      }
    });
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.contributors?.unregister(MoodPrompt.KEY);
    const store = running.store;
    if (store) await running.saves.run(() => this.#save(running.ctx, store, running.state));
  }
}
