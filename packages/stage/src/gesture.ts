// Gestures: the model's own animations and decals (`[gesture.<name>]` in `avatar.toml`),
// started by emotions or while she is quiet, held for a while and then taken back.
//
// Each gesture has a cooldown (no identical retrigger within it), at most one gesture runs per
// `group` (e.g. both hands), and any two gesture starts are at least `min_gap_ms` apart. An
// emotion picks one of its variants at random, preferring one that did not run last; an emotion
// gesture can take over a group from an idle gesture (closing it first).

import { z } from "zod";
import type { AvatarAction, AvatarProfile, Gesture } from "./avatar.js";
import type { VtsCommand } from "./emotion.js";
import type { Random } from "./random.js";

/** `[gesture]` section of the Stage config. */
export const GestureConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Least time between two gesture starts (ms). */
  min_gap_ms: z.number().nonnegative().default(8_000),
  /** Scale of every emotion's `gesture_chance`. */
  chance_scale: z.number().nonnegative().default(1),
  /** Gestures while she is quiet (`[idle]` in `avatar.toml`). */
  idle: z.boolean().default(true),
  /** Wait after closing a gesture before opening another one in the same group (ms). */
  switch_ms: z.number().nonnegative().default(1_300),
});
export type GestureConfig = z.output<typeof GestureConfigSchema>;

interface Running {
  gesture: Gesture;
  until: number;
  idle: boolean;
}

interface Pending {
  gesture: Gesture;
  at: number;
  holdMs: number;
  idle: boolean;
}

function open(action: AvatarAction): VtsCommand {
  return action.type === "expression"
    ? { type: "expression", file: action.file, active: true }
    : { type: "hotkey", name: action.name };
}

function close(g: Gesture): VtsCommand | null {
  if (g.close) {
    return g.close.type === "expression"
      ? { type: "expression", file: g.close.file, active: false }
      : { type: "hotkey", name: g.close.name };
  }
  return g.open.type === "expression"
    ? { type: "expression", file: g.open.file, active: false }
    : null;
}

export class GestureController {
  readonly #c: GestureConfig;
  readonly #profile: AvatarProfile;
  readonly #random: Random;
  #running: Running[] = [];
  #pending: Pending[] = [];
  /** Gesture name → last start. */
  readonly #lastStart = new Map<string, number>();
  #lastAny = Number.NEGATIVE_INFINITY;
  #lastName: string | null = null;
  #speaking = false;
  /** Last time she spoke or showed an emotion. */
  #activeAt: number;
  #nextIdle: number;

  constructor(profile: AvatarProfile, config: GestureConfig, random: Random, now = 0) {
    this.#c = config;
    this.#profile = profile;
    this.#random = random;
    this.#activeAt = now;
    this.#nextIdle = now + this.#idleGap();
  }

  /** Names of the gestures being shown. */
  active(): string[] {
    return this.#running.map((r) => r.gesture.name);
  }

  #idleGap(): number {
    const [lo, hi] = this.#profile.idle.everyMs;
    return this.#random.range(lo, hi);
  }

  #ready(g: Gesture, now: number): boolean {
    if (this.#running.some((r) => r.gesture.name === g.name)) return false;
    if (this.#pending.some((p) => p.gesture.name === g.name)) return false;
    const last = this.#lastStart.get(g.name);
    return last === undefined || now - last >= g.cooldownMs;
  }

  /** Busy groups: running or about to open. */
  #holder(group: string): Running | Pending | undefined {
    return (
      this.#running.find((r) => r.gesture.group === group) ??
      this.#pending.find((p) => p.gesture.group === group)
    );
  }

  #choose(names: readonly string[], now: number, idle: boolean): Gesture | null {
    const candidates: Gesture[] = [];
    for (const name of names) {
      const g = this.#profile.gestures.get(name);
      if (!g || !this.#ready(g, now)) continue;
      const holder = g.group === null ? undefined : this.#holder(g.group);
      // Emotion gestures may replace a running idle gesture; nothing replaces anything else.
      if (holder && (idle || !("until" in holder) || !holder.idle)) continue;
      candidates.push(g);
    }
    if (candidates.length === 0) return null;
    const fresh = candidates.filter((g) => g.name !== this.#lastName);
    return this.#random.pick(fresh.length > 0 ? fresh : candidates);
  }

  #start(g: Gesture, now: number, idle: boolean, out: VtsCommand[]): void {
    const holdMs = this.#random.range(g.holdMs[0], g.holdMs[1]);
    this.#lastStart.set(g.name, now);
    this.#lastAny = now;
    this.#lastName = g.name;
    const holder = g.group === null ? undefined : this.#holder(g.group);
    if (holder && "until" in holder) {
      // Take the group over from an idle gesture: close it, open after the switch time.
      this.#finish(holder, out);
      this.#pending.push({ gesture: g, at: now + this.#c.switch_ms, holdMs, idle });
      return;
    }
    out.push(open(g.open));
    this.#running.push({ gesture: g, until: now + holdMs, idle });
  }

  #finish(r: Running, out: VtsCommand[]): void {
    this.#running = this.#running.filter((x) => x !== r);
    const cmd = close(r.gesture);
    if (cmd) out.push(cmd);
  }

  /** An emotion marker: maybe starts one of its gestures. */
  onEmotion(emotion: string, intensity: number, now: number): VtsCommand[] {
    this.#activeAt = now;
    if (!this.#c.enabled) return [];
    const pose = this.#profile.poses.get(emotion.trim().toLowerCase());
    if (!pose || pose.gestures.length === 0) return [];
    if (now - this.#lastAny < this.#c.min_gap_ms) return [];
    const strength = Math.min(Math.max(Number.isFinite(intensity) ? intensity : 1, 0), 1);
    const p = pose.gestureChance * this.#c.chance_scale * (0.4 + 0.6 * strength);
    if (!this.#random.chance(p)) return [];
    const g = this.#choose(pose.gestures, now, false);
    if (!g) return [];
    const out: VtsCommand[] = [];
    this.#start(g, now, false, out);
    return out;
  }

  setSpeaking(speaking: boolean, now: number): void {
    this.#speaking = speaking;
    this.#activeAt = now;
  }

  /** Ends gestures whose hold is over, opens pending ones, and starts idle gestures. */
  tick(now: number): VtsCommand[] {
    const out: VtsCommand[] = [];
    for (const r of [...this.#running]) if (now >= r.until) this.#finish(r, out);
    for (const p of [...this.#pending]) {
      if (now < p.at) continue;
      this.#pending = this.#pending.filter((x) => x !== p);
      out.push(open(p.gesture.open));
      this.#running.push({ gesture: p.gesture, until: now + p.holdMs, idle: p.idle });
    }
    const idle = this.#profile.idle;
    if (
      this.#c.enabled &&
      this.#c.idle &&
      idle.gestures.length > 0 &&
      !this.#speaking &&
      now >= this.#nextIdle &&
      now - this.#activeAt >= idle.afterMs
    ) {
      this.#nextIdle = now + this.#idleGap();
      if (now - this.#lastAny >= this.#c.min_gap_ms) {
        const g = this.#choose(idle.gestures, now, true);
        if (g) this.#start(g, now, true, out);
      }
    }
    return out;
  }

  /** Takes every running gesture back (e.g. VTS reconnected) and forgets pending ones. */
  reset(): VtsCommand[] {
    const out: VtsCommand[] = [];
    for (const r of [...this.#running]) this.#finish(r, out);
    this.#pending = [];
    return out;
  }
}
