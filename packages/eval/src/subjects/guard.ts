// Subject `guard`: the failure guard of the game director (`packages/game/src/guard.ts`), asked
// about the decisions she actually made. A failure starts the guard; a later decision whose
// action it withholds never runs (`blocked`). Open loop: the recorded decisions after a block
// would have been different, so this answers "which of her retries would the code have let
// through", not "what she would have done instead".

import {
  activeGuard,
  afterSuccess,
  defaultGameConfig,
  type FailureGuard,
  goalHeld,
  guardAfter,
  newGoalRepeats,
  noteGoal,
} from "@miyoria/game";

import { ofType, type Trace } from "../trace.js";
import type { Subject } from "./types.js";

/** The code a recorded failure had, read off its text (the trace keeps only the text). */
function codeOf(detail: string | undefined): string {
  return detail?.startsWith("參數不對") ? "invalid" : "failed";
}

export const guardSubject: Subject = {
  run(fixture) {
    const cfg = defaultGameConfig();
    const steps = ofType(fixture.trace, "game_step");
    const out: Trace = [];
    let guard: FailureGuard | null = null;
    const repeats = newGoalRepeats();
    steps.forEach((step, i) => {
      const now = step.t * 1000;
      const key = `${step.action} ${step.target ?? ""}`.trim();
      const held =
        (activeGuard(guard, now)?.actions.includes(step.action) ?? false) ||
        goalHeld(repeats, key, now) !== null;
      if (held) {
        out.push({ ...step, blocked: true });
        return;
      }
      out.push(step);
      // The failure is reported with her next decision.
      const reported = (steps[i + 1]?.t ?? step.t + 1) * 1000;
      guard = step.failed
        ? guardAfter(cfg, step.detail ?? "failed", reported)
        : afterSuccess(guard, step.action, now);
      noteGoal(
        repeats,
        cfg,
        key,
        step.failed ? { code: codeOf(step.detail), why: step.detail ?? "failed" } : null,
        reported,
      );
    });
    return out;
  },
};
