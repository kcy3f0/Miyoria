// Configuration: `[modules.memory]` (module settings) and the top-level `[memory.embedding]`
// section (passed in by the app, like `[llm]`).

import { z } from "zod";

const uint = () => z.number().int().min(0);

/** Hybrid retrieval weights. */
export const WeightsSchema = z.object({
  vector: z.number().default(0.35),
  text: z.number().default(0.25),
  recency: z.number().default(0.15),
  importance: z.number().default(0.15),
  /** Bonus when the memory is about someone present. */
  subject: z.number().default(0.1),
});
export type Weights = z.output<typeof WeightsSchema>;

/**
 * Where episodes and facts learned in guild channels live: `guild` (shared across the whole
 * guild / server) or `channel` (only where it was learned).
 */
export const GuildScopeSchema = z.enum(["guild", "channel"]);
export type GuildScope = z.output<typeof GuildScopeSchema>;

export const DedupeConfigSchema = z.object({
  /** Cosine similarity at which a new memory supersedes an existing one. */
  vector_similarity: z.number().default(0.9),
  /**
   * Character-bigram similarity of normalized text at which a new memory is the same as an
   * existing one (reinforced in place).
   */
  text_similarity: z.number().default(0.85),
  /** Confidence added when a fact is learned again. */
  reinforce: z.number().default(0.1),
});
export type DedupeConfig = z.output<typeof DedupeConfigSchema>;

/** Daily maintenance: pruning episodes and decaying unreinforced facts. */
export const ForgettingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  interval_hours: uint().default(24),
  /** Episodes older than this ... */
  episode_max_age_days: z.number().int().default(30),
  /** ... with importance at most this ... */
  episode_max_importance: z.number().default(0.3),
  /** ... and not recalled for this long are deleted. */
  episode_not_accessed_days: z.number().int().default(14),
  /** Facts not reinforced for this long lose confidence ... */
  decay_after_days: z.number().int().default(30),
  /** ... multiplied by this per day ... */
  decay_per_day: z.number().default(0.98),
  /** ... and are deleted below this confidence. */
  forget_below_confidence: z.number().default(0.1),
});
export type ForgettingConfig = z.output<typeof ForgettingConfigSchema>;

/**
 * `[modules.memory]`.
 *
 * ```toml
 * [modules.memory]
 * consolidate_idle_secs = 300
 * consolidate_every_messages = 40
 * recall_limit = 8
 *
 * [modules.memory.weights]
 * vector = 0.35
 * text = 0.25
 * ```
 */
export const MemoryConfigSchema = z.object({
  /** Consolidate a context after it has been quiet this long. */
  consolidate_idle_secs: uint().default(300),
  /** ... or as soon as this many new lines arrived since the last watermark. */
  consolidate_every_messages: uint().default(40),
  /** How often the background task checks contexts. */
  tick_secs: uint().default(15),
  /** At most this many log lines go into one consolidation. */
  max_lines_per_batch: uint().default(200),
  /** Wait this long before retrying a context whose consolidation failed. */
  retry_secs: uint().default(120),
  /** LLM purpose used for consolidation. */
  purpose: z.string().default("summarizer"),
  /** How her own lines are labelled in the transcript given to the summarizer. */
  self_label: z.string().default("我"),
  /** Offset of local time used in transcripts (minutes east of UTC). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /** Memories recalled into the prompt per turn. */
  recall_limit: uint().default(8),
  /** Candidates fetched from the store per kind of match before ranking. */
  candidate_limit: uint().default(32),
  /** Records scoring below this are never recalled. */
  min_score: z.number().default(0.05),
  weights: WeightsSchema.prefault({}),
  /** Recency decay time constant (days): `exp(-age / tau)`. */
  recency_tau_days: z.number().default(14),
  guild_scope: GuildScopeSchema.default("guild"),
  /**
   * Lets facts marked `global` in a DM become person-wide. Off by default: nothing learned in
   * a DM leaves that DM.
   */
  allow_global_from_dm: z.boolean().default(false),
  /** Extracted items below this importance are dropped as trivia. */
  min_importance: z.number().default(0.1),
  dedupe: DedupeConfigSchema.prefault({}),
  forgetting: ForgettingConfigSchema.prefault({}),
});
export type MemoryConfig = z.output<typeof MemoryConfigSchema>;

/** `MemoryConfig` with defaults, optionally overriding some fields (tests, embedding apps). */
export function memoryConfig(overrides: z.input<typeof MemoryConfigSchema> = {}): MemoryConfig {
  return MemoryConfigSchema.parse(overrides);
}

/**
 * Top-level `[memory.embedding]`. Embeddings are optional; without them retrieval uses full
 * text, recency and importance only.
 *
 * ```toml
 * [memory.embedding]
 * provider = "openai-compatible"
 * base_url = "http://localhost:11434/v1"
 * model = "bge-m3"
 * ```
 */
export const EmbeddingConfigSchema = z.object({
  /** `"none"` (default) or `"openai-compatible"`. */
  provider: z.string().default("none"),
  /** API root, e.g. `https://api.openai.com/v1`; `/embeddings` is appended. */
  base_url: z.string().default(""),
  api_key: z.string().nullable().default(null),
  model: z.string().default(""),
  /** Requested output size, for models that support it. */
  dimensions: uint().nullable().default(null),
  timeout_secs: uint().default(10),
  /** Texts per request. */
  batch_size: uint().default(32),
});
export type EmbeddingConfig = z.output<typeof EmbeddingConfigSchema>;

/** `EmbeddingConfig` with defaults, optionally overriding some fields. */
export function embeddingConfig(
  overrides: z.input<typeof EmbeddingConfigSchema> = {},
): EmbeddingConfig {
  return EmbeddingConfigSchema.parse(overrides);
}
