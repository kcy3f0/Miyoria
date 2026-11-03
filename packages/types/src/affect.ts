// Affect and People (docs/design/v2-architecture.md §3.1, §3.6): her feelings with one writer.
//
// Three layers at three speeds: drives (hours, pure homeostasis), emotions (minutes, rule
// events + Appraise) and bonds (days, one card per person). Mood is no longer stored: it is
// derived from the three layers (plus the time-of-day energy curve).
//
// The only inputs to emotions are *events* (`AffectEvent` rule events and `AppraisalEvent`s);
// nobody writes absolute numbers, and the program turns events into numbers (habituation,
// mutual inhibition, a stir budget, decay toward the temperament's baseline). `<emo:…>` tags are
// expression only and never feed back. Plan / mind never write emotions.
//
// The existing `Drives`, `DriveName`, `EmotionName`, `PersonEmotionName`, `EmotionReading` and
// `ShownEmotion` (self.ts) and `Mood` (social.ts) are reused as they are.

import type { Handle } from "./handle.js";
import type { PersonId } from "./ids.js";
import type { ContextKey } from "./platform.js";
import type {
  DriveName,
  Drives,
  EmotionName,
  EmotionReading,
  PersonEmotionName,
  ShownEmotion,
} from "./self.js";
import { serviceKey } from "./service-key.js";
import type { Mood } from "./social.js";
import type { Timestamp } from "./time.js";

// ---- appraisal ------------------------------------------------------------------------------

export type AppraisalStrength = "weak" | "medium" | "strong";

/** Base stir of each strength, before her temperament's gain and habituation. */
export const APPRAISAL_STRENGTH: Readonly<Record<AppraisalStrength, number>> = {
  weak: 0.1,
  medium: 0.2,
  strong: 0.35,
};

/**
 * One appraisal (what the Appraise call outputs, at most 3 per interaction):
 * `{"emotion": "shy", "strength": "weak", "toward": "Owen", "cause": "他說想聽我唱歌"}`.
 */
export interface AppraisalEvent {
  emotion: EmotionName;
  strength: AppraisalStrength;
  /** Who it is about (a handle, never a `u1` code); `null`: nobody in particular. */
  toward: Handle | null;
  /** What caused it, short zh-TW in her words (data in prompts: may quote people). */
  cause: string;
}

/** Who produced an affect input. */
export type AffectSource = "rule" | "appraise" | "reflect" | "drive" | "panel";

/**
 * Rule events (cheap, immediate), published by whoever sees them as `AFFECT_EVENT_TOPIC`; the
 * affect module maps each kind to emotions (the §3.6 table).
 */
export const AFFECT_EVENT_KINDS = [
  /** Someone praised her directly. */
  "praised",
  /** Someone she cares about came online / joined voice. */
  "cared_arrived",
  /** She opened a topic and nobody picked it up (the Arbiter's ledger). */
  "topic_ignored",
  /** She finished a song. */
  "song_finished",
  /** People reacted to her song. */
  "song_applauded",
  /** Her speech was cut off / she was talked over. */
  "interrupted",
  /** Someone she addressed ignored her. */
  "ignored",
  /** Someone she cares about is warm with someone else while leaving her out. */
  "cared_close_with_other",
  /** A task / activity of hers succeeded or failed (game goal, going live). */
  "task_succeeded",
  "task_failed",
  /** She won / lost / died in a game. */
  "game_won",
  "game_lost",
] as const;

export type AffectEventKind = (typeof AFFECT_EVENT_KINDS)[number];

/** Payload of `AFFECT_EVENT_TOPIC`. */
export interface AffectEvent {
  kind: AffectEventKind;
  /** Who it involves, when someone. */
  person: PersonId | null;
  handle: Handle | null;
  context: ContextKey | null;
  /** Short neutral zh-TW detail (the cause she remembers). */
  detail: string;
  /** Repeats with the same key within the habituation window count as the same cause. */
  key: string;
  at: Timestamp;
}

/** A batch of appraisals for the affect module (`AffectState.appraise`). */
export interface AffectInput {
  source: AffectSource;
  events: AppraisalEvent[];
  context: ContextKey | null;
  at: Timestamp;
}

/** What one appraisal did after the dynamics (for the journal and the panel). */
export interface AppliedAppraisal {
  emotion: EmotionName;
  toward: PersonId | null;
  /** The stir actually applied (after gain, habituation and the budget). */
  amount: number;
  /** `0.5ⁿ` habituation factor applied (1 = first time). */
  habituation: number;
  /** Emotions it pushed down (mutual inhibition), name: amount. */
  inhibited: Partial<Record<EmotionName, number>>;
}

// ---- people ---------------------------------------------------------------------------------

export const RELATIONSHIP_LABELS = [
  "很討厭",
  "討厭",
  "陌生人",
  "認識",
  "朋友",
  "好朋友",
  "摯友",
] as const;

/** The one relationship scale (every prompt, `/me` and the panel use this). */
export type RelationshipLabel = (typeof RELATIONSHIP_LABELS)[number];

/** The numbers the label depends on. */
export interface RelationshipNumbers {
  /** -100..100 */
  affinity: number;
  /** 0..100 */
  familiarity: number;
}

/** The relationship label of `rel` (same thresholds as `social`'s `label()` today). */
export function relationshipLabel(rel: RelationshipNumbers): RelationshipLabel {
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

/**
 * One card per person: replaces affinity / trust / notes (social), feelings / hearts / romance
 * / emotions toward people (self), the knowledge person card and per-person lessons as the
 * place her feeling about someone lives.
 */
export interface PersonCard {
  person: PersonId;
  handle: Handle;
  /** How she addresses them (`null`: by handle). */
  call_name: string | null;
  /** -100..100 */
  affinity: number;
  /** 0..100 */
  trust: number;
  /** 0..100, from how much and how deeply they interact (not +1 a day). */
  familiarity: number;
  /** 0..1, how much she cares (a crush grows from here; Reflect moves it in small steps). */
  attachment: number;
  /** Active emotions toward them (0..1, decayed to now; absent = none). */
  emotions: Partial<Record<PersonEmotionName, number>>;
  /** Her feeling about them in her own words, using names (Appraise edits, Reflect rewrites). */
  feeling: string;
  label: RelationshipLabel;
  owner: boolean;
  blocked: boolean;
  last_seen: Timestamp | null;
  last_together: Timestamp | null;
  updated_at: Timestamp;
}

/** A proposed change to a bond (Appraise: small; Reflect: daily, capped). */
export interface BondChange {
  affinity?: number;
  trust?: number;
  familiarity?: number;
  attachment?: number;
  /** Replaces her feeling text. */
  feeling?: string;
  why: string;
}

// ---- snapshot and effects -------------------------------------------------------------------

/**
 * Weighted behaviour offsets her feelings imply (§3.6 table), visible on the panel. They are
 * biases, not switches: Plan decides, the Arbiter enforces the floors.
 */
export interface AffectBiases {
  /** Added to her talkativeness (-1..1). */
  talkativeness: number;
  /** Added to her willingness to start things (-1..1). */
  initiative: number;
  /** Per wish (`chat_with`, `play`, `stream`, `rest`, `sing`): weight 0..1 and why. */
  wants: { want: string; weight: number; person: Handle | null; why: string }[];
}

export interface AffectSnapshot {
  at: Timestamp;
  drives: Drives;
  /** 0..1 */
  boredom: number;
  /** The strongest 2–3 emotions only (what prompts show). */
  top: EmotionReading[];
  /** Derived (never stored on its own). */
  mood: Mood;
  /** One line for the prompt (`"心情不錯、有點累"`): the only mood renderer. */
  mood_line: string;
  shown: ShownEmotion | null;
  biases: AffectBiases;
}

/** Payload of `AFFECT_EVENT_TOPIC`: `AffectEvent`. */
export const AFFECT_EVENT_TOPIC = "affect.event";
/** Payload: `AffectSnapshot`, published when it changed noticeably. */
export const AFFECT_CHANGED_TOPIC = "affect.changed";

/** Provided by the affect owner (`self`). Reads answer from memory. */
export interface AffectState {
  snapshot(): AffectSnapshot;
  /** What she feels, strongest first, at or above `min`. */
  emotions(min?: number): EmotionReading[];
  /** The only write path for emotions: events in, numbers computed here. */
  appraise(input: AffectInput): AppliedAppraisal[];
  /** A drive was satisfied (`amount` < 0) or frustrated (> 0) by something she did. */
  satisfy(drive: DriveName, amount: number, reason: string): void;

  card(person: PersonId): PersonCard | null;
  cardByHandle(handle: Handle): PersonCard | null;
  /** Every card, highest attachment first. */
  cards(): PersonCard[];
  /** Applies a bond change within the daily caps; `null` when there is no such person. */
  adjustBond(person: PersonId, change: BondChange, by: AffectSource): Promise<PersonCard | null>;
}

export const AffectStateKey = serviceKey<AffectState>("AffectState");
