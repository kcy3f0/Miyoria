// `contextKeyString` is Rust `ContextKey`'s `Display` (`<platform>:<scope or dm>:<channel>`,
// voice contexts with a `voice:` infix), as used for config keys, settings keys and lanes.
import { type ContextKey, contextKeyString as contextDisplay } from "@miyoria/types";
import { z } from "zod";

/** How willing she is to talk in a channel. */
export type ChannelMode =
  /** Never replies. */
  | "off"
  /** Replies only when directly addressed. */
  | "mention-only"
  /** Replies when addressed and sometimes joins in on her own. */
  | "ambient"
  /** Replies to every turn. */
  | "always";

export const CHANNEL_MODES: readonly ChannelMode[] = ["off", "mention-only", "ambient", "always"];

export class ParseError extends Error {
  override readonly name = "ParseError";
}

/** Lenient parse (`Mention_Only`, `mention`, ...). Throws `ParseError`. */
export function parseChannelMode(s: string): ChannelMode {
  const v = s.trim().toLowerCase().replaceAll("_", "-");
  switch (v) {
    case "off":
      return "off";
    case "mention-only":
    case "mention":
      return "mention-only";
    case "ambient":
      return "ambient";
    case "always":
      return "always";
    default:
      throw new ParseError(`unknown channel mode \`${v}\``);
  }
}

/** How eagerly she joins conversations she was not addressed in. */
export type Activeness = "low" | "medium" | "high";

export const ACTIVENESS_LEVELS: readonly Activeness[] = ["low", "medium", "high"];

/** Throws `ParseError`. */
export function parseActiveness(s: string): Activeness {
  const v = s.trim().toLowerCase();
  switch (v) {
    case "low":
      return "low";
    case "medium":
    case "normal":
      return "medium";
    case "high":
      return "high";
    default:
      throw new ParseError(`unknown activeness \`${v}\``);
  }
}

/** Multiplier for the reply probability of ambient turns. */
export function probabilityFactor(level: Activeness): number {
  return level === "low" ? 0.5 : level === "high" ? 1.6 : 1.0;
}

/** Multiplier for the ambient cooldown. */
export function cooldownFactor(level: Activeness): number {
  return level === "low" ? 2.0 : level === "high" ? 0.5 : 1.0;
}

function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

/** Scales an ambient reply probability, clamped to `[0, 1]`. */
export function scaleByActiveness(level: Activeness, probability: number): number {
  return clamp01(probability * probabilityFactor(level));
}

export const ChannelModeSchema = z.enum(["off", "mention-only", "ambient", "always"]);
export const ActivenessSchema = z.enum(["low", "medium", "high"]);

/** `[modules.agent.attention]`: when she replies. */
export const AttentionConfigSchema = z.object({
  /** Minimum time between her replies to turns that did not address her. */
  cooldown_ms: z.number().int().nonnegative().default(5000),
  /** Window (in messages) for the anti-spam share check. */
  recent_window: z.number().int().nonnegative().default(20),
  /** Overrides the profile's `behavior.max_share_of_recent`. */
  max_share_of_recent: z.number().nullable().default(null),
  /** Topics that make a message more interesting to her. */
  keywords: z.array(z.string()).default([]),
  /** Ambient turns scoring below this are ignored. */
  gray_low: z.number().default(0.3),
  /** Ambient turns scoring at least this skip the LLM check. */
  gray_high: z.number().default(0.6),
  /** Reply probability when directly addressed. */
  direct_probability: z.number().default(1.0),
  /** Ask the `fast` model about gray-zone ambient turns. */
  llm_check: z.boolean().default(true),
  llm_check_timeout_ms: z.number().int().nonnegative().default(8000),
  /** Reply probability after the LLM check said yes. */
  llm_yes_probability: z.number().default(0.9),
});
export type AttentionConfig = z.output<typeof AttentionConfigSchema>;

/**
 * `[modules.agent.voice]`: conversation in voice channels. Voice attention is more
 * conservative than text: she mostly listens and only sometimes chimes in.
 */
export const VoiceConfigSchema = z.object({
  /** Quiet time after an utterance before her turn starts (the speaker may continue). */
  debounce_ms: z.number().int().nonnegative().default(700),
  /**
   * Upper bound on the debounce of one turn. While someone is speaking the debounce is
   * extended up to this.
   */
  max_debounce_ms: z.number().int().nonnegative().default(2500),
  /** Mode of voice contexts without a `channels` entry or runtime override. */
  default_mode: ChannelModeSchema.default("ambient"),
  /** Multiplies the reply probability of ambient voice turns. */
  ambient_factor: z.number().default(0.5),
  /**
   * Minimum time between her replies to voice turns that did not address her, counted from
   * when she last spoke.
   */
  cooldown_ms: z.number().int().nonnegative().default(20_000),
  /** Her maximum share of recent voice history for ambient turns. */
  max_share_of_recent: z.number().default(0.2),
  /** A question this soon after she spoke counts as addressed to her. */
  question_window_ms: z.number().int().nonnegative().default(8000),
  /** Ask the `fast` model about gray-zone ambient voice turns (adds latency). */
  llm_check: z.boolean().default(false),
  /** Sentences that have not started playing within this time are dropped. */
  speak_ttl_ms: z.number().int().nonnegative().default(30_000),
});
export type VoiceConfig = z.output<typeof VoiceConfigSchema>;

/** `[modules.agent]` config section. */
export const AgentConfigSchema = z.object({
  /** Quiet time after the last message before a turn starts. */
  debounce_ms: z.number().int().nonnegative().default(1500),
  /** A typing notification pushes the turn start to at least this far out. */
  typing_extend_ms: z.number().int().nonnegative().default(2500),
  /** Upper bound on the total debounce of one turn. */
  max_debounce_ms: z.number().int().nonnegative().default(4000),
  /** Messages kept per conversation context. */
  history_limit: z.number().int().nonnegative().default(50),
  /** Messages of history included in the prompt. */
  prompt_history: z.number().int().nonnegative().default(30),
  /** Overrides the profile's `behavior.default_channel_mode`. */
  default_mode: ChannelModeSchema.nullable().default(null),
  /**
   * Per-context modes. Keys are matched against the full context key
   * (`discord:<guild>:<channel>`), then `<platform>:<guild>`, then the bare channel id.
   */
  channels: z.record(z.string(), ChannelModeSchema).default({}),
  /** Overrides the profile's `behavior.initiative`. */
  default_activeness: ActivenessSchema.nullable().default(null),
  /** Per-context activeness, keyed like `channels`. */
  activeness: z.record(z.string(), ActivenessSchema).default({}),
  /** Treat messages from other bots as input (they are always recorded). */
  respond_to_bots: z.boolean().default(false),
  /** Reply messages are dropped if not sent within this time. */
  reply_ttl_ms: z.number().int().nonnegative().default(120_000),
  /** Longer replies are split into several messages. */
  max_message_chars: z.number().int().nonnegative().default(1900),
  /** Send direct replies as platform replies to the triggering message. */
  reply_reference: z.boolean().default(false),
  /** The typing indicator is resubmitted this often while generating. */
  typing_refresh_ms: z.number().int().nonnegative().default(8000),
  /** Offer registered tools to the model. */
  tools_enabled: z.boolean().default(true),
  /** Rounds of tool calls per turn before she must answer. */
  max_tool_steps: z.number().int().nonnegative().default(3),
  /** Time limit for one tool call. */
  tool_timeout_ms: z.number().int().nonnegative().default(10_000),
  /** Tool results are truncated to this many characters. */
  max_tool_result_chars: z.number().int().nonnegative().default(1000),
  temperature: z.number().nullable().default(null),
  max_tokens: z.number().int().nonnegative().nullable().default(null),
  /** A context with no activity for this long forgets its session. */
  session_idle_ms: z
    .number()
    .int()
    .nonnegative()
    .default(6 * 3600 * 1000),
  /** Seed for the decision sampler; random when unset. */
  seed: z.number().int().nonnegative().nullable().default(null),
  /** Time limit for each prompt contributor; slower ones are skipped. */
  contributor_timeout_ms: z.number().int().nonnegative().default(800),
  /** Contributed context added to the situation message is capped at this many characters. */
  max_context_chars: z.number().int().nonnegative().default(4000),
  /**
   * While the LLM budget is exhausted, her canned "out of energy" line is sent at most once
   * per context in this interval.
   */
  budget_notice_interval_ms: z
    .number()
    .int()
    .nonnegative()
    .default(3600 * 1000),
  attention: AttentionConfigSchema.prefault({}),
  voice: VoiceConfigSchema.prefault({}),
});
export type AgentConfig = z.output<typeof AgentConfigSchema>;

/** The defaults (Rust `AgentConfig::default()`). */
export function defaultAgentConfig(): AgentConfig {
  return AgentConfigSchema.parse({});
}

export function maxDebounceMs(config: AgentConfig): number {
  return Math.max(config.max_debounce_ms, config.debounce_ms);
}

export function typingRefreshMs(config: AgentConfig): number {
  return Math.max(config.typing_refresh_ms, 1000);
}

export function voiceMaxDebounceMs(voice: VoiceConfig): number {
  return Math.max(voice.max_debounce_ms, voice.debounce_ms);
}

/**
 * Mode for `context`, falling back to `default_mode`, then `profileDefault`. Voice contexts
 * fall back to `voice.default_mode` instead.
 */
export function modeFor(
  config: AgentConfig,
  context: ContextKey,
  profileDefault: ChannelMode,
): ChannelMode {
  const configured = lookup(config.channels, context);
  if (context.kind === "voice") return configured ?? config.voice.default_mode;
  return configured ?? config.default_mode ?? profileDefault;
}

/** Activeness for `context`, falling back to `default_activeness`, then `profileDefault`. */
export function activenessFor(
  config: AgentConfig,
  context: ContextKey,
  profileDefault: Activeness,
): Activeness {
  return lookup(config.activeness, context) ?? config.default_activeness ?? profileDefault;
}

function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Full context key, then `<platform>:<guild>`, then the bare channel id. */
function lookup<T>(map: Readonly<Record<string, T>>, context: ContextKey): T | undefined {
  if (Object.keys(map).length === 0) return undefined;
  const full = own(map, contextDisplay(context));
  if (full !== undefined) return full;
  if (context.scope !== null) {
    const scoped = own(map, `${context.platform}:${context.scope}`);
    if (scoped !== undefined) return scoped;
  }
  return own(map, context.channel);
}
