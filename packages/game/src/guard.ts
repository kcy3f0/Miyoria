// The failure guard: after an action fails, the low-level move / mine actions are withheld for a
// while, so the next decision has to change method (plan with `obtain`, explore, craft what is
// missing) or goal instead of sending the same `mine` again. Pure; times are epoch ms.

import type { GameConfig } from "./config.js";

export interface FailureGuard {
  /** Actions withheld until `until`. */
  actions: string[];
  until: number;
  /** Why (the failure, first line), for her prompt and the trace. */
  why: string;
  /** A withheld proposal already asked for a quick new decision (only once per guard). */
  nudged: boolean;
}

type GuardConfig = Pick<GameConfig, "failure_guard_secs" | "guarded_actions">;

/** The guard a failure starts; `null` when it is turned off. */
export function guardAfter(cfg: GuardConfig, why: string, now: number): FailureGuard | null {
  if (cfg.failure_guard_secs <= 0 || cfg.guarded_actions.length === 0) return null;
  return {
    actions: [...cfg.guarded_actions],
    until: now + cfg.failure_guard_secs * 1000,
    why,
    nudged: false,
  };
}

/** The guard while it lasts, else `null`. */
export function activeGuard(guard: FailureGuard | null, now: number): FailureGuard | null {
  return guard !== null && now < guard.until ? guard : null;
}

/** Whether `action` is withheld right now. */
export function withheld(guard: FailureGuard | null, action: string, now: number): boolean {
  return activeGuard(guard, now)?.actions.includes(action) ?? false;
}

/**
 * The guard after `action` succeeded: a different (not withheld) action that worked means she
 * changed method, which ends it.
 */
export function afterSuccess(
  guard: FailureGuard | null,
  action: string,
  now: number,
): FailureGuard | null {
  const g = activeGuard(guard, now);
  return g && !g.actions.includes(action) ? null : g;
}

/** Prompt line while the guard lasts (the failure text is game data; the caller escapes it). */
export function guardNote(guard: FailureGuard | null, now: number): string | null {
  const g = activeGuard(guard, now);
  if (!g) return null;
  const secs = Math.max(1, Math.ceil((g.until - now) / 1000));
  return `暫時不能用 ${g.actions.join("、")}(還有 ${secs} 秒):上一個動作失敗了(${g.why})。換個方法(例如 obtain 缺的東西、explore)或換個目標,不要重試同一件事。`;
}

// ----- goals that keep failing -----

/** Goals (an action with its arguments) that failed in a row, and the ones withheld for it. */
export interface GoalRepeats {
  fails: Map<string, number>;
  held: Map<string, { until: number; why: string; nudged?: boolean }>;
}

export function newGoalRepeats(): GoalRepeats {
  return { fails: new Map(), held: new Map() };
}

/** Failure codes that say the goal cannot be done as asked: one is enough, for the session. */
export const FINAL_CODES: readonly string[] = ["invalid"];

type RepeatConfig = Pick<GameConfig, "repeat_failure_limit" | "repeat_guard_secs">;

/**
 * Records how goal `key` ended. A success clears it; the `repeat_failure_limit`-th failure in a
 * row withholds it for `repeat_guard_secs`, a final one (`FINAL_CODES`) for good.
 */
export function noteGoal(
  repeats: GoalRepeats,
  cfg: RepeatConfig,
  key: string,
  failure: { code: string; why: string } | null,
  now: number,
): void {
  if (failure === null) {
    repeats.fails.delete(key);
    repeats.held.delete(key);
    return;
  }
  if (cfg.repeat_failure_limit <= 0) return;
  const n = (repeats.fails.get(key) ?? 0) + 1;
  repeats.fails.set(key, n);
  const final = FINAL_CODES.includes(failure.code);
  if (final) {
    repeats.held.set(key, { until: Number.POSITIVE_INFINITY, why: failure.why });
  } else if (n >= cfg.repeat_failure_limit && cfg.repeat_guard_secs > 0) {
    repeats.held.set(key, { until: now + cfg.repeat_guard_secs * 1000, why: failure.why });
  }
}

/** Why goal `key` is withheld right now, or `null`. */
export function goalHeld(repeats: GoalRepeats, key: string, now: number): string | null {
  const held = repeats.held.get(key);
  if (!held) return null;
  if (now >= held.until) {
    repeats.held.delete(key);
    repeats.fails.delete(key);
    return null;
  }
  return held.why;
}

/** `true` the first time a withheld goal `key` was asked for again (a quick new decision, once). */
export function firstNudge(repeats: GoalRepeats, key: string): boolean {
  const held = repeats.held.get(key);
  if (!held || held.nudged) return false;
  held.nudged = true;
  return true;
}

/** Prompt line naming the goals withheld now (their failure texts are game data; escape them). */
export function goalRepeatNote(repeats: GoalRepeats, now: number): string | null {
  const lines: string[] = [];
  for (const [key, held] of repeats.held) {
    if (now >= held.until) continue;
    lines.push(`${key}(${held.why})`);
    if (lines.length >= 4) break;
  }
  if (lines.length === 0) return null;
  return `這些目標一直失敗,暫時不能再要:${lines.join("、")}。先弄到缺的東西、換個做法或換個目標,不要換個說法再要一次。`;
}
