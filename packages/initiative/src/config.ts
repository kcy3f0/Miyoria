import { type ContextKey, contextKeyString } from "@miyoria/types";
import { z } from "zod";

/** Configuration of module `initiative` (`[modules.initiative]`); durations are in seconds. */
export const InitiativeConfigSchema = z.object({
  /**
   * While her mind loop (`mind` module) runs, hand every initiative to it as a reason to think
   * (she decides whether and how to act) instead of starting an `agent.initiative` turn. The
   * caps, quiet hours and cooldowns below still apply before anything reaches her mind.
   */
  to_mind: z.boolean().default(true),

  // --- triggers ---
  /** Nudge a channel that went quiet after a lively conversation. */
  idle_channel: z.boolean().default(true),
  /** Bring up due followups when the person is around. */
  followup: z.boolean().default(true),
  /** Greet friends on their first message of the day. */
  greeting: z.boolean().default(true),
  /** Greet people with good affinity who join her voice channel. */
  voice_join: z.boolean().default(true),

  // --- idle_channel ---
  /** Quiet time after which a lively conversation counts as gone cold. */
  idle_after_secs: z.number().default(20 * 60),
  /** Beyond this quiet time the conversation is considered over. */
  idle_max_secs: z.number().default(3 * 60 * 60),
  /** Messages (hers included) a conversation needs to count as lively. */
  lively_min_messages: z.number().default(6),

  // --- budget ---
  /** Initiatives per context per day. */
  max_per_context_per_day: z.number().default(4),
  /** Initiatives per day over all contexts. */
  max_per_day: z.number().default(12),
  /** Window used to detect an active conversation. */
  busy_window_secs: z.number().default(120),
  /**
   * Messages inside the window that make a conversation active (a lone message does not).
   * Anything she said inside the window also counts.
   */
  busy_min_messages: z.number().default(2),

  // --- adaptive backoff ---
  /** How long to wait for a human reply to her initiative. */
  reply_window_secs: z.number().default(10 * 60),
  /** The idle threshold doubles per unanswered initiative, at most this often. */
  max_backoff_doublings: z.number().default(3),
  /** One doubling is forgotten per this many days. */
  backoff_decay_days: z.number().default(1),

  // --- time ---
  /** Local time zone as an offset from UTC. */
  timezone_offset_hours: z.number().default(8),
  /** Local hour at which the "day" rolls over for counters and greetings. */
  day_start_hour: z.number().default(4),
  /** Local hour quiet hours start (inclusive). */
  quiet_start_hour: z.number().default(1),
  /**
   * Local hour quiet hours end (exclusive). Equal to start: no quiet hours. Quiet hours stop
   * idle nudges; reactions to a person who is present (greeting, voice join, followup) are not
   * affected.
   */
  quiet_end_hour: z.number().default(7),

  // --- people ---
  /** Attitude labels that count as "friend or closer". */
  friend_labels: z
    .array(z.string())
    .default(["朋友", "好朋友", "好友", "摯友", "親友", "戀人", "家人"]),
  /** Affinity at which someone joining voice gets greeted (labels in `friend_labels` qualify too). */
  voice_join_min_affinity: z.number().default(30),
  /** Minimum time between voice greetings of the same person. */
  voice_join_cooldown_secs: z.number().default(30 * 60),
  /** A person counts as around if they were active this recently. */
  followup_active_secs: z.number().default(10 * 60),

  // --- misc ---
  /** How often idle checks and the followup poll run. */
  tick_secs: z.number().default(60),
  /**
   * Strength of mood-energy scaling of the idle threshold: energy 1 gives `2^-influence`,
   * energy 0 gives `2^influence`. 0 disables it.
   */
  mood_influence: z.number().default(1),
  /**
   * Contexts that never get initiative. Entries match the context's display form
   * (`discord:<guild>:<channel>`, `discord:dm:<channel>`, voice contexts have `voice:` before
   * the channel) or its bare channel id.
   */
  disabled_contexts: z.array(z.string()).default([]),
});
export type InitiativeConfig = z.output<typeof InitiativeConfigSchema>;

/** Defaults of every field (the Rust `Default` impl). */
export function defaultInitiativeConfig(): InitiativeConfig {
  return InitiativeConfigSchema.parse({});
}

/** Whether `context` is on the opt-out list. */
export function isContextDisabled(config: InitiativeConfig, context: ContextKey): boolean {
  if (config.disabled_contexts.length === 0) return false;
  const display = contextKeyString(context);
  return config.disabled_contexts.some((d) => d === display || d === context.channel);
}
