// Speech interface.
//
// * `AsrProvider` turns one utterance into text; `TtsProvider` turns text into a stream of PCM
//   chunks. Both are mono, 16-bit.
// * `SpeechService` holds a fallback chain of each, built from `[speech]` config through
//   registered `AsrFactory` / `TtsFactory`s, and is provided as a service by the `speech` module.
//
// Third-party models (Qwen3-ASR, SenseVoice, Qwen3-TTS, GPT-SoVITS, ...) usually run as separate
// worker processes; providers here are clients.

import { errorMessage, getLogger } from "@miyoria/kernel";
import { type JsonValue, serviceKey } from "@miyoria/types";

const log = getLogger("speech");

/** Mono 16-bit PCM. */
export interface AudioBuf {
  sampleRate: number;
  samples: Int16Array;
}

/** Length of `audio` in whole milliseconds (0 when the rate is 0). */
export function durationMs(audio: AudioBuf): number {
  if (audio.sampleRate === 0) return 0;
  return Math.floor((audio.samples.length * 1000) / audio.sampleRate);
}

export interface AsrHint {
  /** Expected language (`zh`, `ja`, `en`, ...); `null` = auto-detect. */
  language: string | null;
  /** Vocabulary / context hint (names, game terms), if the model supports it. */
  prompt: string | null;
}

export const NO_HINT: Readonly<AsrHint> = Object.freeze({ language: null, prompt: null });

export interface Transcript {
  text: string;
  language: string | null;
  emotion: string | null;
  /** Non-speech events (laughter, applause, BGM, ...). */
  audio_events: string[];
}

export interface AsrProvider {
  /** Instance name from config, e.g. `"local"`. */
  readonly name: string;
  transcribe(audio: AudioBuf, hint: AsrHint, signal?: AbortSignal): Promise<Transcript>;
}

export interface TtsRequest {
  text: string;
  language: string | null;
  /** Emotion tag from the agent (`happy`, `annoyed`, ...). */
  emotion: string | null;
  /** Natural-language style instruction, if the model supports one. */
  instruct: string | null;
  /** Voice / speaker id understood by the provider (e.g. a cloned voice). */
  voice: string | null;
}

/** A `TtsRequest` with every optional field `null`. */
export function ttsRequest(
  text: string,
  fields: Partial<Omit<TtsRequest, "text">> = {},
): TtsRequest {
  return {
    text,
    language: fields.language ?? null,
    emotion: fields.emotion ?? null,
    instruct: fields.instruct ?? null,
    voice: fields.voice ?? null,
  };
}

/** A chunk of synthesized audio. Chunks of one stream share a sample rate. */
export type AudioChunk = AudioBuf;

/**
 * Synthesized audio as it is produced. Stop early with `break` (or `return()` on the
 * iterator); that releases the underlying connection.
 */
export type AudioStream = AsyncIterable<AudioChunk>;

export interface TtsProvider {
  readonly name: string;
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<AudioStream>;
}

/** `[speech.asr.<name>]` / `[speech.tts.<name>]` entry: `kind` plus free-form settings. */
export interface ProviderConfig {
  kind: string;
  settings: Record<string, JsonValue>;
}

export interface AsrFactory {
  readonly kinds: readonly string[];
  /** Throws on invalid settings. */
  build(name: string, config: ProviderConfig): AsrProvider;
}

export interface TtsFactory {
  readonly kinds: readonly string[];
  /** Throws on invalid settings. */
  build(name: string, config: ProviderConfig): TtsProvider;
}

export class SpeechError extends Error {
  override name = "SpeechError";
}

/** Fallback chains of ASR and TTS providers. */
export class SpeechService {
  readonly #asr: readonly AsrProvider[];
  readonly #tts: readonly TtsProvider[];

  constructor(asr: readonly AsrProvider[], tts: readonly TtsProvider[]) {
    this.#asr = [...asr];
    this.#tts = [...tts];
  }

  hasAsr(): boolean {
    return this.#asr.length > 0;
  }

  hasTts(): boolean {
    return this.#tts.length > 0;
  }

  /** Tries each ASR provider in order until one succeeds. Returns `[provider, transcript]`. */
  async transcribe(
    audio: AudioBuf,
    hint: AsrHint,
    signal?: AbortSignal,
  ): Promise<[string, Transcript]> {
    let last: unknown;
    for (const p of this.#asr) {
      try {
        return [p.name, await p.transcribe(audio, hint, signal)];
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn({ provider: p.name, err: errorMessage(error) }, "ASR failed, trying next");
        last = error;
      }
    }
    throw last ?? new SpeechError("no ASR provider configured");
  }

  /** Tries each TTS provider in order until one starts a stream. Returns `[provider, stream]`. */
  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<[string, AudioStream]> {
    let last: unknown;
    for (const p of this.#tts) {
      try {
        return [p.name, await p.synthesize({ ...request }, signal)];
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn({ provider: p.name, err: errorMessage(error) }, "TTS failed, trying next");
        last = error;
      }
    }
    throw last ?? new SpeechError("no TTS provider configured");
  }
}

export const SpeechServiceKey = serviceKey<SpeechService>("SpeechService");
