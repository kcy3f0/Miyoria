import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "../src/index.js";
import { itemOf, MethodGuard, methodKey } from "../src/methods.js";
import { AttemptRecord, attemptLine } from "../src/record.js";
import { SkillBook } from "../src/skills.js";

const cfg = defaultGameConfig();
const MIN = 60_000;

describe("method keys", () => {
  it("are the action with its item, not the parameter string", () => {
    expect(methodKey("obtain", { item: "bread" })).toBe("obtain:bread");
    expect(methodKey("obtain", { item: "minecraft:Bread", count: 3 })).toBe("obtain:bread");
    expect(methodKey("mine", { blocks: ["stone", "cobblestone"], count: 5 })).toBe(
      "mine:cobblestone+stone",
    );
    expect(methodKey("hunt", { entity: "cow", count: 2 })).toBe("hunt:cow");
    expect(methodKey("explore", { find: ["oak_log"] })).toBe("explore:oak_log");
    expect(methodKey("explore", {})).toBe("explore");
    expect(methodKey("goto", { x: 1, z: 2 })).toBe("goto");
    expect(itemOf({ block: "Crafting Table" })).toBe("crafting_table");
  });
});

describe("method guard", () => {
  it("holds a method after the same code twice, for method_hold_secs", () => {
    const g = new MethodGuard(cfg);
    expect(g.failed("obtain:bread", "precondition", "還缺 小麥×3", 0)).toBeNull();
    expect(g.held("obtain:bread", 1)).toBeNull();
    const hold = g.failed("obtain:bread", "precondition", "還缺 小麥×3", 1_000);
    expect(hold).toMatchObject({ method: "obtain:bread", code: "precondition", until: 601_000 });
    expect(g.held("obtain:bread", 2_000)).toBe(hold);
    expect(g.held("obtain:cooked_beef", 2_000)).toBeNull();
    expect(g.held("obtain:bread", 601_000)).toBeNull();
  });

  it("a different code in between starts the count again", () => {
    const g = new MethodGuard(cfg);
    g.failed("mine:stone", "not_found", "看不到", 0);
    g.failed("mine:stone", "timeout", "挖太久", 1);
    expect(g.held("mine:stone", 2)).toBeNull();
    g.failed("mine:stone", "timeout", "挖太久", 3);
    expect(g.held("mine:stone", 4)).not.toBeNull();
  });

  it("only progress with the same method clears it", () => {
    const g = new MethodGuard(cfg);
    g.failed("obtain:bread", "precondition", "x", 0);
    g.failed("obtain:bread", "precondition", "x", 0);
    g.progressed("obtain:cooked_beef");
    g.progressed("stop");
    expect(g.held("obtain:bread", 1)).not.toBeNull();
    g.progressed("obtain:bread");
    expect(g.held("obtain:bread", 1)).toBeNull();
  });

  it("an invalid item method is held for the session; an interruption is no failure", () => {
    const g = new MethodGuard(cfg);
    g.failed("obtain:apple", "invalid", "no crafting recipe makes apple", 0);
    expect(g.held("obtain:apple", 24 * 60 * MIN)).not.toBeNull();
    // `goto` without arguments is a slip, not an impossible method.
    g.failed("goto", "invalid", "goto 要給 {x,z}", 0);
    expect(g.held("goto", 1)).toBeNull();
    g.failed("mine:stone", "busy", "被反射打斷", 0);
    g.failed("mine:stone", "busy", "被反射打斷", 0);
    expect(g.held("mine:stone", 1)).toBeNull();
  });

  it("holds a goal's item and lists every hold for her prompt", () => {
    const g = new MethodGuard(cfg);
    g.holdGoal("bread", "precondition", "還缺 小麥×3", 0);
    g.failed("obtain:apple", "invalid", "沒有配方", 0);
    expect(g.goalHeld("bread", 1)).not.toBeNull();
    expect(g.lines(MIN)).toEqual([
      "目標「bread」(暫停 9 分鐘):precondition,還缺 小麥×3",
      "obtain:apple(這場不能再用):invalid,沒有配方",
    ]);
    g.goalReached("bread");
    expect(g.goalHeld("bread", 1)).toBeNull();
  });

  it("can be turned off", () => {
    const g = new MethodGuard({ ...cfg, method_repeat_limit: 0 });
    g.failed("obtain:bread", "precondition", "x", 0);
    g.failed("obtain:bread", "precondition", "x", 0);
    g.failed("obtain:apple", "invalid", "x", 0);
    expect(g.holds(1)).toEqual([]);
  });
});

describe("her record", () => {
  it("keeps the newest attempts with their codes, apart from events", () => {
    const r = new AttemptRecord(2);
    const base = { method: "obtain:bread", goal: "做麵包", detail: "還缺 小麥×3" };
    r.add({
      ...base,
      at: 0,
      action: 'obtain {"item":"bread"}',
      result: "failed",
      code: "precondition",
    });
    r.add({
      ...base,
      at: 1_000,
      action: "explore",
      result: "no_progress",
      code: "no_progress",
      detail: "",
    });
    r.add({
      ...base,
      at: 2_000,
      action: 'hunt {"entity":"cow"}',
      result: "progress",
      code: null,
      detail: "+生牛肉×1",
    });
    expect(r.lines(32_000)).toEqual([
      "[31 秒前] explore → 做完了但沒有進展",
      '[30 秒前] hunt {"entity":"cow"} → 有進展:+生牛肉×1',
    ]);
    expect(
      attemptLine(
        { ...base, at: 0, action: "obtain", result: "failed", code: "precondition" },
        5 * MIN,
      ),
    ).toBe("[5 分鐘前] obtain → 失敗(precondition):還缺 小麥×3");
  });
});

describe("skill book", () => {
  it("keeps the newest few per target and lists them", () => {
    const book = new SkillBook();
    const skill = (target: string, steps: string[], at: number) => ({
      game: "minecraft",
      target,
      goal: target,
      steps,
      at,
    });
    expect(book.learn(skill("bread", [], 0))).toBeNull();
    for (let i = 0; i < 5; i++) book.learn(skill("cooked_beef", [`hunt ${i}`], i));
    book.learn(skill("stone_pickaxe", ["obtain stone_pickaxe"], 9));
    expect(book.forTarget("minecraft", "cooked_beef").map((s) => s.steps[0])).toEqual([
      "hunt 4",
      "hunt 3",
      "hunt 2",
    ]);
    expect(book.lines("minecraft", "cooked_beef")[0]).toBe("之前拿到 cooked_beef:hunt 4");
    expect(book.lines("minecraft", null)).toEqual([
      "stone_pickaxe:obtain stone_pickaxe",
      "cooked_beef:hunt 4",
    ]);
    expect(book.lines("osu", null)).toEqual([]);
  });
});

// ----- the night of 2026-11-08 as the acceptance case (§11.2 item 9) -----

interface Step {
  t: number;
  action: string;
  target?: string;
  failed: boolean;
  detail?: string;
}

/** The task failure code a recorded detail line stands for (the recording kept only the text). */
function codeOf(detail: string | undefined): string {
  if (detail === undefined) return "internal";
  if (detail.startsWith("參數不對")) return "invalid";
  if (detail.startsWith("材料不夠")) return "precondition";
  if (/挖太久|took longer/.test(detail)) return "timeout";
  if (/看不到|沒挖到/.test(detail)) return "not_found";
  if (detail.includes("no path")) return "unreachable";
  return "internal";
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../eval/fixtures/mc-obtain-bread-loop.json"), "utf8"),
) as { trace: Step[] };

describe("2026-11-08, replayed through the method guard", () => {
  const replay = () => {
    const guard = new MethodGuard(cfg);
    const ran: Step[] = [];
    const held: Step[] = [];
    for (const step of fixture.trace) {
      if (cfg.instant_actions.includes(step.action)) continue;
      const method = methodKey(step.action, step.target ? { item: step.target } : {});
      const now = step.t * 1000;
      if (guard.held(method, now) !== null) {
        held.push(step);
        continue;
      }
      ran.push(step);
      if (step.failed) guard.failed(method, codeOf(step.detail), step.detail ?? "", now);
      else guard.progressed(method);
    }
    return { ran, held };
  };

  it("lets bread through only twice per hold instead of every time", () => {
    const { ran } = replay();
    const bread = (s: Step) => s.action === "obtain" && s.target === "bread";
    expect(fixture.trace.filter(bread)).toHaveLength(32);
    const through = ran.filter(bread);
    // 9 of 32 over the 2 h 11 min: two per ten-minute hold (the recording kept no codes, so
    // the first one, without a detail, counts as another code).
    expect(through).toHaveLength(9);
    // Never three bread failures with the same code inside one hold window.
    const precondition = through.filter((s) => codeOf(s.detail) === "precondition");
    for (let i = 2; i < precondition.length; i++) {
      const a = precondition[i - 2] as Step;
      const c = precondition[i] as Step;
      expect(c.t - a.t).toBeGreaterThanOrEqual(cfg.method_hold_secs);
    }
  });

  it("asks for an impossible item (no recipe) once per session", () => {
    const { ran } = replay();
    for (const item of ["apple", "cod", "cooked_cod", "cooked_porkchop", "wheat_seeds"]) {
      const invalid = ran.filter(
        (s) => s.target === item && codeOf(s.detail) === "invalid" && s.failed,
      );
      expect(invalid.length, item).toBeLessThanOrEqual(1);
    }
  });

  it("a stop is never a step of hers that counts", () => {
    const { ran, held } = replay();
    expect([...ran, ...held].some((s) => s.action === "stop")).toBe(false);
  });
});
