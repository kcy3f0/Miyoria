// Panel sessions: which messages carry live controls, who may use them, and when they expire.
//
// A platform opens a session for every message it sends from a reply with `session` set, keyed
// by the platform's message id. When the session expires the platform's `onExpire` callback
// disables the message's controls.

import { type AccountRef, type JsonValue, systemClock } from "@miyoria/types";
import type { SessionInfo } from "./components.js";
import type { ReplySession } from "./reply.js";

/** Default lifetime of a panel. */
export const SESSION_TTL_MS = 10 * 60_000;
/** Longest lifetime (Discord interaction tokens, needed to edit ephemeral replies, last 15 min). */
export const MAX_SESSION_TTL_MS = 14 * 60_000;

interface Entry {
  info: SessionInfo;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  onExpire: () => void | Promise<void>;
}

export interface PanelSessionsOptions {
  clock?: { now(): number };
  maxTtlMs?: number;
  /** Called when an `onExpire` callback fails. */
  onError?: (error: unknown) => void;
}

export class PanelSessions {
  readonly #entries = new Map<string, Entry>();
  readonly #clock: { now(): number };
  readonly #maxTtlMs: number;
  readonly #onError: (error: unknown) => void;

  constructor(options: PanelSessionsOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#maxTtlMs = options.maxTtlMs ?? MAX_SESSION_TTL_MS;
    this.#onError = options.onError ?? (() => undefined);
  }

  /** Tracks `messageId` (replacing an older session of the same message). */
  open(
    messageId: string,
    initiator: AccountRef,
    request: ReplySession,
    onExpire: () => void | Promise<void>,
  ): SessionInfo {
    this.close(messageId);
    const ttl = Math.min(Math.max(1_000, request.ttlMs ?? SESSION_TTL_MS), this.#maxTtlMs);
    const info: SessionInfo = {
      initiator,
      initiator_only: request.initiatorOnly ?? true,
      data: request.data ?? null,
    };
    const timer = setTimeout(() => this.#expire(messageId), ttl);
    (timer as { unref?: () => void }).unref?.();
    this.#entries.set(messageId, { info, expiresAt: this.#clock.now() + ttl, timer, onExpire });
    return info;
  }

  /** The live session of `messageId`, or `null`. */
  get(messageId: string | null | undefined): SessionInfo | null {
    if (!messageId) return null;
    const entry = this.#entries.get(messageId);
    if (!entry) return null;
    if (this.#clock.now() >= entry.expiresAt) {
      this.#expire(messageId);
      return null;
    }
    return entry.info;
  }

  /** Replaces the data of a live session. */
  update(messageId: string, data: JsonValue | null): void {
    const entry = this.#entries.get(messageId);
    if (entry) entry.info = { ...entry.info, data };
  }

  /** Forgets a session without disabling its controls. */
  close(messageId: string): void {
    const entry = this.#entries.get(messageId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#entries.delete(messageId);
  }

  /** Forgets every session (on shutdown). */
  closeAll(): void {
    for (const id of [...this.#entries.keys()]) this.close(id);
  }

  get size(): number {
    return this.#entries.size;
  }

  #expire(messageId: string): void {
    const entry = this.#entries.get(messageId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#entries.delete(messageId);
    try {
      void Promise.resolve(entry.onExpire()).catch(this.#onError);
    } catch (error) {
      this.#onError(error);
    }
  }
}
