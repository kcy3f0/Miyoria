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
}

/** Provided by the social module; the agent uses it in attention. Must answer from memory. */
export interface SocialSignals {
  attitude(account: AccountRef): Attitude | null;
}

export const SocialSignalsKey = serviceKey<SocialSignals>("SocialSignals");

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
