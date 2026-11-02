// Her set list: the songs requested, preparing on the worker, ready, playing and recently done.
// In memory only: the worker keeps the converted songs, so a restart only forgets the list.

import {
  type AccountRef,
  type ContextKey,
  safeName,
  sameAccount,
  type Timestamp,
} from "@miyoria/types";
import type { SongMeta } from "./client.js";

/** Short number used in commands and by her tools (`#3`). */
export type SongNo = number;

export type SongState = "preparing" | "ready" | "playing" | "done" | "failed" | "cancelled";

export interface SongEntry {
  no: SongNo;
  /** What was asked for (a name, maybe with the artist, or a link). Untrusted. */
  query: string;
  key: number;
  requester: AccountRef | null;
  requester_name: string;
  /** Where it was asked for. */
  context: ContextKey | null;
  /**
   * Sung as soon as she is free once ready (a command or the request queue asked; commands are
   * forced overrides). Otherwise she picks the moment.
   */
  forced: boolean;
  state: SongState;
  /** Worker stage while preparing (`download`, `separate`, `convert`, ...). */
  stage: string;
  progress: number;
  error: string | null;
  job: string | null;
  song: SongMeta | null;
  /** `[modules.queue]` item this song came from. */
  queue_item: number | null;
  created_at: Timestamp;
  ready_at: Timestamp | null;
  /** How often her mind was told it is ready. */
  reminders: number;
  last_reminder_ms: number | null;
}

export type NewSong = Pick<
  SongEntry,
  "query" | "key" | "requester" | "requester_name" | "context"
> &
  Partial<Pick<SongEntry, "forced" | "queue_item">>;

export class SetListError extends Error {
  override readonly name = "SetListError";
}

const OPEN: readonly SongState[] = ["preparing", "ready", "playing"];

/** One line naming a song for her or for a card: `「title」- artist`, escaped and short. */
export function songLabel(e: SongEntry): string {
  const title = e.song?.title?.trim() || e.query;
  const artist = e.song?.artist?.trim();
  return `「${safeName(title, 60)}」${artist ? ` - ${safeName(artist, 40)}` : ""}`;
}

export class SetList {
  readonly #entries: SongEntry[] = [];
  #next = 1;

  constructor(
    private readonly limits: { max_pending: number; max_pending_per_user: number; history: number },
  ) {}

  /** Every entry still in the list, oldest first. */
  all(): SongEntry[] {
    return [...this.#entries];
  }

  get(no: SongNo): SongEntry | null {
    return this.#entries.find((e) => e.no === no) ?? null;
  }

  byJob(job: string): SongEntry | null {
    return this.#entries.find((e) => e.job === job) ?? null;
  }

  open(): SongEntry[] {
    return this.#entries.filter((e) => OPEN.includes(e.state));
  }

  preparing(): SongEntry[] {
    return this.#entries.filter((e) => e.state === "preparing");
  }

  ready(): SongEntry[] {
    return this.#entries.filter((e) => e.state === "ready");
  }

  playing(): SongEntry | null {
    return this.#entries.find((e) => e.state === "playing") ?? null;
  }

  /** The same song (by query and key, or by the worker's song id) already open. */
  findOpen(query: string, key: number): SongEntry | null {
    const q = query.trim().toLowerCase();
    return this.open().find((e) => e.key === key && e.query.trim().toLowerCase() === q) ?? null;
  }

  add(song: NewSong, now: Timestamp): SongEntry {
    const open = this.open();
    if (open.length >= this.limits.max_pending) {
      throw new SetListError(`the set list is full (${this.limits.max_pending} songs)`);
    }
    const requester = song.requester;
    if (
      requester !== null &&
      open.filter((e) => e.requester !== null && sameAccount(e.requester, requester)).length >=
        this.limits.max_pending_per_user
    ) {
      throw new SetListError(
        `already ${this.limits.max_pending_per_user} songs requested by this person`,
      );
    }
    const entry: SongEntry = {
      no: this.#next++,
      query: song.query,
      key: song.key,
      requester,
      requester_name: song.requester_name,
      context: song.context,
      forced: song.forced ?? false,
      state: "preparing",
      stage: "queued",
      progress: 0,
      error: null,
      job: null,
      song: null,
      queue_item: song.queue_item ?? null,
      created_at: now,
      ready_at: null,
      reminders: 0,
      last_reminder_ms: null,
    };
    this.#entries.push(entry);
    return entry;
  }

  /** Moves `e` to a final state and trims the history. */
  finish(e: SongEntry, state: "done" | "failed" | "cancelled", error: string | null = null): void {
    e.state = state;
    e.error = error;
    const closed = this.#entries.filter((x) => !OPEN.includes(x.state));
    for (const old of closed.slice(0, Math.max(0, closed.length - this.limits.history))) {
      this.#entries.splice(this.#entries.indexOf(old), 1);
    }
  }
}
