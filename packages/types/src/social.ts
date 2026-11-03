import type { PersonId, ProfileId } from "./ids.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** How she currently feels about someone. Cheap to query. */
export interface Attitude {
  person: PersonId;
  /** -100..100 */
  affinity: number;
  /** 0..100 */
  trust: number;
  /** 0..100 */
  familiarity: number;
  /** She ignores this person entirely (admin decision). */
  blocked: boolean;
  /** Short label for prompts and `/me`, e.g. `"陌生人"`, `"朋友"`. */
  label: string;
  /** How she addresses them, if set. */
  call_name: string | null;
  /** Tagged `owner` (missing from older producers). */
  owner?: boolean;
  /** Last display name of the person (untrusted; missing from older producers). */
  display_name?: string | null;
  /** How many of their lines she has seen (missing from older producers). */
  interactions?: number;
  /** When they last spoke (missing from older producers). */
  last_interaction?: Timestamp | null;
}

/** Provided by the social module; the agent uses it in attention. Must answer from memory. */
export interface SocialSignals {
  attitude(account: AccountRef): Attitude | null;
  /** The same by person (her emotions about people she knows only by id). */
  attitudeOf?(person: PersonId): Attitude | null;
}

export const SocialSignalsKey = serviceKey<SocialSignals>("SocialSignals");

/**
 * Bus topic of every social event someone caused toward her (`SocialEvent`), published by the
 * social module whether or not the daily caps let it change the numbers: her emotions react
 * to all of them.
 */
export const SOCIAL_EVENT_TOPIC = "social.event";

/** Payload of `social.event`. */
export interface SocialEvent {
  person: PersonId;
  /** Display name (untrusted). */
  name: string | null;
  /** `praise`, `insult`, `warm`, ... (the social module's event kinds). */
  kind: string;
  /** `rule` (keywords), `appraisal` (the LLM) or `mind` (her own hint). */
  source: string;
  /** Strength for `warm` / `cold` (0..1), 1 otherwise. */
  scale: number;
  context: ContextKey | null;
}

/**
 * Bus topic of what the social appraisal (the batched `fast` LLM pass) read about her feelings
 * in a conversation (`SocialAppraisal`), for her emotions.
 */
export const SOCIAL_APPRAISAL_TOPIC = "social.appraisal";

/** One person in a `SocialAppraisal`. */
export interface AppraisedPerson {
  person: PersonId;
  name: string | null;
  /** -1..1, how they treated her. */
  toward_her: number;
  /** -1..1, how flirty, caring or intimate they were with her (beyond friendly). */
  romance: number;
  /** 0..1, how warmly they were with other people while leaving her out. */
  others: number;
  /** A promise to her they kept or broke in these lines. */
  promise: "kept" | "broken" | null;
}

/** Payload of `social.appraisal`. */
export interface SocialAppraisal {
  context: ContextKey;
  /** Her emotions (`self` emotion names, 0..1) the conversation stirred, as the model read it. */
  her: Record<string, number>;
  people: AppraisedPerson[];
}

/** Global emotional state of the active profile. */
export interface Mood {
  /** -1..1 */
  valence: number;
  /** 0..1 */
  arousal: number;
  /** 0..1 */
  energy: number;
}

/** Provided by the mood module. */
export interface MoodSignals {
  mood(): Mood;
}

export const MoodSignalsKey = serviceKey<MoodSignals>("MoodSignals");

/** Something she promised or wants to bring up later ("你明天考試考得怎樣?"). */
export interface Followup {
  id: string;
  profile: ProfileId;
  person: PersonId | null;
  /** Where it came up; follow up there (or wherever the person shows up). */
  context: ContextKey | null;
  about: string;
  /** Earliest time it makes sense to bring it up. */
  due: Timestamp;
}

/** Provided by the memory module; used by initiative. */
export interface FollowupSource {
  /** Followups due at `now` (not yet done). */
  due(profile: ProfileId, now: Timestamp): Promise<Followup[]>;
  markDone(id: string): Promise<void>;
}

export const FollowupSourceKey = serviceKey<FollowupSource>("FollowupSource");
