// The shapes of economy 2.0 (docs/design/v4-plan.md §10) that the panel, the Discord commands and the
// other parts of her share. `Economy2` is what `Economy2Key` provides; the basic `Economy` of
// types.ts is unchanged so nothing that implements or fakes it breaks.

import type { AccountRef } from "@miyoria/types";
import { serviceKey } from "@miyoria/types";
import type { Rarity } from "./config.js";

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

// ---- collection ------------------------------------------------------------------------------

export interface ItemRef {
  id: string;
  label: string;
  rarity: Rarity;
}

/** One rarity of the published odds of a draw. */
export interface OddsRow {
  rarity: Rarity;
  /** Its share of one draw, in percent (two decimals). */
  percent: number;
  items: { id: string; label: string }[];
}

export interface SeriesView {
  id: string;
  label: string;
  /** The title of whoever owns every item. */
  title: string;
  items: (ItemRef & { owned: number })[];
  owned_distinct: number;
  total: number;
  complete: boolean;
}

/** A person's album, with the odds and the pity counter (nothing here is a rank). */
export interface AlbumView {
  /** She knows the person (a stranger gets an empty album). */
  member: boolean;
  series: SeriesView[];
  odds: OddsRow[];
  price: number;
  draws_today: number;
  draws_per_day: number;
  /** After this many draws without an SR or better one is guaranteed; `0`: no pity. */
  pity: number;
  /** Draws since the last SR or better one. */
  since_best: number;
}

export interface DrawResult {
  /** The ledger row of the charge. */
  entry_id: string;
  item: ItemRef & { series: string };
  charged: number;
  balance: number;
  /** The key was used before: nothing new was charged. */
  duplicate: boolean;
  /** First copy of this collectible the person has. */
  new: boolean;
  /** The pity made this one an SR or better. */
  by_pity: boolean;
}

export interface GiveItemResult {
  item: string;
  label: string;
  /** The receiver's display name (untrusted). */
  to: string;
  duplicate: boolean;
}

// ---- achievements ----------------------------------------------------------------------------

export interface AchievementUnlocked {
  id: string;
  label: string;
  title: string;
  paid: number;
}

export interface AchievementView {
  id: string;
  label: string;
  title: string;
  reward: number;
  /** When it was paid, `null` while it is still ahead. */
  unlocked_at: string | null;
}

export interface AchievementsView {
  achievements: AchievementView[];
  /** The titles the person holds, from achievements. */
  titles: string[];
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
  /** The album, the odds and the pity counter of `account` (an empty album for a stranger). */
  album(account: AccountRef): Promise<AlbumView>;
  /** The odds of one draw as published. */
  odds(): OddsRow[];
  /** The configured odds of a rarity alone, for things that are not a collectible (a card). */
  rarityOdds(): { rarity: Rarity; percent: number }[];
  /** A rarity by the configured weights, for the card service to roll a portrait card with. */
  rollRarity(): Rarity;
  /** Draws a collectible (`EconomyError`: 402 short, 403 a stranger, 429 the day's limit). */
  draw(account: AccountRef, key: string): Promise<DrawResult>;
  /** One spare copy of a collectible to another person she knows. */
  giveItem(from: AccountRef, to: AccountRef, item: string, key: string): Promise<GiveItemResult>;
  /**
   * A portrait card was issued with these traits: the ones that are collectibles fill the owner's
   * album. Returns how many were new to them.
   */
  recordCard(account: AccountRef, serial: string, traits: readonly string[]): Promise<number>;
  /** The achievements and titles of `account`. */
  achievements(account: AccountRef): Promise<AchievementsView>;
}

export const Economy2Key = serviceKey<Economy2>("Economy2");
