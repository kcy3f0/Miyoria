// Barge-in: stop her playback when someone talks over her.

import { getLogger } from "@miyoria/kernel";
import type { BargeInMode } from "./config.js";
import type { Stoppable } from "./link/playback.js";

const log = getLogger("voice.barge");

interface Active {
  token: number;
  handle: Stoppable;
  stopped: boolean;
}

/**
 * Tracks her current playback per guild and stops it once a listener has been talking for
 * `thresholdMs`.
 */
export class BargeIn {
  readonly #mode: BargeInMode;
  readonly #thresholdMs: number;
  readonly #fadeMs: number;
  readonly #active = new Map<string, Active>();
  #next = 1;

  constructor(mode: BargeInMode, thresholdMs: number, fadeMs: number) {
    this.#mode = mode;
    this.#thresholdMs = thresholdMs;
    this.#fadeMs = fadeMs;
  }

  /** Registers the playback now running in `guild`. Returns a token for `unregister`. */
  register(guild: string, handle: Stoppable): number {
    const token = this.#next++;
    this.#active.set(guild, { token, handle, stopped: false });
    return token;
  }

  unregister(guild: string, token: number): void {
    if (this.#active.get(guild)?.token === token) this.#active.delete(guild);
  }

  /**
   * Reports that a consented, non-self participant in `guild` has been speaking for
   * `speechRunMs`. Returns whether this stopped a playback.
   */
  observe(guild: string, speechRunMs: number): boolean {
    if (this.#mode === "ignore" || speechRunMs < this.#thresholdMs) return false;
    const a = this.#active.get(guild);
    if (!a || a.stopped) return false;
    a.stopped = true;
    log.info({ guild, speech_run_ms: speechRunMs }, "barge-in: stopping playback");
    a.handle.stop(this.#fadeMs);
    return true;
  }
}
