// The shapes of economy 2.0 (docs/design/v4-plan.md §10) that the panel, the Discord commands and the
// other parts of her share. `Economy2` is what `Economy2Key` provides; the basic `Economy` of
// types.ts is unchanged so nothing that implements or fakes it breaks.

import type { AccountRef } from "@miyoria/types";
import { serviceKey } from "@miyoria/types";

// ---- quests ----------------------------------------------------------------------------------

export type QuestId = "new_topic" | "play_game" | "listen_song";

export interface QuestView {
  id: QuestId;
  label: string;
  done: boolean;
}

/** Today's three quests as one person sees them (empty for a stranger). */
export interface QuestsView {
  quests: QuestView[];
  /** What each pays, and what finishing all three adds. */
  reward: number;
  bonus: number;
  bonus_done: boolean;
  earned_today: number;
  cap: number;
}

/**
 * `paid`: done now. `done`: already done today. `repeat`: that topic was already told within the
 * last days. `capped`: today's quest coins are all paid. `stranger`: she does not know them.
 */
export interface QuestResult {
  status: "paid" | "done" | "repeat" | "capped" | "stranger";
  paid: number;
  /** What finishing all three added with this one. */
  bonus: number;
  all_done: boolean;
}

export interface Economy2 {
  /** The currency's name (`魚幣`). */
  readonly currency: string;
  /** Today's quests for `account`. */
  quests(account: AccountRef): Promise<QuestsView>;
  /**
   * Marks a quest done for `account` (the caller judged it: a game ended, a song was heard, she
   * heard something new). `topic` is required for `new_topic`.
   */
  completeQuest(account: AccountRef, quest: QuestId, topic?: string): Promise<QuestResult>;
}

export const Economy2Key = serviceKey<Economy2>("Economy2");
