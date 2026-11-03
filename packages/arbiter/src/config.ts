// `[modules.arbiter]`: the one rule set for "may she speak / act now" (docs/design/
// v2-architecture.md §3.3). It replaces `[modules.initiative]` (its caps, quiet hours and
// triggers), mind's second quiet hours and the gate's `chat.start` counters. Every limit here is
// written to her ledger, so she plans with it in view.

import { type ContextKey, contextKeyString } from "@miyoria/types";
import { z } from "zod";

const count = () => z.number().int().nonnegative();
const hour = () => z.number().int().min(0).max(23);

/**
 * ```toml
 * [modules.arbiter]
 * max_per_day = 12
 * quiet_start_hour = 1
 * quiet_end_hour = 7
 * ```
 */
export const ArbiterConfigSchema = z.object({
  // --- time ---
  /** Her local time zone as minutes east of UTC (quiet hours, "today"). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /** Local hour at which her day rolls over (daily counters, greetings). */
  day_start_hour: hour().default(4),
  /**
   * Quiet hours (local, start inclusive, end exclusive; equal = none). She starts nothing on
   * her own then; answering people, songs she was asked for and task results are not affected.
   * The only quiet hours: mind's own (`[modules.mind]`) follow these while the Arbiter runs.
   */
  quiet_start_hour: hour().default(1),
  quiet_end_hour: hour().default(7),

  // --- her own starts (sources `plan` / `agenda` that make her talk) ---
  /** Her own conversation starts per day, all places together (0 = no cap). */
  max_per_day: count().default(12),
  /** Per text channel, voice channel or DM per day (0 = no cap). */
  max_per_context_per_day: count().default(4),
  /** Aimed at one person per day (was `chat.start` `per_person_per_day`; 0 = no cap). */
  max_per_person_per_day: count().default(4),
  /** Between any two of her own starts (was `chat.start` `cooldown_ms`). */
  min_gap_secs: count().default(60),
  /**
   * Between two starts in one place. Every start nobody picked up doubles it, up to
   * `max_backoff` times; someone engaging with her there resets it.
   */
  gap_text_secs: count().default(600),
  gap_voice_secs: count().default(300),
  max_backoff: z.number().int().min(1).default(8),
  /** One doubling is forgotten per this many hours without a new miss. */
  backoff_decay_hours: z.number().positive().default(24),
  /**
   * Her topic counts as picked up when someone addresses or answers her there within this
   * long after she spoke; otherwise it was ignored (`affect.event` `topic_ignored`).
   */
  reply_window_text_secs: count().default(600),
  reply_window_voice_secs: count().default(300),
  /** Ignored topics are listed to her (and not raised again) this long. */
  stale_topic_mins: count().default(45),
  /** A capability that was refused or failed is shown as on hold this long. */
  blocked_mins: count().default(30),

  // --- everything that is not an answer ---
  /**
   * Greetings and her own starts wait at least this long after she last spoke there (song
   * announcements, game commentary, followups and notices do not).
   */
  after_speech_text_secs: count().default(5),
  after_speech_voice_secs: count().default(20),
  /** An impulse whose place is busy (a turn in flight, her speech queued) is retried this often. */
  retry_ms: z.number().int().positive().default(3000),
  /** Impulses waiting for their turn at most (the oldest of the lowest priority go first). */
  max_queued: count().default(50),
  /** Ledger entries kept in memory (newest first). */
  ledger_keep: count().default(200),
  /**
   * Contexts that never get anything unprompted from her. Entries match the context's display
   * form (`discord:<guild>:<channel>`, voice contexts with `voice:` before the channel) or its
   * bare channel id.
   */
  disabled_contexts: z.array(z.string()).default([]),

  // --- impulse producers (were `[modules.initiative]`) ---
  /** Greet friends on their first message of the day (source `world`). */
  greeting: z.boolean().default(true),
  /** Greet people with good affinity who join her voice channel (source `world`). */
  voice_join: z.boolean().default(true),
  /** Bring up due memory followups when the person is around (source `followup`). */
  followup: z.boolean().default(true),
  /** Attitude labels that count as "friend or closer". */
  friend_labels: z
    .array(z.string())
    .default(["朋友", "好朋友", "好友", "摯友", "親友", "戀人", "家人"]),
  /** Affinity at which someone joining voice gets greeted (labels in `friend_labels` qualify too). */
  voice_join_min_affinity: z.number().default(30),
  /** Minimum time between voice greetings of the same person. */
  voice_join_cooldown_secs: count().default(30 * 60),
  /** A person counts as around if they were active this recently. */
  followup_active_secs: count().default(10 * 60),
  /** How long a greeting / followup stays worth saying while the place is busy. */
  impulse_ttl_secs: count().default(120),
  /** How often followups are polled, unanswered topics settled and the state saved. */
  tick_secs: z.number().int().positive().default(30),
});
export type ArbiterConfig = z.output<typeof ArbiterConfigSchema>;

/** The defaults, optionally overridden. */
export function arbiterConfig(overrides: Partial<ArbiterConfig> = {}): ArbiterConfig {
  return { ...ArbiterConfigSchema.parse({}), ...overrides };
}

/** Whether `context` is on the opt-out list. */
export function isContextDisabled(config: ArbiterConfig, context: ContextKey): boolean {
  if (config.disabled_contexts.length === 0) return false;
  const display = contextKeyString(context);
  return config.disabled_contexts.some((d) => d === display || d === context.channel);
}

/** `[modules.initiative]` keys that moved here (the old section is read with a warning). */
export const INITIATIVE_KEYS: Readonly<Record<string, keyof ArbiterConfig | null>> = {
  to_mind: null,
  idle_channel: null,
  idle_after_secs: null,
  idle_max_secs: null,
  lively_min_messages: null,
  busy_window_secs: null,
  busy_min_messages: null,
  mood_influence: null,
  reply_window_secs: "reply_window_text_secs",
  max_backoff_doublings: null,
  backoff_decay_days: null,
  followup: "followup",
  greeting: "greeting",
  voice_join: "voice_join",
  max_per_context_per_day: "max_per_context_per_day",
  max_per_day: "max_per_day",
  day_start_hour: "day_start_hour",
  quiet_start_hour: "quiet_start_hour",
  quiet_end_hour: "quiet_end_hour",
  friend_labels: "friend_labels",
  voice_join_min_affinity: "voice_join_min_affinity",
  voice_join_cooldown_secs: "voice_join_cooldown_secs",
  followup_active_secs: "followup_active_secs",
  tick_secs: "tick_secs",
  disabled_contexts: "disabled_contexts",
};
