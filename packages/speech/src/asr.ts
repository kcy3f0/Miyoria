// ASR providers: the Miyoria inference-worker protocol and OpenAI-compatible
// `/audio/transcriptions`.

import { errorMessage } from "@miyoria/kernel";
import { z } from "zod";
import { bearerHeaders, joinUrl, parseSettings, post } from "./http.js";
import {
  type AsrFactory,
  type AsrHint,
  type AsrProvider,
  type AudioBuf,
  type ProviderConfig,
  SpeechError,
  type Transcript,
} from "./types.js";
import { encodeWav } from "./wav.js";

const DEFAULT_TIMEOUT_SECS = 20;

function wavBlob(audio: AudioBuf): Blob {
  return new Blob([encodeWav(audio) as Uint8Array<ArrayBuffer>], { type: "audio/wav" });
}

async function readJson<S extends z.ZodType>(
  response: Response,
  schema: S,
  what: string,
): Promise<z.output<S>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new SpeechError(`${what}: ${errorMessage(error)}`, { cause: error });
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new SpeechError(`${what}: ${z.prettifyError(result.error)}`, { cause: result.error });
  }
  return result.data;
}

// ---------------------------------------------------------------- http-worker

/**
 * Settings of `HttpWorkerAsr` (`kind = "http-worker"`).
 *
 * ```toml
 * [speech.asr.local]
 * kind = "http-worker"
 * url = "http://127.0.0.1:8101"
 * timeout_secs = 20   # optional
 * ```
 */
export const HttpWorkerAsrConfigSchema = z.object({
  /** Worker root; `POST {url}/asr`. */
  url: z.string(),
  timeout_secs: z.number().int().nonnegative().default(DEFAULT_TIMEOUT_SECS),
});
export type HttpWorkerAsrConfig = z.output<typeof HttpWorkerAsrConfigSchema>;

const WorkerReplySchema = z.object({
  text: z.string(),
  language: z.string().nullable().default(null),
  emotion: z.string().nullable().default(null),
  audio_events: z.array(z.string()).default([]),
});

/** ASR client for an inference worker (see `docs/protocols/voice-link.md`). */
export class HttpWorkerAsr implements AsrProvider {
  readonly name: string;
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(name: string, config: HttpWorkerAsrConfig) {
    this.name = name;
    this.#url = joinUrl(config.url, "asr");
    this.#timeoutMs = Math.max(1, config.timeout_secs * 1000);
  }

  async transcribe(audio: AudioBuf, hint: AsrHint, signal?: AbortSignal): Promise<Transcript> {
    const form = new FormData();
    form.append("audio", wavBlob(audio), "audio.wav");
    if (hint.language !== null) form.append("language", hint.language);
    if (hint.prompt !== null) form.append("prompt", hint.prompt);
    if (hint.priority === "ahead") form.append("priority", "ahead");
    const response = await post(this.#url, {
      body: form,
      timeoutMs: this.#timeoutMs,
      ...(signal ? { signal } : {}),
    });
    const reply = await readJson(response, WorkerReplySchema, "invalid ASR worker response");
    return {
      text: reply.text,
      language: reply.language,
      emotion: reply.emotion,
      audio_events: reply.audio_events,
    };
  }
}

/** `AsrFactory` for `http-worker`. */
export class HttpWorkerAsrFactory implements AsrFactory {
  readonly kinds = ["http-worker"] as const;

  build(name: string, config: ProviderConfig): AsrProvider {
    return new HttpWorkerAsr(name, parseSettings(HttpWorkerAsrConfigSchema, config));
  }
}

// --------------------------------------------------------------------- openai

/**
 * Settings of `OpenAiAsr` (`kind = "openai"`).
 *
 * ```toml
 * [speech.asr.groq]
 * kind = "openai"
 * base_url = "https://api.groq.com/openai/v1"
 * api_key = "${GROQ_API_KEY}"
 * model = "whisper-large-v3-turbo"
 * ```
 */
export const OpenAiAsrConfigSchema = z.object({
  base_url: z.string().default("https://api.openai.com/v1"),
  api_key: z.string().nullable().default(null),
  model: z.string().default("whisper-1"),
  timeout_secs: z.number().int().nonnegative().default(DEFAULT_TIMEOUT_SECS),
});
export type OpenAiAsrConfig = z.output<typeof OpenAiAsrConfigSchema>;

const OpenAiReplySchema = z.object({ text: z.string() });

/**
 * Client for OpenAI-compatible `POST {base_url}/audio/transcriptions` (OpenAI, Groq,
 * faster-whisper-server, ...).
 */
export class OpenAiAsr implements AsrProvider {
  readonly name: string;
  readonly #url: string;
  readonly #model: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;

  constructor(name: string, config: OpenAiAsrConfig) {
    this.name = name;
    this.#url = joinUrl(config.base_url, "audio/transcriptions");
    this.#model = config.model;
    this.#headers = bearerHeaders(config.api_key);
    this.#timeoutMs = Math.max(1, config.timeout_secs * 1000);
  }

  async transcribe(audio: AudioBuf, hint: AsrHint, signal?: AbortSignal): Promise<Transcript> {
    const form = new FormData();
    form.append("file", wavBlob(audio), "audio.wav");
    form.append("model", this.#model);
    form.append("response_format", "json");
    if (hint.language !== null) form.append("language", hint.language);
    if (hint.prompt !== null) form.append("prompt", hint.prompt);
    const response = await post(this.#url, {
      headers: this.#headers,
      body: form,
      timeoutMs: this.#timeoutMs,
      ...(signal ? { signal } : {}),
    });
    const reply = await readJson(response, OpenAiReplySchema, "invalid transcription response");
    return {
      text: reply.text,
      // The plain `json` format does not report the detected language.
      language: hint.language,
      emotion: null,
      audio_events: [],
    };
  }

  /** Keeps the API key out of logs. */
  toJSON(): { name: string; url: string; model: string } {
    return { name: this.name, url: this.#url, model: this.#model };
  }
}

/** `AsrFactory` for `openai`. */
export class OpenAiAsrFactory implements AsrFactory {
  readonly kinds = ["openai"] as const;

  build(name: string, config: ProviderConfig): AsrProvider {
    return new OpenAiAsr(name, parseSettings(OpenAiAsrConfigSchema, config));
  }
}
