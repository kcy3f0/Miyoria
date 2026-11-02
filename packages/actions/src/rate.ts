// Rate limits and cooldowns of medium / high risk capabilities: rolling 24-hour windows per
// capability and per capability and person, plus a minimum gap between runs.

import type { Limit, TierLimit } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Effective limits of one capability (tier defaults filled in). */
export interface Limits {
  perDay: number;
  perPersonPerDay: number;
  cooldownMs: number;
}

/** Configured limits first, then the capability's own defaults, then the tier's. */
export function effectiveLimits(
  own: Limit | undefined,
  tier: TierLimit,
  defaults: Partial<Limit> | null = null,
): Limits {
  return {
    perDay: own?.per_day ?? defaults?.per_day ?? tier.per_day,
    perPersonPerDay:
      own?.per_person_per_day ?? defaults?.per_person_per_day ?? tier.per_person_per_day,
    cooldownMs: own?.cooldown_ms ?? defaults?.cooldown_ms ?? tier.cooldown_ms,
  };
}

/** While the LLM budget is degraded: half the runs (at least one), twice the cooldown. */
export function tightened(limits: Limits): Limits {
  const half = (n: number) => (n === 0 ? 0 : Math.max(1, Math.floor(n / 2)));
  return {
    perDay: half(limits.perDay),
    perPersonPerDay: half(limits.perPersonPerDay),
    cooldownMs: limits.cooldownMs * 2,
  };
}

/** Recorded runs (allowed decisions), in memory. */
export class RateLimiter {
  /** Timestamps of runs by capability, oldest first. */
  readonly #runs = new Map<string, { at: number; person: string | null }[]>();

  #recent(capability: string, now: number): { at: number; person: string | null }[] {
    const runs = (this.#runs.get(capability) ?? []).filter((r) => now - r.at < DAY_MS);
    this.#runs.set(capability, runs);
    return runs;
  }

  /** Why a run now would exceed `limits`, or `null` when it is within them. */
  check(capability: string, person: string | null, limits: Limits, now: number): string | null {
    const runs = this.#recent(capability, now);
    const last = runs.at(-1);
    if (last !== undefined && now - last.at < limits.cooldownMs) {
      const wait = Math.ceil((limits.cooldownMs - (now - last.at)) / 1000);
      return `cooling down (${wait} s left)`;
    }
    if (runs.length >= limits.perDay) return `daily limit reached (${limits.perDay} per day)`;
    if (person !== null) {
      const theirs = runs.filter((r) => r.person === person).length;
      if (theirs >= limits.perPersonPerDay) {
        return `daily limit for this person reached (${limits.perPersonPerDay} per day)`;
      }
    }
    return null;
  }

  record(capability: string, person: string | null, now: number): void {
    this.#recent(capability, now).push({ at: now, person });
  }
}
