// Procedural blinking: `EyeOpenLeft` / `EyeOpenRight` are scaled by a blink curve on a
// randomised schedule (VTS only blinks by itself with face tracking).

import { z } from "zod";
import { clamp, type Random } from "./random.js";

/** `[blink]` section of the Stage config. */
export const BlinkConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Mean gap between blinks (ms). Gaps are `min_ms` + an exponential, cut at `max_ms`. */
  mean_ms: z.number().positive().default(3_800),
  min_ms: z.number().nonnegative().default(2_000),
  max_ms: z.number().positive().default(6_000),
  /** Closing time (ms). */
  close_ms: z.number().positive().default(120),
  /** Time fully closed (ms). */
  closed_ms: z.number().nonnegative().default(30),
  /** Opening time (ms). */
  open_ms: z.number().positive().default(180),
  /** Chance that a blink is followed by a second one. */
  double_chance: z.number().min(0).max(1).default(0.15),
  /** Gap before the second blink (ms). */
  double_gap_ms: z.number().nonnegative().default(140),
  /** Chance of a blink when she starts a sentence. */
  speech_chance: z.number().min(0).max(1).default(0.35),
});
export type BlinkConfig = z.output<typeof BlinkConfigSchema>;

type Phase = "idle" | "closing" | "closed" | "opening";

/**
 * Blink state machine. `update` returns how open the eyes are, 0 (shut) .. 1 (as the pose
 * says); multiply the eye-open parameters by it.
 */
export class BlinkScheduler {
  readonly #c: BlinkConfig;
  readonly #random: Random;
  #phase: Phase = "idle";
  /** Time in the current phase (ms). */
  #t = 0;
  /** Time until the next blink starts (idle phase). */
  #wait: number;
  #rate = 1;
  #pendingDouble = false;
  /** The next blink is the second of a double. */
  #second = false;
  #sinceBlink = Number.POSITIVE_INFINITY;
  #count = 0;

  constructor(config: BlinkConfig, random: Random) {
    this.#c = config;
    this.#random = random;
    this.#wait = this.#gap();
  }

  /** Blinks started so far. */
  count(): number {
    return this.#count;
  }

  /** Blink rate multiplier (> 1 blinks more often), e.g. from the emotion. */
  setRate(rate: number): void {
    this.#rate = clamp(Number.isFinite(rate) ? rate : 1, 0.1, 5);
  }

  /** Next gap, in ms at rate 1 (`#wait` counts rate-scaled time). */
  #gap(): number {
    const { min_ms, max_ms, mean_ms } = this.#c;
    const lo = Math.min(min_ms, max_ms);
    const hi = Math.max(min_ms, max_ms);
    const extra = Math.max(mean_ms - lo, 1);
    for (let i = 0; i < 8; i++) {
      const g = lo + this.#random.exponential(extra);
      if (g <= hi) return g;
    }
    return this.#random.range(lo, hi);
  }

  /** Blinks soon (e.g. at a sentence start), unless she just blinked. */
  nudge(): void {
    if (this.#phase === "idle" && this.#sinceBlink > 700) this.#wait = Math.min(this.#wait, 60);
  }

  /** At a sentence start: blinks with `speech_chance`. */
  onSpeech(): void {
    if (this.#random.chance(this.#c.speech_chance)) this.nudge();
  }

  update(dtMs: number): number {
    if (!this.#c.enabled) return 1;
    const dt = Math.max(dtMs, 0);
    this.#sinceBlink += dt;
    this.#t += dt;
    for (let guard = 0; guard < 8; guard++) {
      switch (this.#phase) {
        case "idle":
          this.#wait -= dt * this.#rate;
          this.#t = 0;
          if (this.#wait > 0) return 1;
          this.#start();
          continue;
        case "closing": {
          if (this.#t < this.#c.close_ms) {
            const u = this.#t / this.#c.close_ms;
            return 1 - u * u;
          }
          this.#t -= this.#c.close_ms;
          this.#phase = "closed";
          continue;
        }
        case "closed":
          if (this.#t < this.#c.closed_ms) return 0;
          this.#t -= this.#c.closed_ms;
          this.#phase = "opening";
          continue;
        case "opening": {
          if (this.#t < this.#c.open_ms) {
            const u = this.#t / this.#c.open_ms;
            return 1 - (1 - u) * (1 - u);
          }
          this.#phase = "idle";
          this.#t = 0;
          if (this.#pendingDouble) {
            this.#pendingDouble = false;
            this.#second = true;
            this.#wait = this.#c.double_gap_ms;
          } else {
            this.#wait = this.#gap();
          }
          return 1;
        }
      }
    }
    return 1;
  }

  #start(): void {
    this.#phase = "closing";
    this.#t = 0;
    this.#count += 1;
    this.#sinceBlink = 0;
    // Never more than two in a row.
    this.#pendingDouble = !this.#second && this.#random.chance(this.#c.double_chance);
    this.#second = false;
  }
}
