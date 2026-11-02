import { z } from "zod";

const rate = () => z.number().nonnegative();
const unit = () => z.number().min(0).max(1);
const count = () => z.number().int().nonnegative();

/** How fast each drive rises on its own (share of the remaining gap to 1, per hour). */
const RiseSchema = z.object({
  social: rate().default(0.08),
  play: rate().default(0.05),
  attention: rate().default(0.04),
  curiosity: rate().default(0.05),
});

/** How much events satisfy drives (subtracted, 0..1). */
const SatisfySchema = z.object({
  /** She finished a turn (said something): `social`. */
  turn_social: unit().default(0.06),
  /** ...and `boredom`. */
  turn_boredom: unit().default(0.1),
  /** ...and a little `attention`. */
  turn_attention: unit().default(0.02),
  /** Someone talked to her directly: `attention`. */
  addressed_attention: unit().default(0.04),
  /** Something was said around her (a message in a channel, a line in voice): `boredom`. */
  ambient_boredom: unit().default(0.01),
  /** A salient change in the world: `boredom`... */
  salient_boredom: unit().default(0.05),
  /** ...and `curiosity`. */
  salient_curiosity: unit().default(0.02),
  /** While she plays a game: `play` (and `boredom`) per hour. */
  playing_per_hour: rate().default(0.5),
  /** While she is live: `attention` per hour. */
  streaming_per_hour: rate().default(0.5),
  /** While she is live, `rest` rises this much per hour. */
  streaming_rest_per_hour: rate().default(0.1),
});

/**
 * `[modules.self]` config section. Every field has a default.
 *
 * ```toml
 * [modules.self]
 * boredom_per_hour = 0.15
 * [modules.self.rise_per_hour]
 * social = 0.08
 * ```
 */
export const SelfConfigSchema = z.object({
  /** Background tick: drift, expiry, saving. */
  tick_secs: count().default(60),
  /** Remember her state across restarts (needs `SettingsStoreKey`). */
  persist: z.boolean().default(true),
  /** Boredom rises this fast without anything happening (share of the gap, per hour). */
  boredom_per_hour: rate().default(0.15),
  /** `rest` drifts toward `1 - energy` of her mood with this half-life. */
  rest_half_life_mins: z.number().positive().default(90),
  rise_per_hour: RiseSchema.prefault({}),
  satisfy: SatisfySchema.prefault({}),
  /** Starting value of every drive (first run, or after a wipe). */
  initial_drive: unit().default(0.3),
  initial_boredom: unit().default(0.2),
  initial_initiative: unit().default(0.5),
  /** Longest a talkativeness setting may last (she can always set it again). */
  max_talkativeness_hours: z.number().positive().default(24),
  /** Open agenda items kept; adding more drops the oldest. */
  max_open_agenda: count().default(20),
  /** Done / dropped / expired agenda items kept for the panel. */
  keep_closed_agenda: count().default(20),
  /** Longest feelings text per person. */
  max_feeling_chars: count().default(500),
  /** Add the `self` prompt section. */
  prompt: z.boolean().default(true),
  /** Her local time zone as a UTC offset (times in the prompt section). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
});

export type SelfConfig = z.output<typeof SelfConfigSchema>;

/** The defaults, optionally overridden. */
export function selfConfig(overrides: Partial<SelfConfig> = {}): SelfConfig {
  return { ...SelfConfigSchema.parse({}), ...overrides };
}
