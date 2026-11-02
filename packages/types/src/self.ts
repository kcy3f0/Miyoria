// Her inner state (docs/design/autonomy.md §4): drives, boredom, the policy she sets for
// herself, her agenda and how she feels about people. Provided by the `self` module as
// `SelfStateKey`; her mood stays with the `mood` module and is only included in snapshots.

import type { PersonId } from "./ids.js";
import { type ContextKey, contextKeyString } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Mood } from "./social.js";
import type { Timestamp } from "./time.js";

export const DRIVE_NAMES = ["social", "play", "attention", "rest", "curiosity"] as const;

/**
 * `social`: wants to interact with people; `play`: wants to play a game; `attention`: wants to
 * be noticed (stream, perform); `rest`: wants to rest; `curiosity`: wants something new.
 */
export type DriveName = (typeof DRIVE_NAMES)[number];

/** Each 0..1. Drives rise slowly on their own and drop when satisfied. */
export type Drives = Record<DriveName, number>;

/** How talkative she wants to be in one scope (0 = silent, 1 = very chatty). */
export interface Talkativeness {
  level: number;
  /** Expiry; `null` = until she changes it. */
  until: Timestamp | null;
  /** Her reason, in her own words. */
  why: string;
  set_at: Timestamp;
}

export interface SelfPolicy {
  /** By scope, see `talkativenessScopes`. Expired entries are removed. */
  talkativeness: Record<string, Talkativeness>;
  /** Willingness to start things on her own, 0..1. */
  initiative: number;
  initiative_why: string;
}

export type AgendaStatus = "open" | "done" | "expired" | "dropped";

/** Something she is doing or means to do ("等 Owen 上線問他報告結果"). */
export interface AgendaItem {
  id: string;
  text: string;
  why: string;
  person: PersonId | null;
  context: ContextKey | null;
  created_at: Timestamp;
  /** Earliest time it makes sense; `null` = any time. */
  due: Timestamp | null;
  /** It no longer matters after this; `null` = never expires. */
  expires_at: Timestamp | null;
  status: AgendaStatus;
  /** When it was done, dropped or expired. */
  closed_at: Timestamp | null;
}

/** Her own description of how she feels about someone. */
export interface Feeling {
  person: PersonId;
  text: string;
  updated_at: Timestamp;
  /** Who wrote it: `"self"` (her), `"panel"`, ... */
  by: string;
}

export interface SelfSnapshot {
  at: Timestamp;
  /** From the `mood` module; `null` while it is not running. */
  mood: Mood | null;
  /** 0..1, rises when nothing happens. */
  boredom: number;
  drives: Drives;
  policy: SelfPolicy;
  /** Open items first (by due time), then recently closed ones. */
  agenda: AgendaItem[];
}

export interface TalkativenessInput {
  level: number;
  /** Absolute expiry. Takes precedence over `forMs`. */
  until?: Timestamp | null;
  /** Expiry relative to now. */
  forMs?: number | null;
  why: string;
}

export interface AgendaInput {
  text: string;
  why?: string;
  person?: PersonId | null;
  context?: ContextKey | null;
  due?: Timestamp | null;
  expiresAt?: Timestamp | null;
}

/** The talkativeness that applies somewhere, and the scope it was set for. */
export interface EffectiveTalkativeness extends Talkativeness {
  scope: string;
}

/** Provided by the `self` module. Getters answer from memory; setters persist in the background. */
export interface SelfState {
  snapshot(): SelfSnapshot;
  drives(): Drives;
  boredom(): number;
  /** Adds `delta` to drives (and boredom); positive = more wanted, negative = satisfied. */
  adjust(delta: Partial<Drives> & { boredom?: number }, reason: string): void;

  /** The most specific unexpired setting for `context` (see `talkativenessScopes`). */
  talkativeness(context: ContextKey | null): EffectiveTalkativeness | null;
  setTalkativeness(scope: string, input: TalkativenessInput): Talkativeness;
  clearTalkativeness(scope: string): boolean;
  initiative(): number;
  setInitiative(level: number, why: string): void;

  /** Open items, soonest due first. */
  agenda(): AgendaItem[];
  addAgenda(input: AgendaInput): AgendaItem;
  completeAgenda(id: string): AgendaItem | null;
  dropAgenda(id: string): AgendaItem | null;

  feeling(person: PersonId): Feeling | null;
  feelings(): Feeling[];
  /** Replaces her description of `person`; empty text deletes it (returns `null`). */
  setFeeling(person: PersonId, text: string, by: string): Promise<Feeling | null>;
}

export const SelfStateKey = serviceKey<SelfState>("SelfState");

/** Scope that applies everywhere. */
export const GLOBAL_SCOPE = "*";

/**
 * Scopes that apply to `context`, most specific first: the context itself
 * (`discord:<guild>:<channel>` / `discord:<guild>:voice:<channel>`), its guild
 * (`discord:<guild>`), its kind (`voice` / `text`) and `*`.
 */
export function talkativenessScopes(context: ContextKey | null): string[] {
  if (context === null) return [GLOBAL_SCOPE];
  const out = [contextKeyString(context)];
  if (context.scope !== null) out.push(`${context.platform}:${context.scope}`);
  out.push(context.kind === "voice" ? "voice" : "text", GLOBAL_SCOPE);
  return out;
}
