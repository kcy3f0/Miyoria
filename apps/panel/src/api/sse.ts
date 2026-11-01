// Server-Sent Events over `fetch`. `EventSource` cannot send an
// `Authorization` header (nor the CSRF header the rest of the client sends),
// so the stream is read and parsed here instead
// (https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream).

import { type ApiClient, ApiError, describeError } from "./http";
import type { Envelope } from "./types";

export interface SseMessage {
  /** `event:` field; `"message"` when absent. */
  event: string;
  data: string;
  /** Last `id:` seen so far (the spec's "last event ID buffer"). */
  id: string | undefined;
}

/** Incremental parser: feed it decoded text chunks, get complete messages back. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private lastId: string | undefined;
  /** Server-requested reconnection delay (`retry:`), if any. */
  retry: number | undefined;

  /** The previous chunk ended in CR, so a leading LF completes that CRLF. */
  private skipLf = false;

  push(chunk: string): SseMessage[] {
    const text = this.skipLf && chunk.startsWith("\n") ? chunk.slice(1) : chunk;
    this.skipLf = false;
    this.buffer += text;
    const out: SseMessage[] = [];
    // Lines end with CRLF, LF or CR.
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buffer);
      if (!m) break;
      if (m[0] === "\r" && m.index === this.buffer.length - 1) this.skipLf = true;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  private line(line: string): SseMessage | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break;
    }
    return undefined;
  }

  private dispatch(): SseMessage | undefined {
    const had = this.data.length > 0;
    const msg: SseMessage = { event: this.event || "message", data: this.data.join("\n"), id: this.lastId };
    this.data = [];
    this.event = "";
    return had ? msg : undefined;
  }

  get lastEventId(): string | undefined {
    return this.lastId;
  }
}

/** Parses one SSE `data` payload into an envelope, or `undefined` if it isn't one. */
export function parseEnvelope(data: string): Envelope | undefined {
  try {
    const v = JSON.parse(data) as Partial<Envelope> | null;
    if (v && typeof v.id === "string" && typeof v.ts === "string" && v.event && typeof v.event.type === "string") {
      return v as Envelope;
    }
  } catch {
    // ignore malformed payloads
  }
  return undefined;
}

export type StreamStatus =
  | { state: "connecting"; attempt: number }
  | { state: "open" }
  | { state: "retrying"; attempt: number; inMs: number; error: string }
  | { state: "closed"; error?: string };

export interface StreamOptions {
  /** Topic patterns, e.g. `["agent.*", "voice.*"]`; empty = everything. */
  topics?: string[];
  onEnvelope: (env: Envelope) => void;
  onStatus?: (status: StreamStatus) => void;
  signal: AbortSignal;
  /** Backoff cap. */
  maxDelayMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** Exponential backoff with jitter: 1 s, 2 s, 4 s … capped. */
export function backoff(attempt: number, maxMs = 30_000): number {
  const base = Math.min(maxMs, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Follows `GET /api/events` until `signal` aborts, reconnecting with backoff.
 * A 401 or a missing endpoint stops for good (retrying would not help).
 */
export async function streamEvents(client: ApiClient, opts: StreamOptions): Promise<void> {
  const { signal, onEnvelope, onStatus } = opts;
  const topics = opts.topics?.filter(Boolean).join(",");
  let attempt = 0;
  let lastId: string | undefined;

  while (!signal.aborted) {
    attempt += 1;
    onStatus?.({ state: "connecting", attempt });
    const parser = new SseParser();
    let error: string;
    try {
      const headers = client.headers({ Accept: "text/event-stream", "Cache-Control": "no-cache" });
      if (lastId) headers["Last-Event-ID"] = lastId;
      const res = await fetch(client.url("/api/events", { topics }), { headers, signal, credentials: "same-origin" });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        let message = text;
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          /* not JSON */
        }
        const err = new ApiError(
          res.status === 401 ? "unauthorized" : res.status === 404 ? "not_provided" : "http",
          res.status,
          "/api/events",
          message || `HTTP ${res.status}`,
        );
        if (err.kind !== "http") {
          onStatus?.({ state: "closed", error: describeError(err) });
          return;
        }
        throw err;
      }
      onStatus?.({ state: "open" });
      attempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
          const env = parseEnvelope(msg.data);
          if (env) onEnvelope(env);
        }
        lastId = parser.lastEventId ?? lastId;
      }
      error = "串流已中斷";
    } catch (e) {
      if (signal.aborted) break;
      error = describeError(e);
    }
    if (signal.aborted) break;
    const inMs = parser.retry ?? backoff(Math.max(1, attempt), opts.maxDelayMs);
    onStatus?.({ state: "retrying", attempt, inMs, error });
    await sleep(inMs, signal);
  }
  onStatus?.({ state: "closed" });
}
