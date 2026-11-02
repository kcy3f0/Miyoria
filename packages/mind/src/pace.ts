// When she thinks: the adaptive heartbeat and the rate caps. Pure; `now` is epoch ms.
//
// Heartbeat: about every 12 minutes when nothing goes on, every 4 when a channel is lively or
// she is in voice with people, every 3 while an agenda item is due. Each heartbeat that found
// nothing new makes the next one 1.5× sparser (up to 3×); quiet hours and a degraded LLM
// budget make it 3× sparser each; strong boredom a little denser. Always between
// `min_interval_secs` and `max_heartbeat_mins`; none while the budget is exhausted.

import type { MindConfig } from "./config.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type BudgetState = "ok" | "degraded" | "exhausted";

/** What the heartbeat depends on. */
export interface Pace {
  /** A text channel she follows is lively. */
  lively: boolean;
  /** She is in a voice channel with people. */
  inVoice: boolean;
  /** An open agenda item is due. */
  agendaDue: boolean;
  /** Quiet hours. */
  night: boolean;
  budget: BudgetState;
  /** Heartbeats in a row that found nothing new. */
  idleStreak: number;
  /** 0..1 */
  boredom: number;
}

/** Time until her next heartbeat (ms), or `null` for none. */
export function heartbeatMs(pace: Pace, config: MindConfig): number | null {
  if (pace.budget === "exhausted") return null;
  let mins = 12;
  if (pace.lively || pace.inVoice) mins = 4;
  if (pace.agendaDue) mins = Math.min(mins, 3);
  mins *= 1.5 ** Math.min(Math.max(pace.idleStreak, 0), 3);
  if (pace.night) mins *= 3;
  if (pace.budget === "degraded") mins *= 3;
  if (pace.boredom >= 0.7) mins *= 0.75;
  const min = config.min_interval_secs * 1000;
  const max = Math.max(config.max_heartbeat_mins * MINUTE_MS, min);
  return Math.min(Math.max(mins * MINUTE_MS, min), max);
}

/** Local hour `now` falls in quiet hours (start inclusive, end exclusive). */
export function inQuietHours(now: number, config: MindConfig): boolean {
  const start = config.quiet_start_hour % 24;
  const end = config.quiet_end_hour % 24;
  if (start === end) return false;
  const local = now + config.utc_offset_minutes * MINUTE_MS;
  const hour = Math.floor((((local % (24 * HOUR_MS)) + 24 * HOUR_MS) % (24 * HOUR_MS)) / HOUR_MS);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Her calls in the last hour and the gap between calls. */
export class CallLog {
  #calls: number[] = [];
  total = 0;

  constructor(private readonly config: MindConfig) {}

  #recent(now: number): number[] {
    this.#calls = this.#calls.filter((at) => now - at < HOUR_MS);
    return this.#calls;
  }

  record(now: number): void {
    this.#recent(now).push(now);
    this.total++;
  }

  lastHour(now: number): number {
    return this.#recent(now).length;
  }

  last(): number | null {
    return this.#calls.at(-1) ?? null;
  }

  /** How long until a call is allowed (0 = now); `Infinity` when calls are capped at 0. */
  waitMs(now: number): number {
    const max = this.config.max_calls_per_hour;
    if (max === 0) return Number.POSITIVE_INFINITY;
    const calls = this.#recent(now);
    const last = calls.at(-1);
    let wait = last === undefined ? 0 : last + this.config.min_interval_secs * 1000 - now;
    if (calls.length >= max) {
      const oldest = calls[calls.length - max] as number;
      wait = Math.max(wait, oldest + HOUR_MS - now);
    }
    return Math.max(wait, 0);
  }
}
