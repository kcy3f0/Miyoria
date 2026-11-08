// The shapes shared with the panel, the stage overlay and the Discord commands. Changing one
// changes the contract (docs/design/economy.md).

import { type AccountRef, serviceKey } from "@miyoria/types";

export type FeedItem = "rice" | "big_bowl" | "dessert";
export type GiftExpression = "heart" | "blush" | "squint";
/** What `economy.gift` names. */
export type GiftItem = FeedItem | "letter" | "expression";

export const FEED_ITEMS: readonly FeedItem[] = ["rice", "big_bowl", "dessert"];
export const GIFT_EXPRESSIONS: readonly GiftExpression[] = ["heart", "blush", "squint"];

export type EarnReason = "checkin" | "talked" | "voice" | "song" | "her_gift";

export interface EarnLine {
  reason: EarnReason;
  label: string;
  amount: number;
  earned_today: number;
  cap: number;
}

export interface ShopItem {
  /** `rice`, `letter`, `expression:heart`, `frame:sakura`, ... */
  id: string;
  kind: "feed" | "letter" | "expression" | "frame";
  label: string;
  price: number;
  available: boolean;
  why: string | null;
}

export interface LedgerLine {
  ts: string;
  delta: number;
  label: string;
}

export type Hunger = "full" | "ok" | "hungry" | "starving";

/** One deal as the wallet shows it (docs/design/economy.md §12). */
export interface DealView {
  /** What she said she would do. */
  task: string;
  /** `一碗白飯`, `3 碗白飯`. */
  reward_label: string;
  status: "open" | "owed" | "settled" | "broken" | "refunded";
  /** When the next deadline falls (`open`: do it by; `owed`: pay by); `null` once it ended. */
  due_at: string | null;
}

export interface WalletView {
  currency: string;
  balance: number;
  can_earn: boolean;
  today_earned: number;
  checked_in_today: boolean;
  /** Consecutive check-in days, today included when done. */
  streak: number;
  earn: EarnLine[];
  shop: ShopItem[];
  frames: { owned: string[]; selected: string | null };
  /** Words, never the number; `null` for strangers. */
  hungry: Hunger | null;
  /** Newest first, at most 20. */
  recent: LedgerLine[];
  /** Her deals with this person, newest first, at most 10; cancelled ones are not shown. */
  deals: DealView[];
}

export interface CheckinResult {
  gained: number;
  streak: number;
  balance: number;
}

/** Refused when she is full: `accepted` false, `charged` 0. */
export interface FeedResult {
  accepted: boolean;
  eaten: number;
  charged: number;
  balance: number;
  message: string;
}

export interface SpendResult {
  accepted: boolean;
  charged: number;
  balance: number;
  message: string;
}

export interface FramesResult {
  owned: string[];
  selected: string | null;
  balance: number;
}

/** A wallet for `GET /api/member/export`: every line, oldest last. */
export interface WalletExport {
  balance: number;
  ledger: LedgerLine[];
}

/** Bus topic of every accepted gift (the overlay merges them). */
export const GIFT_TOPIC = "economy.gift";

/** Payload of `economy.gift`. */
export interface GiftEvent {
  /** The giver's display name (untrusted). */
  name: string;
  item: GiftItem;
  count: number;
  /** `一碗白飯`. */
  label: string;
}

/**
 * Coins for one person's account. Strangers and blocked people get a stranger's answers: a read
 * shows an empty wallet, a spend is an `EconomyError` 403. Spends take a key: the same key twice
 * answers what the first did.
 */
export interface Economy {
  wallet(account: AccountRef): Promise<WalletView>;
  checkin(account: AccountRef): Promise<CheckinResult>;
  feed(account: AccountRef, item: FeedItem, count: number, key: string): Promise<FeedResult>;
  letter(account: AccountRef, text: string, key: string): Promise<SpendResult>;
  expression(account: AccountRef, expression: GiftExpression, key: string): Promise<SpendResult>;
  frame(
    account: AccountRef,
    req: { buy?: string; select?: string | null },
    key: string,
  ): Promise<FramesResult>;
  /** Their whole ledger, for the export. */
  exportWallet(account: AccountRef): Promise<WalletExport>;
  /** The frame on their cards, `null` for none (and for strangers). */
  selectedFrame(account: AccountRef): Promise<string | null>;
}

export const EconomyKey = serviceKey<Economy>("Economy");

/**
 * A refused request, with the HTTP status the member routes answer: 400 bad input, 402 not
 * enough coins, 403 a stranger, 409 already done, 429 a limit, 503 a part of her is not running.
 * `message` is for the person.
 */
export class EconomyError extends Error {
  override readonly name = "EconomyError";

  constructor(
    readonly status: 400 | 402 | 403 | 409 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}
