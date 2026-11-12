// The obtain runner against a tiny fake world: mining adds drops and ends with
// `baritone_idle`, crafting checks the recipe and the table, placing makes the block visible.

import type { GameEvent } from "@miyoria/sdk";
import { describe, expect, it } from "vitest";
import { BridgeError, type BridgeEvent } from "../src/bridge.js";
import { ObtainRunner, type RunnerHost } from "../src/obtain.js";
import type { Snapshot } from "../src/summary.js";

const RECIPES: Record<string, { needs: Record<string, number>; out: number; table: boolean }> = {
  oak_planks: { needs: { oak_log: 1 }, out: 4, table: false },
  stick: { needs: { oak_planks: 2 }, out: 4, table: false },
  crafting_table: { needs: { oak_planks: 4 }, out: 1, table: false },
  wooden_pickaxe: { needs: { oak_planks: 3, stick: 2 }, out: 1, table: true },
};
const DROPS: Record<string, string> = { oak_log: "oak_log", stone: "cobblestone" };

class World implements RunnerHost {
  inv: Record<string, number> = {};
  visible = new Set<string>(["oak_log"]);
  /** Blocks `explore` brings into view. */
  explorable = new Set<string>();
  placed = new Set<string>();
  readonly requests: Array<{ type: string; params: Record<string, unknown> }> = [];
  readonly emitted: GameEvent[] = [];
  runner!: ObtainRunner;
  /** Called on every `mine` before it starts (tests interrupt it). */
  onMine: (n: number) => "ok" | "interrupt" | "too_far" = () => "ok";
  #mines = 0;

  #later(name: string, data: Record<string, unknown> = {}): void {
    setTimeout(() => this.runner.feed({ name, data } satisfies BridgeEvent), 1);
  }

  async request(type: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requests.push({ type, params });
    if (type === "baritone" && params.command === "mine") {
      const blocks = params.blocks as string[];
      const seen = blocks.find((b) => this.visible.has(b));
      if (!seen) throw new BridgeError("not_visible", `no ${blocks.join("/")} in sight within 16 blocks`);
      const what = this.onMine(++this.#mines);
      if (what === "too_far") {
        this.onMine = () => "ok";
        throw new BridgeError("too_far", `nearest ${seen} in sight is 30 blocks away at 1,64,2`);
      }
      if (what === "interrupt") {
        this.#later("reflex", { kind: "fight", interrupted: "Mine" });
        setTimeout(() => this.runner.feed({ name: "reflex_end", data: { kind: "fight", ok: true } }), 5);
        return {};
      }
      const drop = DROPS[seen] ?? seen;
      this.inv[drop] = Math.max(this.inv[drop] ?? 0, params.count as number);
      this.#later("baritone_idle", { process: "Mine" });
      return {};
    }
    if (type === "baritone" && params.command === "explore") {
      for (const b of this.explorable) this.visible.add(b);
      return {};
    }
    if (type === "baritone" && params.command === "goto") {
      this.#later("goal_reached");
      return {};
    }
    if (type === "craft") {
      const r = RECIPES[params.item as string];
      if (!r) throw new BridgeError("invalid_args", "no recipe");
      if (r.table && !this.placed.has("crafting_table")) {
        throw new BridgeError("needs_station", "needs a crafting_table within reach; none in sight");
      }
      const times = Math.ceil((params.count as number) / r.out);
      for (const [item, n] of Object.entries(r.needs)) {
        if ((this.inv[item] ?? 0) < n * times) throw new BridgeError("missing_items", `missing ${item} x${n * times}`);
      }
      for (const [item, n] of Object.entries(r.needs)) this.inv[item] = (this.inv[item] ?? 0) - n * times;
      const item = params.item as string;
      this.inv[item] = (this.inv[item] ?? 0) + r.out * times;
      this.#later("craft_finished", { item, crafted: r.out * times, requested: params.count });
      return {};
    }
    if (type === "place") {
      const item = params.item as string;
      this.inv[item] = (this.inv[item] ?? 0) - 1;
      this.placed.add(item);
      return { item };
    }
    return {};
  }

  async observe(): Promise<Snapshot> {
    return {
      inventory: Object.fromEntries(Object.entries(this.inv).filter(([, n]) => n > 0)),
      nearby_blocks: [...this.visible, ...this.placed].map((block) => ({ block, count: 1, distance: 3 })),
    };
  }

  emit(e: GameEvent): void {
    this.emitted.push(e);
  }
}

const fast = { exploreMs: 60, explorePollMs: 10, jobTimeoutMs: 500, mineTimeoutMs: 500, reflexWaitMs: 500 };

function runner(world: World, item: string) {
  world.runner = new ObtainRunner(world, item, 1, fast);
  return world.runner;
}

describe("obtain runner", () => {
  it("gets a wooden pickaxe from bare hands with ordinary requests", async () => {
    const world = new World();
    const result = await runner(world, "wooden_pickaxe").run();
    expect(result).toEqual({ ok: true, message: "拿到木鎬了" });
    expect(world.inv.wooden_pickaxe).toBe(1);
    expect(world.requests.map((r) => (r.type === "baritone" ? `mine ${r.params.count}` : `${r.type} ${r.params.item}`))).toEqual([
      "mine 3",
      "craft oak_planks",
      "craft crafting_table",
      "place crafting_table",
      "craft stick",
      "craft wooden_pickaxe",
    ]);
    const steps = world.emitted.filter((e) => e.type === "plan_step").map((e) => (e.data as { text: string }).text);
    expect(steps[0]).toBe("取得木鎬:第 1/6 步,砍原木×3");
    expect(steps.at(-1)).toBe("取得木鎬:第 6/6 步,做木鎬×1");
  });

  it("explores for blocks out of sight, then gives up with the reason", async () => {
    const world = new World();
    world.visible.clear();
    const result = await runner(world, "stick").run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("卡在「砍原木×1」");
    expect(result.message).toContain("附近看不到橡木原木");
    expect(world.requests.filter((r) => r.params.command === "explore")).toHaveLength(2);
  });

  it("explores until the block comes into view", async () => {
    const world = new World();
    world.visible.clear();
    world.explorable.add("oak_log");
    const result = await runner(world, "stick").run();
    expect(result.ok).toBe(true);
    expect(world.requests.some((r) => r.type === "stop")).toBe(true);
  });

  it("waits out a reflex that interrupts a step and does the step again", async () => {
    const world = new World();
    world.onMine = (n) => (n === 1 ? "interrupt" : "ok");
    const result = await runner(world, "stick").run();
    expect(result.ok).toBe(true);
    expect(world.requests.filter((r) => r.params.command === "mine")).toHaveLength(2);
  });

  it("walks to a block that is in sight but too far", async () => {
    const world = new World();
    world.onMine = () => "too_far";
    const result = await runner(world, "stick").run();
    expect(result.ok).toBe(true);
    expect(world.requests.some((r) => r.params.command === "goto" && r.params.block === "oak_log")).toBe(true);
  });

  it("stops when cancelled", async () => {
    const world = new World();
    const r = runner(world, "wooden_pickaxe");
    const running = r.run();
    r.cancel();
    expect(await running).toMatchObject({ ok: false, cancelled: true });
  });
});
