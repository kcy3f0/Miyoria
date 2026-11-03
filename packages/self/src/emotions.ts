// Her emotions (七情): discrete, coexisting, each 0..1 with its own half-life. Pure; `now`
// (epoch ms) is passed in.
//
// * Stirring saturates: `v + (1 - v) * min(amount * gain, 1)`, so a strong emotion grows
//   slower and never passes 1; calming subtracts. `gain` and the half-life are her temperament
//   (code defaults, overridden per profile by `[temperament]`).
// * Every emotion fades exponentially toward 0; below `floor` it is forgotten.
// * `affect` turns them into mood offsets (valence / arousal / energy) for the `mood` module.

import {
  type Affect,
  EMOTION_NAMES,
  type EmotionName,
  type EmotionReading,
  isJsonObject,
  type JsonValue,
  PERSON_EMOTION_NAMES,
  type PersonEmotionName,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";

const MINUTE_MS = 60_000;
const MAX_CAUSE = 80;

/** How one emotion rises and fades for her. */
export interface Temper {
  /** Multiplier of every stir (1 = ordinary). */
  gain: number;
  halfLifeMins: number;
}

export type DisplayRules = "open" | "tsundere";

/** Her temperament: her display rules and how each emotion behaves. */
export interface Temperament {
  display: DisplayRules;
  emotions: Record<EmotionName, Temper>;
  /** Emotions toward one person. */
  toward: Record<PersonEmotionName, Temper>;
}

/** The profile's `[temperament]` table (see `@miyoria/profile` `TemperamentSchema`). */
export interface TemperamentInput {
  display?: DisplayRules;
  emotions?: Record<string, { gain?: number | undefined; half_life_mins?: number | undefined }>;
}

/** Ordinary half-lives (minutes): surprise is gone in moments, missing lasts. */
export const BASE_HALF_LIFE_MINS: Readonly<Record<EmotionName, number>> = {
  joy: 30,
  anger: 15,
  sorrow: 120,
  fear: 20,
  surprise: 3,
  disgust: 30,
  shy: 10,
  pride: 30,
  jealousy: 90,
  lonely: 240,
  missing: 360,
  gratitude: 180,
  guilt: 180,
  frustration: 45,
};

/** Ordinary half-lives of emotions toward someone (minutes). */
export const BASE_TOWARD_HALF_LIFE_MINS: Readonly<Record<PersonEmotionName, number>> = {
  missing: 1440,
  jealousy: 180,
  gratitude: 1440,
  resentment: 480,
};

/**
 * Valence / arousal / energy per unit of each emotion (a full-strength emotion moves the mood
 * this much); summed, then bounded by `affect`.
 */
const AFFECT: Readonly<Record<EmotionName, readonly [number, number, number]>> = {
  joy: [0.5, 0.2, 0.1],
  anger: [-0.4, 0.5, 0],
  sorrow: [-0.5, -0.2, -0.15],
  fear: [-0.3, 0.4, 0],
  surprise: [0, 0.4, 0],
  disgust: [-0.3, 0.2, 0],
  shy: [0.1, 0.3, 0],
  pride: [0.4, 0.3, 0.05],
  jealousy: [-0.35, 0.3, 0],
  lonely: [-0.35, -0.2, -0.1],
  missing: [-0.2, -0.1, -0.05],
  gratitude: [0.35, 0.05, 0],
  guilt: [-0.3, 0.1, -0.05],
  frustration: [-0.3, 0.35, 0],
};
const MAX_VALENCE = 0.7;
const MAX_AROUSAL = 0.4;
const MAX_ENERGY = 0.3;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function isEmotion(name: string): name is EmotionName {
  return (EMOTION_NAMES as readonly string[]).includes(name);
}

export function isPersonEmotion(name: string): name is PersonEmotionName {
  return (PERSON_EMOTION_NAMES as readonly string[]).includes(name);
}

/** Her temperament from the profile's table; `unknown` lists names that are not emotions. */
export function temperament(input: TemperamentInput = {}): {
  temperament: Temperament;
  unknown: string[];
} {
  const emotions = Object.fromEntries(
    EMOTION_NAMES.map((n) => [n, { gain: 1, halfLifeMins: BASE_HALF_LIFE_MINS[n] }]),
  ) as Record<EmotionName, Temper>;
  const toward = Object.fromEntries(
    PERSON_EMOTION_NAMES.map((n) => [n, { gain: 1, halfLifeMins: BASE_TOWARD_HALF_LIFE_MINS[n] }]),
  ) as Record<PersonEmotionName, Temper>;
  const unknown: string[] = [];
  for (const [name, t] of Object.entries(input.emotions ?? {})) {
    const targets: Temper[] = [];
    if (isEmotion(name)) targets.push(emotions[name]);
    // The same name toward someone (想念, 嫉妒, 感激) rises like hers, at its own pace.
    if (isPersonEmotion(name)) targets.push(toward[name]);
    if (targets.length === 0) {
      unknown.push(name);
      continue;
    }
    for (const target of targets) {
      if (t.gain !== undefined && Number.isFinite(t.gain)) target.gain = Math.max(t.gain, 0);
      if (t.half_life_mins !== undefined && t.half_life_mins > 0) {
        target.halfLifeMins = t.half_life_mins;
      }
    }
  }
  return { temperament: { display: input.display ?? "open", emotions, toward }, unknown };
}

/** `v` stirred by `amount` (> 0, scaled by `gain`) or calmed (< 0). */
export function stir(v: number, amount: number, gain: number): number {
  if (!Number.isFinite(amount) || amount === 0) return clamp01(v);
  if (amount < 0) return clamp01(v + amount);
  return clamp01(v + (1 - v) * clamp01(amount * gain));
}

/** `v` after `ms` with a half-life of `halfLifeMins`. */
export function fade(v: number, ms: number, halfLifeMins: number): number {
  if (ms <= 0) return v;
  return v * 0.5 ** (ms / (Math.max(halfLifeMins, 0.01) * MINUTE_MS));
}

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

interface Slot {
  v: number;
  /** When it was last stirred. */
  at: number;
  cause: string;
  person: PersonId | null;
}

export class EmotionEngine {
  #slots = new Map<EmotionName, Slot>();
  #at: number;

  constructor(
    private readonly temper: Temperament,
    private readonly floor: number,
    now: number,
  ) {
    this.#at = now;
  }

  get temperament(): Temperament {
    return this.temper;
  }

  /** Fades every emotion up to `now`. */
  advance(now: number): void {
    const dt = now - this.#at;
    if (dt <= 0) return;
    for (const [name, slot] of this.#slots) {
      slot.v = fade(slot.v, dt, this.temper.emotions[name].halfLifeMins);
      if (slot.v < this.floor) this.#slots.delete(name);
    }
    this.#at = now;
  }

  /** Stirs (or calms) `name` at `now`. Returns the new intensity. */
  feel(
    name: EmotionName,
    amount: number,
    cause: string,
    person: PersonId | null,
    now: number,
  ): number {
    this.advance(now);
    const slot = this.#slots.get(name);
    const v = stir(slot?.v ?? 0, amount, this.temper.emotions[name].gain);
    if (v < this.floor) {
      this.#slots.delete(name);
      return 0;
    }
    if (amount > 0 || !slot) {
      this.#slots.set(name, { v, at: now, cause: cut(cause, MAX_CAUSE), person: person ?? null });
    } else {
      slot.v = v;
    }
    return v;
  }

  /**
   * Raises `name` to at least `v` (no temperament: `v` already is the level she feels);
   * never lowers it.
   */
  atLeast(name: EmotionName, v: number, cause: string, person: PersonId | null, now: number): void {
    this.advance(now);
    const level = clamp01(v);
    if (level < this.floor) return;
    const slot = this.#slots.get(name);
    if (slot && slot.v >= level) return;
    if (slot && slot.cause !== "" && slot.person === person) slot.v = level;
    else this.#slots.set(name, { v: level, at: now, cause: cut(cause, MAX_CAUSE), person });
  }

  /** One emotion's intensity at `now` (without changing the engine). */
  value(name: EmotionName, now: number): number {
    const slot = this.#slots.get(name);
    if (!slot) return 0;
    return fade(slot.v, now - this.#at, this.temper.emotions[name].halfLifeMins);
  }

  /** Emotions at or above `min` at `now`, strongest first (without changing the engine). */
  readings(now: number, min: number): EmotionReading[] {
    const out: EmotionReading[] = [];
    for (const [name, slot] of this.#slots) {
      const v = this.value(name, now);
      if (v < Math.max(min, this.floor)) continue;
      out.push({
        name,
        intensity: v,
        cause: slot.cause,
        at: toTimestamp(slot.at),
        person: slot.person,
      });
    }
    return out.sort((a, b) => b.intensity - a.intensity || (a.name < b.name ? -1 : 1));
  }

  /** Mood offsets of the emotions at `now` (bounded). */
  affect(now: number): Affect {
    let valence = 0;
    let arousal = 0;
    let energy = 0;
    for (const name of this.#slots.keys()) {
      const v = this.value(name, now);
      const [dv, da, de] = AFFECT[name];
      valence += dv * v;
      arousal += da * v;
      energy += de * v;
    }
    return {
      valence: clamp(valence, -MAX_VALENCE, MAX_VALENCE),
      arousal: clamp(arousal, -MAX_AROUSAL, MAX_AROUSAL),
      energy: clamp(energy, -MAX_ENERGY, MAX_ENERGY),
    };
  }

  toJson(): JsonValue {
    const out: Record<string, JsonValue> = {};
    for (const [name, s] of this.#slots) {
      out[name] = { v: s.v, at: toTimestamp(s.at), cause: s.cause, person: s.person };
    }
    return { at: toTimestamp(this.#at), emotions: out };
  }

  /** Restores a `toJson` value (lenient: unknown or malformed emotions are skipped). */
  restore(value: JsonValue | undefined, now: number): void {
    this.#slots.clear();
    this.#at = now;
    if (value === undefined || !isJsonObject(value) || !isJsonObject(value.emotions)) return;
    const at = typeof value.at === "string" ? Date.parse(value.at) : Number.NaN;
    this.#at = Number.isNaN(at) ? now : Math.min(at, now);
    for (const [name, raw] of Object.entries(value.emotions)) {
      if (!isEmotion(name) || !isJsonObject(raw) || typeof raw.v !== "number") continue;
      const stirred = typeof raw.at === "string" ? Date.parse(raw.at) : Number.NaN;
      this.#slots.set(name, {
        v: clamp01(raw.v),
        at: Number.isNaN(stirred) ? this.#at : stirred,
        cause: typeof raw.cause === "string" ? cut(raw.cause, MAX_CAUSE) : "",
        person: typeof raw.person === "string" ? raw.person : null,
      });
    }
    this.advance(now);
  }
}
