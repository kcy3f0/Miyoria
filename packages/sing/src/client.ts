// HTTP client of the song worker (`workers/sing/server.py`, docs/protocols/voice-link.md
// 「歌曲 Worker」). Everything it returns about a song (title, artist, lyrics) comes from YouTube or
// lrclib and is untrusted.

import { z } from "zod";

const LyricLineSchema = z.object({ t: z.number(), text: z.string() });

export const SongMetaSchema = z.object({
  id: z.string(),
  title: z.string().catch(""),
  artist: z.string().nullable().catch(null),
  duration_s: z.number().nullable().catch(null),
  lyrics: z
    .object({ synced: z.boolean().catch(false), lines: z.array(LyricLineSchema).catch([]) })
    .nullable()
    .catch(null),
  play: z.object({
    sample_rate: z.number().int().positive(),
    samples: z.number().int().nullable(),
  }),
  pitch: z.record(z.string(), z.unknown()).catch({}),
  timings: z.record(z.string(), z.number()).catch({}),
  peak_vram_mb: z.number().nullable().catch(null),
});
export type SongMeta = z.output<typeof SongMetaSchema>;
export type LyricLine = z.output<typeof LyricLineSchema>;

export const WorkerJobSchema = z.object({
  id: z.string(),
  state: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  stage: z.string().catch(""),
  progress: z.number().catch(0),
  error: z.string().nullable().catch(null),
  song_id: z.string().nullable().catch(null),
  cached: z.boolean().catch(false),
  position: z.number().nullable().catch(null),
  source: z
    .object({ title: z.string().catch(""), artist: z.string().nullable().catch(null) })
    .nullable()
    .catch(null),
  song: SongMetaSchema.nullable().catch(null),
});
export type WorkerJob = z.output<typeof WorkerJobSchema>;

/** What a request names: a search, a link or a file of the worker's song library. */
export interface SongQuery {
  query?: string;
  url?: string;
  path?: string;
  /** Whole-song transposition in semitones (her voice follows). */
  key?: number;
}

/** The two tracks Core streams: the mix, and the converted vocal her mouth follows. */
export type SongTrack = "play_mix.pcm" | "play_vocals.pcm";

export class SingWorkerError extends Error {
  override readonly name = "SingWorkerError";
}

/** The song worker as the module uses it (`HttpSingWorker`, or a fake in tests). */
export interface SingWorker {
  submit(query: SongQuery, signal?: AbortSignal): Promise<WorkerJob>;
  job(id: string, signal?: AbortSignal): Promise<WorkerJob>;
  cancel(id: string): Promise<void>;
  /** PCM s16le mono at `song.play.sample_rate`. */
  audio(song: string, track: SongTrack, signal?: AbortSignal): Promise<Int16Array>;
  /** `null` when healthy, else why not. */
  health(signal?: AbortSignal): Promise<string | null>;
}

export class HttpSingWorker implements SingWorker {
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    this.#base = url.replace(/\/+$/, "");
    this.#timeoutMs = timeoutMs;
  }

  async #call(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const all = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.#base}${path}`, { ...init, signal: all });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SingWorkerError(`song worker unreachable at ${this.#base}: ${String(error)}`, {
        cause: error,
      });
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // not JSON
      }
      throw new SingWorkerError(message);
    }
    return res;
  }

  async #job(path: string, init: RequestInit, signal?: AbortSignal): Promise<WorkerJob> {
    const res = await this.#call(path, init, this.#timeoutMs, signal);
    const body = (await res.json()) as { job?: unknown };
    const parsed = WorkerJobSchema.safeParse(body.job);
    if (!parsed.success) throw new SingWorkerError("song worker sent a malformed job");
    return parsed.data;
  }

  submit(query: SongQuery, signal?: AbortSignal): Promise<WorkerJob> {
    return this.#job(
      "/jobs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query),
      },
      signal,
    );
  }

  job(id: string, signal?: AbortSignal): Promise<WorkerJob> {
    return this.#job(`/jobs/${encodeURIComponent(id)}`, {}, signal);
  }

  async cancel(id: string): Promise<void> {
    await this.#call(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }, this.#timeoutMs);
  }

  async audio(song: string, track: SongTrack, signal?: AbortSignal): Promise<Int16Array> {
    const res = await this.#call(
      `/songs/${encodeURIComponent(song)}/files/${track}`,
      {},
      this.#timeoutMs * 10,
      signal,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const out = new Int16Array(bytes.byteLength >> 1);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
    return out;
  }

  async health(signal?: AbortSignal): Promise<string | null> {
    try {
      const res = await this.#call("/health", {}, this.#timeoutMs, signal);
      const body = (await res.json()) as { status?: unknown };
      return body.status === "ok" ? null : "song worker is not ok";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
