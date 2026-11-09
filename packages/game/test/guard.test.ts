import { describe, expect, it } from "vitest";
import {
  activeGuard,
  afterSuccess,
  firstNudge,
  GameConfigSchema,
  goalHeld,
  goalRepeatNote,
  guardAfter,
  guardNote,
  newGoalRepeats,
  noteGoal,
  withheld,
} from "../src/index.js";

const cfg = GameConfigSchema.parse({});

describe("failure guard", () => {
  it("withholds the low-level actions for failure_guard_secs", () => {
    const guard = guardAfter(cfg, "附近看不到鐵礦", 1_000);
    expect(guard).toMatchObject({ actions: ["goto", "mine", "look", "attack"], until: 46_000 });
    expect(withheld(guard, "mine", 2_000)).toBe(true);
    expect(withheld(guard, "goto", 2_000)).toBe(true);
    expect(withheld(guard, "obtain", 2_000)).toBe(false);
    expect(withheld(guard, "explore", 2_000)).toBe(false);
    // it runs out
    expect(withheld(guard, "mine", 46_000)).toBe(false);
    expect(activeGuard(guard, 46_000)).toBeNull();
  });

  it("ends early when another method works", () => {
    const guard = guardAfter(cfg, "x", 0);
    expect(afterSuccess(guard, "explore", 1_000)).toBeNull();
    expect(afterSuccess(guard, "mine", 1_000)).toBe(guard);
  });

  it("tells her what is withheld and for how long", () => {
    const guard = guardAfter(cfg, "附近看不到鐵礦", 0);
    expect(guardNote(guard, 10_000)).toBe(
      "暫時不能用 goto、mine、look、attack(還有 35 秒):上一個動作失敗了(附近看不到鐵礦)。換個方法(例如 obtain 缺的東西、explore)或換個目標,不要重試同一件事。",
    );
    expect(guardNote(guard, 60_000)).toBeNull();
    expect(guardNote(null, 0)).toBeNull();
  });

  it("can be turned off", () => {
    expect(guardAfter(GameConfigSchema.parse({ failure_guard_secs: 0 }), "x", 0)).toBeNull();
    expect(guardAfter(GameConfigSchema.parse({ guarded_actions: [] }), "x", 0)).toBeNull();
  });
});

describe("goals that keep failing", () => {
  const bread = 'obtain {"item":"bread"}';
  const beef = 'obtain {"item":"cooked_beef"}';
  const missing = { code: "precondition", why: "材料不夠:還缺 小麥×3" };

  it("the second failure in a row withholds the goal for repeat_guard_secs", () => {
    const r = newGoalRepeats();
    noteGoal(r, cfg, bread, missing, 0);
    expect(goalHeld(r, bread, 1_000)).toBeNull();
    noteGoal(r, cfg, bread, missing, 5_000);
    expect(goalHeld(r, bread, 6_000)).toBe("材料不夠:還缺 小麥×3");
    expect(goalRepeatNote(r, 6_000)).toContain(bread);
    expect(firstNudge(r, bread)).toBe(true);
    expect(firstNudge(r, bread)).toBe(false);
    // 600 s later it may be tried again, from scratch.
    expect(goalHeld(r, bread, 5_000 + 600_000)).toBeNull();
    noteGoal(r, cfg, bread, missing, 610_000);
    expect(goalHeld(r, bread, 611_000)).toBeNull();
  });

  it("a success in between starts over, and an invalid goal is withheld for good", () => {
    const r = newGoalRepeats();
    noteGoal(r, cfg, bread, missing, 0);
    noteGoal(r, cfg, bread, null, 1_000);
    noteGoal(r, cfg, bread, missing, 2_000);
    expect(goalHeld(r, bread, 3_000)).toBeNull();
    noteGoal(r, cfg, beef, { code: "invalid", why: "no crafting recipe makes cooked_beef" }, 0);
    expect(goalHeld(r, beef, 86_400_000)).toContain("no crafting recipe");
  });

  it("can be turned off", () => {
    const off = GameConfigSchema.parse({ repeat_failure_limit: 0 });
    const r = newGoalRepeats();
    for (let i = 0; i < 5; i++) noteGoal(r, off, beef, { code: "invalid", why: "x" }, i);
    expect(goalHeld(r, beef, 10)).toBeNull();
    expect(goalRepeatNote(r, 10)).toBeNull();
  });
});
