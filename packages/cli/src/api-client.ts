// Minimal Admin API client for the CLI (the routes legacy `miyoria_api::ApiClient` used for
// `status`, `module`, `decisions`, `events` and `persona`).
// TODO(integration): replace with `ApiClient` from `@miyoria/api` once it exports one.

import type { ModuleStatus } from "@miyoria/kernel";
import type { DecisionTrace, Envelope, Timestamp } from "@miyoria/types";

export interface HealthInfo {
  status: string;
  version: string;
}

export interface UsageInfo {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
}

export interface PersonaSectionInfo {
  key: string;
  body: string;
}

export interface DecisionRecordInfo {
  id: string;
  profile: string;
  ts: Timestamp;
  trace: DecisionTrace;
}

export class ApiClientError extends Error {
  override readonly name = "ApiClientError";

  constructor(
    message: string,
    readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ApiClient {
  readonly #base: URL;
  readonly #token: string;

  /** `baseUrl` is e.g. `http://127.0.0.1:7878`. */
  constructor(baseUrl: string, token: string) {
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch (error) {
      throw new ApiClientError(`invalid API base URL \`${baseUrl}\``, null, { cause: error });
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new ApiClientError(`invalid API base URL \`${baseUrl}\``);
    }
    this.#base = base;
    this.#token = token;
  }

  url(segments: readonly string[], query: Record<string, string> = {}): URL {
    const url = new URL(this.#base);
    const prefix = url.pathname.replace(/\/+$/, "");
    url.pathname = `${prefix}/api/${segments.map(encodeURIComponent).join("/")}`;
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  async #send(method: string, url: URL, body?: unknown, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ApiClientError(`cannot reach the admin API: ${(error as Error).message}`, null, {
        cause: error,
      });
    }
    if (response.ok) return response;
    const text = (await response.text().catch(() => "")).trim();
    let message = text === "" ? response.statusText || "error" : text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // not JSON
    }
    throw new ApiClientError(`admin API returned ${response.status}: ${message}`, response.status);
  }

  async #json<T>(
    method: string,
    segments: string[],
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.#send(method, this.url(segments), body, signal);
    return (await response.json()) as T;
  }

  health(signal?: AbortSignal): Promise<HealthInfo> {
    return this.#json("GET", ["health"], undefined, signal);
  }

  modules(): Promise<ModuleStatus[]> {
    return this.#json("GET", ["modules"]);
  }

  /** `action` is `enable`, `disable` or `restart`; returns the module's status afterwards. */
  moduleAction(id: string, action: string): Promise<ModuleStatus> {
    return this.#json("POST", ["modules", id, action]);
  }

  /** The newest `limit` attention decisions, newest first. */
  async decisions(limit: number): Promise<DecisionRecordInfo[]> {
    const response = await this.#send("GET", this.url(["decisions"], { limit: String(limit) }));
    return (await response.json()) as DecisionRecordInfo[];
  }

  /** Token usage per `provider:model` since the core started. */
  async usage(): Promise<Map<string, UsageInfo>> {
    const raw = await this.#json<Record<string, UsageInfo>>("GET", ["llm", "usage"]);
    return new Map(Object.entries(raw).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  persona(): Promise<PersonaSectionInfo[]> {
    return this.#json("GET", ["persona"]);
  }

  /** Replaces a persona section; returns the new version number. */
  async setPersonaAs(key: string, body: string, editedBy: string | null): Promise<number> {
    const response = await this.#json<{ version: number }>("PUT", ["persona", key], {
      body,
      ...(editedBy === null ? {} : { edited_by: editedBy }),
    });
    return response.version;
  }

  /**
   * Streams bus envelopes matching `topics` (`GET /api/events`, Server-Sent Events). Ends when
   * the server closes the stream or `signal` aborts.
   */
  async *events(topics: readonly string[], signal?: AbortSignal): AsyncGenerator<Envelope> {
    const query: Record<string, string> = topics.length > 0 ? { topics: topics.join(",") } : {};
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.#send(
        "GET",
        this.url(["events"], query),
        undefined,
        controller.signal,
      );
      if (!response.body) return;
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for await (const chunk of response.body) {
        for (const data of parser.feed(decoder.decode(chunk as Uint8Array, { stream: true }))) {
          try {
            yield JSON.parse(data) as Envelope;
          } catch (error) {
            throw new ApiClientError(
              `invalid event from the admin API: ${(error as Error).message}`,
            );
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}

/** Minimal Server-Sent Events parser: yields the `data` of each event. */
export class SseParser {
  #line = "";
  #data = "";
  #hasData = false;

  feed(chunk: string): string[] {
    const out: string[] = [];
    for (const c of chunk) {
      if (c !== "\n") {
        this.#line += c;
        continue;
      }
      const line = this.#line.endsWith("\r") ? this.#line.slice(0, -1) : this.#line;
      this.#line = "";
      if (line === "") {
        if (this.#hasData) {
          out.push(this.#data);
          this.#data = "";
          this.#hasData = false;
        }
      } else if (line.startsWith("data")) {
        let value = line.slice(4);
        if (value.startsWith(":")) value = value.slice(1);
        else if (value !== "") continue;
        if (this.#hasData) this.#data += "\n";
        this.#data += value.startsWith(" ") ? value.slice(1) : value;
        this.#hasData = true;
      }
    }
    return out;
  }
}
