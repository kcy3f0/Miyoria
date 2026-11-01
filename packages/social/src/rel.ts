// Relationship arithmetic: event values, daily caps, diminishing returns, the owner floor and
// labels. Pure functions, no I/O.

import type { Relationship, RelationshipDelta } from "@miyoria/store";
import { type Timestamp, timestampMs, toTimestamp } from "@miyoria/types";
import type { SocialConfig } from "./config.js";

export const OWNER_TAG = "owner";
export const BLOCKED_TAG = "blocked";

const DAY_MS = 86_400_000;

/** Something a person did toward her (serialized snake_case, like the Rust enum). */
export type EventKind =
  | "greeting"
  | "thanks"
  | "praise"
  | "gift"
  | "friendly"
  | "apology"
  /** Overall positive tone judged by the LLM (`toward_her > 0`). */
  | "warm"
  /** Overall negative tone judged by the LLM (`toward_her < 0`). */
  | "cold"
  | "rude"
  | "insult"
  | "harassment"
  | "flirt_too_far";

/** Every kind, in declaration order (the Rust `Ord`). */
export const EVENT_KINDS: readonly EventKind[] = [
  "greeting",
  "thanks",
  "praise",
  "gift",
  "friendly",
  "apology",
  "warm",
  "cold",
  "rude",
  "insult",
  "harassment",
  "flirt_too_far",
];

const SYNONYMS: Readonly<Record<string, EventKind>> = {
  greeting: "greeting",
  greet: "greeting",
  hello: "greeting",
  thanks: "thanks",
  thank: "thanks",
  gratitude: "thanks",
  praise: "praise",
  compliment: "praise",
  gift: "gift",
  donation: "gift",
  donate: "gift",
  tip: "gift",
  superchat: "gift",
  friendly: "friendly",
  kind: "friendly",
  kindness: "friendly",
  help: "friendly",
  support: "friendly",
  apology: "apology",
  apologize: "apology",
  sorry: "apology",
  warm: "warm",
  cold: "cold",
  rude: "rude",
  rudeness: "rude",
  mean: "rude",
  insult: "insult",
  abuse: "insult",
  abusive: "insult",
  harassment: "harassment",
  harass: "harassment",
  threat: "harassment",
  flirt_too_far: "flirt_too_far",
  flirting_too_far: "flirt_too_far",
  sexual: "flirt_too_far",
  creepy: "flirt_too_far",
};

/** Parses an event name, accepting a few synonyms LLMs like to use. */
export function parseEventKind(name: string): EventKind | null {
  const n = name.trim().toLowerCase().replace(/[- ]/g, "_");
  return Object.hasOwn(SYNONYMS, n) ? (SYNONYMS[n] as EventKind) : null;
}

/** Position in `EVENT_KINDS` (for sorting like the Rust `Ord`). */
export function eventKindOrder(kind: EventKind): number {
  return EVENT_KINDS.indexOf(kind);
}

export function isPositiveKind(kind: EventKind): boolean {
  switch (kind) {
    case "greeting":
    case "thanks":
    case "praise":
    case "gift":
    case "friendly":
    case "apology":
    case "warm":
      return true;
    default:
      return false;
  }
}

/**
 * `[affinity, trust]` before caps. `scale` only matters for `warm` / `cold` (the LLM's
 * `toward_her`, -1..1).
 */
export function baseChange(kind: EventKind, scale: number): [number, number] {
  const s = Math.abs(scale);
  switch (kind) {
    case "greeting":
      return [0.5, 0.1];
    case "thanks":
      return [1.0, 0.5];
    case "praise":
      return [1.5, 0.3];
    case "gift":
      return [3.0, 1.0];
    case "friendly":
      return [0.8, 0.3];
    case "apology":
      return [1.0, 0.8];
    case "warm":
      return [2.0 * s, 0.5 * s];
    case "cold":
      return [-2.0 * s, -0.8 * s];
    case "rude":
      return [-1.5, -0.5];
    case "insult":
      return [-3.0, -1.0];
    case "harassment":
      return [-5.0, -3.0];
    case "flirt_too_far":
      return [-2.0, -1.5];
  }
}

/** Where a capped change came from; part of the delta `reason`. */
export type Source = "rule" | "appraisal";

/** `"rule: praise"` → `praise`. Only rule / appraisal reasons count toward caps. */
export function cappedKind(reason: string): EventKind | null {
  const i = reason.indexOf(":");
  if (i < 0) return null;
  const source = reason.slice(0, i).trim();
  if (source !== "rule" && source !== "appraisal") return null;
  return parseEventKind(reason.slice(i + 1));
}

/** Her local calendar day as a day number (days since 1970-01-01 in her time zone). */
export type LocalDay = number;

function clip(value: number, cap: number, gained: number, lost: number): number {
  if (value > 0) return Math.min(value, Math.max(cap - gained, 0));
  return Math.max(value, -Math.max(cap - lost, 0));
}

/** One person's appraisal budget for one local day. */
export class DayLedger {
  affinity_gained = 0;
  affinity_lost = 0;
  trust_gained = 0;
  trust_lost = 0;
  readonly counts = new Map<EventKind, number>();

  constructor(readonly day: LocalDay) {}

  /** Rebuilds a ledger from the deltas recorded since the start of `day`. */
  static fromDeltas(day: LocalDay, deltas: readonly RelationshipDelta[]): DayLedger {
    const ledger = new DayLedger(day);
    for (const d of deltas) {
      const kind = cappedKind(d.reason);
      if (kind === null) continue;
      ledger.counts.set(kind, (ledger.counts.get(kind) ?? 0) + 1);
      ledger.#book(d.affinity, d.trust);
    }
    return ledger;
  }

  #book(affinity: number, trust: number): void {
    if (affinity > 0) this.affinity_gained += affinity;
    else this.affinity_lost -= affinity;
    if (trust > 0) this.trust_gained += trust;
    else this.trust_lost -= trust;
  }

  /** Applies diminishing returns and the daily caps to a raw change and books what is left. */
  take(kind: EventKind, raw: readonly [number, number], config: SocialConfig): [number, number] {
    const count = this.counts.get(kind) ?? 0;
    const factor = Math.min(Math.max(config.repeat_decay, 0), 1) ** count;
    this.counts.set(kind, count + 1);
    const affinity = clip(
      raw[0] * factor,
      config.daily_affinity_cap,
      this.affinity_gained,
      this.affinity_lost,
    );
    const trust = clip(raw[1] * factor, config.daily_trust_cap, this.trust_gained, this.trust_lost);
    this.#book(affinity, trust);
    return [affinity, trust];
  }
}

export function hasTag(rel: Relationship, tag: string): boolean {
  return rel.tags.includes(tag);
}

export function isOwner(rel: Relationship): boolean {
  return hasTag(rel, OWNER_TAG);
}

export function isBlocked(rel: Relationship): boolean {
  return hasTag(rel, BLOCKED_TAG);
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Clamps every number to its range and applies the owner floor. */
export function normalize(rel: Relationship, config: SocialConfig): void {
  rel.affinity = clamp(finite(rel.affinity), -100, 100);
  rel.trust = clamp(finite(rel.trust), 0, 100);
  rel.familiarity = clamp(finite(rel.familiarity), 0, 100);
  if (isOwner(rel)) {
    rel.trust = clamp(config.owner_trust, 0, 100);
    rel.affinity = Math.max(rel.affinity, clamp(config.owner_affinity_floor, -100, 100));
  }
}

/** Adds the changes, normalizes and returns what actually changed. */
export function apply(
  rel: Relationship,
  affinity: number,
  trust: number,
  familiarity: number,
  config: SocialConfig,
): [number, number, number] {
  const before = [rel.affinity, rel.trust, rel.familiarity] as const;
  rel.affinity += affinity;
  rel.trust += trust;
  rel.familiarity += familiarity;
  normalize(rel, config);
  return [rel.affinity - before[0], rel.trust - before[1], rel.familiarity - before[2]];
}

/** The difference between two states as a delta row. */
export function diff(
  before: Relationship,
  after: Relationship,
  reason: string,
  at: number,
): RelationshipDelta {
  return {
    at: toTimestamp(at),
    affinity: after.affinity - before.affinity,
    trust: after.trust - before.trust,
    familiarity: after.familiarity - before.familiarity,
    reason,
  };
}

/**
 * Familiarity change for an interaction at `now`: +1 on the first interaction of a local day,
 * minus the decay for the days without contact.
 */
export function familiarityChange(
  last: Timestamp | number | null,
  now: number,
  config: SocialConfig,
): number {
  const today = localDay(now, config);
  if (last === null) return 1;
  const lastMs = typeof last === "number" ? last : timestampMs(last);
  const gap = today - localDay(lastMs, config);
  if (gap <= 0) return 0;
  const idleDays = Math.max(gap - 1 - config.familiarity_grace_days, 0);
  return 1 - idleDays * config.familiarity_decay_per_day;
}

/** Short label for prompts and `/me`. */
export function label(rel: Relationship): string {
  const a = rel.affinity;
  const f = rel.familiarity;
  if (a <= -50) return "很討厭";
  if (a <= -15) return "討厭";
  if (a >= 75 && f >= 30) return "摯友";
  if (a >= 45 && f >= 10) return "好朋友";
  if (a >= 15) return "朋友";
  if (f < 3) return "陌生人";
  return "認識";
}

function offsetMs(config: SocialConfig): number {
  const minutes = config.utc_offset_minutes;
  // chrono's FixedOffset rejects offsets of a day or more; fall back to UTC like legacy.
  return Math.abs(minutes) < 24 * 60 ? minutes * 60_000 : 0;
}

/** Her local calendar day of `ts` (epoch ms). */
export function localDay(ts: number, config: SocialConfig): LocalDay {
  return Math.floor((ts + offsetMs(config)) / DAY_MS);
}

/** The instant (epoch ms) her local `day` starts. */
export function dayStart(day: LocalDay, config: SocialConfig): number {
  return day * DAY_MS - offsetMs(config);
}
