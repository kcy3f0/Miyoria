import type { PersonId, ProfileId, TurnId } from "./ids.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

export interface Participant {
  account: AccountRef;
  display_name: string;
  /** Resolved by the social module when known. */
  person: PersonId | null;
}

/**
 * What the agent is about to answer, for modules that add per-turn context (memories,
 * relationships, mood, game state, ...).
 */
export interface PromptRequest {
  profile: ProfileId;
  turn: TurnId;
  context: ContextKey;
  participants: Participant[];
  /** Authors of the input of this turn (subset of `participants`). */
  speakers: AccountRef[];
  /** The new input of this turn, e.g. `"Owen: 你明天要幹嘛"` lines joined. */
  query: string;
  /** A few recent lines before the input, oldest first. */
  recent: string[];
  voice: boolean;
  now: Timestamp;
}

/** A block appended to the per-turn situation message. */
export interface PromptSection {
  /** Stable id, e.g. `"memory"`. */
  key: string;
  /** Heading shown to the model (Traditional Chinese), e.g. `"你記得的事"`. */
  title: string;
  body: string;
  /** Lower comes first. */
  order: number;
}

export interface PromptContributor {
  /** Unique name (used to unregister). */
  readonly key: string;
  /** Must be fast; the agent applies a timeout (aborting `signal`) and skips slow contributors. */
  contribute(request: PromptRequest, signal?: AbortSignal): Promise<PromptSection[]>;
}

/**
 * Registry of prompt contributors. Created by the app at boot and provided as the
 * `PromptContributorsKey` service; modules register on start and unregister on stop.
 */
export class PromptContributors {
  readonly #items = new Map<string, PromptContributor>();

  register(contributor: PromptContributor): void {
    this.#items.set(contributor.key, contributor);
  }

  unregister(key: string): void {
    this.#items.delete(key);
  }

  /** Every contributor, ordered by key. */
  all(): PromptContributor[] {
    return [...this.#items.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, c]) => c);
  }
}

export const PromptContributorsKey = serviceKey<PromptContributors>("PromptContributors");
