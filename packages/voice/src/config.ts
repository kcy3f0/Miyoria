// `[modules.voice]` config and the profile's `voice.toml`.

import type { JsonObject } from "@miyoria/types";
import { z } from "zod";
import { DEFAULT_SEGMENTER, type SegmenterConfig } from "./segment.js";

/** What happens when someone talks over her: `stop` (fade out and stop) or `ignore`. */
export const BargeInModeSchema = z.enum(["stop", "ignore"]);
export type BargeInMode = z.output<typeof BargeInModeSchema>;

/** `[modules.voice]` config section. */
export const VoiceConfigSchema = z.object({
  /** `opt-out` (default): listen unless a user opted out. `opt-in`: only users who opted in. */
  consent: z.enum(["opt-out", "opt-in"]).default("opt-out"),
  /** Low energy for this long ends an utterance. Default 600. */
  end_silence_ms: z.number().int().nonnegative().default(600),
  /** Utterances are cut at this length. Default 15 000. */
  max_utterance_ms: z.number().int().nonnegative().default(15_000),
  /** Shorter utterances are dropped. Default 300. */
  min_utterance_ms: z.number().int().nonnegative().default(300),
  /** Utterances with less voiced audio are dropped. Default 200. */
  min_voiced_ms: z.number().int().nonnegative().default(200),
  /** Convert transcripts to Traditional Chinese (Taiwan). Default true. */
  to_traditional: z.boolean().default(true),
  /** Concurrent ASR requests across speakers. Default 2. */
  asr_concurrency: z.number().int().nonnegative().default(2),
  /** ASR language hint (`zh`, ...). Default auto-detect. */
  asr_language: z.string().nullable().default(null),
  /** Vocabulary hint for ASR (her name, nicknames, game terms). */
  asr_prompt: z.string().nullable().default(null),
  /** Append the display names of people in the channel to the ASR prompt. Default false. */
  asr_prompt_participants: z.boolean().default(false),
  /** Extra hallucination phrases to drop (substring match). */
  hallucinations: z.array(z.string()).default([]),
  /** Barge-in behaviour. Default `stop`. */
  barge_in: BargeInModeSchema.default("stop"),
  /** Someone must talk this long over her before she stops. Default 600. */
  barge_in_ms: z.number().int().nonnegative().default(600),
  /** Fade-out when stopping for barge-in. Default 150. */
  barge_in_fade_ms: z.number().int().nonnegative().default(150),
  /** Language hint sent to TTS. Default `Chinese`. */
  tts_language: z.string().default("Chinese"),
  /**
   * Speak in this language (e.g. `Japanese`): every line is translated by the LLM right before
   * TTS and sent to TTS with this language; subtitles, the chat log and memory keep the original.
   * Default null (speak what she wrote).
   */
  tts_translate: z.string().nullable().default(null),
  /** LLM purpose used for `tts_translate`. Default `fast`. */
  tts_translate_purpose: z.string().default("fast"),
  /**
   * Where the broadcast encoder (OBS) pushes for Discord Go Live. The voice node's ffmpeg is the
   * RTMP server (`-listen 1`) unless the URL asks otherwise. Default matches the documented OBS
   * setup (server `rtmp://127.0.0.1:1935/live`, key `miyoria`).
   */
  golive_source: z.string().default("rtmp://127.0.0.1:1935/live/miyoria"),
});
export type VoiceConfig = z.output<typeof VoiceConfigSchema>;

/** Segmenter settings from the config (sample rate left at the default). */
export function segmenterConfig(config: VoiceConfig): SegmenterConfig {
  return {
    ...DEFAULT_SEGMENTER,
    endSilenceMs: Math.max(20, config.end_silence_ms),
    maxUtteranceMs: Math.max(500, config.max_utterance_ms),
    minUtteranceMs: config.min_utterance_ms,
    minVoicedMs: config.min_voiced_ms,
  };
}

const RawProfileSchema = z.object({
  provider: z.string().nullable().optional(),
  voice: z.string().nullable().optional(),
  clone: z.record(z.string(), z.unknown()).nullable().optional(),
  emotion: z.object({ instruct: z.record(z.string(), z.string()).default({}) }).prefault({}),
});

export class VoiceProfileError extends Error {
  override name = "VoiceProfileError";
}

/** The parts of a profile's `voice.toml` this module uses. */
export class VoiceProfile {
  /**
   * Preferred TTS provider kind (informational; the speech fallback chain decides which
   * provider runs).
   */
  readonly provider: string | null;
  /** Voice name registered with the TTS worker. Defaults to the profile id. */
  readonly voice: string;
  /** The profile has a cloned voice (`[clone]`). */
  readonly cloned: boolean;
  /** `[emotion.instruct]`: emotion → style instruction (keys lower-case, ascending). */
  readonly instruct: ReadonlyMap<string, string>;

  constructor(init: {
    provider: string | null;
    voice: string;
    cloned: boolean;
    instruct: ReadonlyMap<string, string>;
  }) {
    this.provider = init.provider;
    this.voice = init.voice;
    this.cloned = init.cloned;
    this.instruct = init.instruct;
  }

  /** Parses `voice.toml` (`null` when the profile has none). */
  static parse(profileId: string, table: JsonObject | null): VoiceProfile {
    const result = RawProfileSchema.safeParse(table ?? {});
    if (!result.success) {
      throw new VoiceProfileError(`invalid voice.toml: ${z.prettifyError(result.error)}`, {
        cause: result.error,
      });
    }
    const raw = result.data;
    const voice = raw.voice?.trim() || profileId;
    const instruct = Object.entries(raw.emotion.instruct)
      .map(([k, v]): [string, string] => [k.toLowerCase(), v.trim()])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return new VoiceProfile({
      provider: raw.provider ?? null,
      voice,
      cloned: raw.clone !== undefined && raw.clone !== null,
      instruct: new Map(instruct),
    });
  }

  /** Style instruction for `emotion`, if the profile defines one. */
  instructFor(emotion: string | null): string | null {
    if (emotion === null) return null;
    const s = this.instruct.get(emotion.trim().toLowerCase());
    return s ? s : null;
  }
}
