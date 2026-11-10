import { z } from "zod";

/**
 * `[modules.live]`: the live page's feed and its head-pats (docs/design/v4-plan.md §9.2).
 *
 * The feed itself changes nothing about her: it only shows what already happened, so it runs by
 * default and shows her place, activity and face. Her words appear only from channels listed in
 * `channels`, and pats reach her only with `pats = true`.
 *
 * ```toml
 * [modules.live]
 * # Channels (text or voice, by id) whose lines may appear on the page, for anyone to read.
 * channels = ["123456789012345678"]
 * # Members may pat her head from the page; each batch becomes an Observation she may react to.
 * pats = true
 * ```
 */
export const LiveConfigSchema = z.object({
  /**
   * Channel ids (Discord snowflakes) whose lines may be shown. A line from anywhere else (another
   * channel, a thread not listed by its own id, a DM) never reaches the page. Empty: no words at
   * all, only her place, activity and face.
   */
  channels: z
    .array(z.string().regex(/^\d{1,24}$/))
    .max(50)
    .default([]),
  /** Most pages watching at once; one more is turned away until someone leaves. */
  max_viewers: z.number().int().min(1).max(10_000).default(500),
  /**
   * Members may pat her from the page. Off: the page shows the hand as closed and nothing a
   * visitor does reaches her.
   */
  pats: z.boolean().default(false),
  /**
   * How a batch of pats is written. `ambient`: she knows (her working context), and may bring it
   * up when she talks anyway. `notable`: a batch may also ask for the mic, which needs the
   * arbiter to take observations of `live.pat` (see the module's integration note).
   */
  pat_salience: z.enum(["ambient", "notable"]).default("ambient"),
  /** Pats arriving this close after the first one of a batch go into the same Observation. */
  coalesce_secs: z.number().int().min(2).max(600).default(20),
  /** Pats one person may give per minute. */
  per_person_per_minute: z.number().int().min(1).max(120).default(10),
  /** Pats everyone together may give per minute. */
  per_minute: z.number().int().min(1).max(10_000).default(120),
});

export type LiveConfig = z.output<typeof LiveConfigSchema>;
