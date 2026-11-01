// Helpers shared by the HTTP-based providers.

import { STATUS_CODES } from "node:http";
import { errorMessage, isAbortError } from "@miyoria/kernel";
import { z } from "zod";
import { IdleTimer } from "./pcm.js";
import { type ProviderConfig, SpeechError } from "./types.js";

/** Validates a provider's free-form settings into its typed config. */
export function parseSettings<S extends z.ZodType>(schema: S, config: ProviderConfig): z.output<S> {
  const result = schema.safeParse(config.settings);
  if (result.success) return result.data;
  throw new SpeechError(`invalid provider settings: ${z.prettifyError(result.error)}`, {
    cause: result.error,
  });
}

/** `{base}/{path}` without doubled slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Headers carrying an optional bearer token. */
export function bearerHeaders(apiKey: string | null | undefined): Record<string, string> {
  const key = apiKey?.trim();
  if (!key) return {};
  if (!/^[\x21-\x7e]+$/.test(key)) throw new SpeechError("API key contains invalid characters");
  return { authorization: `Bearer ${key}` };
}

/** Like Rust's `StatusCode` display: `"400 Bad Request"`. */
function statusText(status: number): string {
  return `${status} ${STATUS_CODES[status] ?? "<unknown status code>"}`;
}

/**
 * Passes 2xx responses through; turns anything else into an error carrying the server's message
 * (`{"error":"..."}` or `{"error":{"message":"..."}}`).
 */
export async function ensureOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  let detail: string | null = null;
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value === "object" && value !== null && "error" in value) {
      const e = value.error;
      if (typeof e === "string") detail = e;
      else if (
        typeof e === "object" &&
        e !== null &&
        "message" in e &&
        typeof e.message === "string"
      )
        detail = e.message;
    }
  } catch {
    // not JSON
  }
  throw new SpeechHttpError(
    `HTTP ${statusText(response.status)}: ${detail ?? [...body].slice(0, 300).join("")}`,
    response.status,
  );
}

export class SpeechHttpError extends SpeechError {
  override name = "SpeechHttpError";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface PostOptions {
  headers?: Record<string, string>;
  body: string | FormData;
  /** Whole-request timeout (ASR). */
  timeoutMs?: number;
  /** Timeout while waiting for headers and between body chunks (streaming TTS). */
  idle?: IdleTimer;
  signal?: AbortSignal;
}

/**
 * POSTs and returns a 2xx response. Without `timeoutMs`, the caller owns `idle` and must keep
 * using it while reading the body.
 */
export async function post(url: string, options: PostOptions): Promise<Response> {
  const signals: AbortSignal[] = [];
  if (options.signal) signals.push(options.signal);
  if (options.timeoutMs !== undefined) signals.push(AbortSignal.timeout(options.timeoutMs));
  if (options.idle) signals.push(options.idle.signal);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: options.headers ?? {},
      body: options.body,
      signal: signals.length > 0 ? AbortSignal.any(signals) : null,
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw new SpeechError(`request to ${url} failed: ${describeFetchError(error)}`, {
      cause: error,
    });
  }
  return ensureOk(response);
}

/** Read timeout of a streaming provider: runs while waiting for headers and for each chunk. */
export function idleTimer(timeoutSecs: number): IdleTimer {
  return new IdleTimer(Math.max(1, timeoutSecs * 1000));
}

function describeFetchError(error: unknown): string {
  if (isAbortError(error)) return errorMessage(error);
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error ? `${errorMessage(error)} (${cause.message})` : errorMessage(error);
}
