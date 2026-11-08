import { z } from "zod";

const coins = z.number().int().nonnegative();

/** A card frame on sale; `id` is what the card stores. */
export const FrameSchema = z.object({
  /** Stored on cards: lower case letters, digits, `-` and `_`. */
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  label: z.string().min(1).max(32),
  price: z.number().int().positive(),
});
export type Frame = z.output<typeof FrameSchema>;

export const DEFAULT_FRAMES: Frame[] = [
  { id: "sakura", label: "櫻花", price: 100 },
  { id: "abyss", label: "深海", price: 150 },
  { id: "gold", label: "金框", price: 300 },
];

/**
 * `[modules.economy]` (docs/design/economy.md): what people earn by being with her and what
 * feeding her and small gifts cost. A paid gift raises affinity by a hair (`gift_affinity`, capped
 * per day); it is mostly something she feels.
 *
 * ```toml
 * [modules.economy]
 * currency = "魚幣"
 * rice = 10
 * ```
 */
export const EconomyConfigSchema = z.object({
  /** Shown everywhere the coins are named. */
  currency: z.string().trim().min(1).max(16).default("魚幣"),
  /** Daily check-in, once per local day (the panel and Discord together). */
  checkin: coins.default(10),
  /** Extra on every 7th consecutive check-in day. */
  streak_bonus: coins.default(20),
  /** Once per local day she saw them say something (text or voice). */
  talked: coins.default(10),
  /** Per 10 minutes in her voice channel, when they spoke in that window. */
  voice_per_10min: coins.default(2),
  voice_cap: coins.default(20),
  /** A song they requested that she finished. */
  song_finished: coins.default(5),
  /** Finished songs paid per day. */
  song_cap: coins.default(3),
  /** Her `give_coins` tool: per person per day. */
  her_gift_per_person: coins.default(30),
  /** Her `give_coins` tool: everyone together per day. */
  her_gift_total: coins.default(100),
  /** A bowl of rice: hunger −0.15. */
  rice: coins.default(10),
  /** A big bowl (鋼盆): hunger −0.5, the 钢盆 expression a few seconds when the stage is up. */
  big_bowl: coins.default(40),
  /** Dessert: joy, hunger −0.05. */
  dessert: coins.default(25),
  /** A letter of up to 120 characters, read when she is free. */
  letter: coins.default(15),
  /** An expression (heart, blush, squint) while the stage is up and she is not singing. */
  expression: coins.default(20),
  /** One bought expression per person per this many seconds. */
  expression_cooldown_s: coins.default(600),
  /** Under this hunger she is full: a feed is refused and nothing is charged. */
  full_below: z.number().min(0).max(1).default(0.15),
  /** Gift emotion multiplier per earlier gift of the same person today. */
  diminish: z.number().min(0).max(1).default(0.6),
  /**
   * What one paid gift (a feed or an expression, not a letter) adds to affinity and trust before
   * the social engine's own diminishing returns: a hair, never a way to buy a friend.
   */
  gift_affinity: z.number().nonnegative().default(0.4),
  gift_trust: z.number().nonnegative().default(0.1),
  /** The most gifts alone add per person per day (they also count toward the overall caps). */
  gift_affinity_cap: z.number().nonnegative().default(1.5),
  gift_trust_cap: z.number().nonnegative().default(0.5),
  /** A deal (docs/design/economy.md §12): how long they have to pay after she says she did it. */
  deal_due_s: z.number().int().positive().default(600),
  /** A deal she has not done by then ends; escrow is refunded. */
  deal_timeout_s: z.number().int().positive().default(900),
  /** Deals one person may make per day. */
  deals_per_day: coins.default(5),
  /** How often unpaid deals expire and escrow times out. */
  deal_sweep_s: z.number().int().positive().default(30),
  /** Trust a deal that was paid adds (it counts toward the daily caps). */
  deal_kept_trust: z.number().nonnegative().default(0.3),
  /**
   * A broken promise (she did the task, they did not pay): what it takes off, outside the gain
   * caps. Each later one by the same person costs `broken_growth` times more, up to
   * `broken_cap` times the first.
   */
  broken_trust: z.number().nonnegative().default(4),
  broken_affinity: z.number().nonnegative().default(1.5),
  broken_growth: z.number().min(1).default(1.5),
  broken_cap: z.number().min(1).default(3),
  /** Where "today" starts. */
  utc_offset_minutes: z.number().int().min(-720).max(840).default(480),
  frames: z
    .array(FrameSchema)
    .max(50)
    .default(DEFAULT_FRAMES)
    .refine((list) => new Set(list.map((f) => f.id)).size === list.length, {
      message: "frame ids must be unique",
    }),
});
export type EconomyConfig = z.output<typeof EconomyConfigSchema>;
