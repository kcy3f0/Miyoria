import type { GameEvent } from "@miyoria/sdk";
import { describe, expect, it } from "vitest";
import { BridgeError, type BridgeEvent } from "../src/bridge.js";
import { ObtainRunner, type RunnerHost, worldOf } from "../src/obtain.js";
import { describeStep, knows, normalizeItem, plan, preferredY } from "../src/planner.js";
import type { Snapshot } from "../src/summary.js";

const lines = (target: string, inv: Record<string, number> = {}, world = {}, count = 1) =>
  plan(target, count, inv, world).map(describeStep);

describe("overworld survival planner", () => {
  it("plans cooked food, charcoal, bread, baked potatoes, and hunting steps", () => {
    expect(lines("cooked_beef", { coal: 1 })).toEqual([
      "砍原木×3",
      "做木材×12",
      "做工作台×1",
      "放下工作台",
      "做木棒×4",
      "做木鎬×1",
      "挖鵝卵石×8",
      "做熔爐×1",
      "放下熔爐",
      "打獵牛拿生牛肉×1",
      "用熔爐燒牛排×1",
    ]);
    expect(lines("cooked_porkchop", { porkchop: 2 }, { smoker: true }, 2)).toEqual([
      "砍原木×1",
      "做木材×4",
      "用熔爐燒烤豬排×2",
    ]);
    expect(lines("bread", {}, { table: true })).toEqual(["挖小麥×3", "做麵包×1"]);
    expect(lines("baked_potato", { potato: 2, coal: 1 }, { smoker: true }, 2)).toEqual(["用熔爐燒烤馬鈴薯×2"]);
    expect(lines("charcoal", { oak_log: 2 }, { furnace: true })).toEqual(["做木材×4", "用熔爐燒木炭×1"]);
  });

  it("plans armor sets, shield, bow, arrows, buckets, flint_and_steel, boats, and beds", () => {
    expect(lines("iron_chestplate", { iron_ingot: 8 }, { table: true })).toEqual(["做鐵胸甲×1"]);
    expect(lines("diamond_helmet", { diamond: 5 }, { table: true })).toEqual(["做鑽石頭盔×1"]);
    expect(lines("diamond_boots", { diamond: 4 }, { table: true })).toEqual(["做鑽石靴子×1"]);
    expect(lines("shield", { iron_ingot: 1, oak_planks: 6 }, { table: true })).toEqual(["做盾牌×1"]);
    expect(lines("bow", { stick: 3 }, { table: true })).toEqual(["打獵蜘蛛拿線×3", "做弓×1"]);
    expect(lines("arrow", {}, { table: true, furnace: true })).toEqual([
      "挖燧石×1",
      "砍原木×1",
      "做木材×4",
      "做木棒×4",
      "打獵雞拿羽毛×1",
      "做箭×4",
    ]);
    expect(lines("water_bucket", { iron_ingot: 3 }, { table: true })).toEqual(["做鐵桶×1", "用鐵桶裝水"]);
    expect(lines("flint_and_steel", { iron_ingot: 1 })).toEqual(["挖燧石×1", "做打火石×1"]);
    expect(lines("#boats", { birch_planks: 5 }, { table: true })).toEqual(["做木船×1"]);
    expect(normalizeItem("boat")).toBe("#boats");
    expect(normalizeItem("bed")).toBe("#beds");
    expect(knows("water_bucket")).toBe(true);
    expect(knows("cooked_mutton")).toBe(true);
    expect(knows("blast_furnace")).toBe(true);
    // Uses wool color she already has >= 3 of; otherwise hunts sheep for white_wool.
    expect(lines("#beds", { red_wool: 3, oak_planks: 3 }, { table: true })).toEqual(["做床×1"]);
    expect(lines("white_bed", { oak_planks: 3 }, { table: true })).toEqual(["打獵羊拿白色羊毛×3", "做白色床×1"]);
  });

  it("uses blast_furnace for ores, chest_take when chest memory holds items, and attaches preferredY", () => {
    expect(lines("iron_ingot", { raw_iron: 2, coal: 1 }, { blastFurnace: true }, 2)).toEqual(["用熔爐燒鐵錠×2"]);

    const chestSteps = plan(
      "iron_pickaxe",
      1,
      { stick: 2 },
      { table: true, chests: [{ key: "chest:10_64_10", x: 10, y: 64, z: 10, items: { iron_ingot: 3 } }] },
    );
    expect(chestSteps).toEqual([
      { kind: "chest_take", item: "iron_ingot", count: 3, chest: { x: 10, y: 64, z: 10 } },
      { kind: "craft", item: "iron_pickaxe", count: 1, table: true },
    ]);

    expect(preferredY("raw_iron")).toBe(16);
    expect(preferredY("#coal")).toBe(48);
    expect(preferredY("raw_copper")).toBe(48);
    expect(preferredY("raw_gold")).toBe(-16);
    expect(preferredY("redstone")).toBe(-16);
    expect(preferredY("lapis_lazuli")).toBe(-16);
    expect(preferredY("diamond")).toBe(-54);

    const ironMine = plan("raw_iron", 1, { stone_pickaxe: 1 }, {});
    expect((ironMine[0] as { preferredY?: number }).preferredY).toBe(16);
    const diamondMine = plan("diamond", 1, { iron_pickaxe: 1 }, {});
    expect((diamondMine[0] as { preferredY?: number }).preferredY).toBe(-54);
  });
});

class SurvivalWorld implements RunnerHost {
  inv: Record<string, number> = {};
  visible = new Set<string>();
  nearbyBlocks: Snapshot["nearby_blocks"] = [];
  entities: Snapshot["nearby_entities"] = [];
  dimension = "overworld";
  chests: Array<{ key: string; x: number; y: number; z: number; items: Record<string, number> }> = [];
  requests: Array<{ type: string; params: Record<string, unknown> }> = [];
  emitted: GameEvent[] = [];
  mineEntrances = 0;
  runner!: ObtainRunner;
  onRequest?: (type: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;

  emitLater(name: string, data: Record<string, unknown> = {}, delay = 2): void {
    setTimeout(() => this.runner.feed({ name, data } satisfies BridgeEvent), delay);
  }

  async request(type: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requests.push({ type, params });
    if (this.onRequest) return this.onRequest(type, params);
    return {};
  }

  async observe(): Promise<Snapshot> {
    return {
      dimension: this.dimension,
      position: { x: 0, y: 64, z: 0 },
      inventory: Object.fromEntries(Object.entries(this.inv).filter(([, n]) => n > 0)),
      nearby_blocks:
        this.nearbyBlocks && this.nearbyBlocks.length > 0
          ? this.nearbyBlocks
          : [...this.visible].map((block) => ({ block, count: 1, distance: 3, nearest: { x: 2, y: 64, z: 0 } })),
      nearby_entities: this.entities,
    };
  }

  emit(e: GameEvent): void {
    this.emitted.push(e);
  }

  chestsFor(): typeof this.chests {
    return this.chests;
  }

  recordMineEntrance(): void {
    this.mineEntrances++;
  }
}

const FAST = {
  mineTimeoutMs: 400,
  jobTimeoutMs: 400,
  branchTimeoutMs: 400,
  clearLeavesTimeoutMs: 200,
  huntTimeoutMs: 400,
  chestTimeoutMs: 400,
  exploreMs: 30,
  explorePollMs: 10,
  reflexWaitMs: 300,
};

describe("ObtainRunner survival upgrades", () => {
  it("clears canopy leaves and retries when mining #logs fails with not_visible", async () => {
    const world = new SurvivalWorld();
    let cleared = false;
    world.onRequest = (type, params) => {
      if (type === "baritone" && params.command === "mine") {
        if (!cleared) throw new BridgeError("not_visible", "no oak_log in sight within 16 blocks");
        world.inv.oak_log = (world.inv.oak_log ?? 0) + 1;
        world.emitLater("baritone_idle", { process: "Mine" });
        return {};
      }
      if (type === "clear_leaves") {
        cleared = true;
        world.emitLater("clear_leaves_finished", { cleared: 6 });
        return {};
      }
      return {};
    };
    world.runner = new ObtainRunner(world, "#logs", 1, FAST);
    const res = await world.runner.run();
    expect(res).toEqual({ ok: true, message: "拿到原木了" });
    expect(world.requests.some((r) => r.type === "clear_leaves")).toBe(true);
    expect(world.requests.some((r) => r.params.command === "explore")).toBe(false);
  });

  it("falls back to underground mine_branch when ore is not visible, records entrance, and finishes exposed vein", async () => {
    const world = new SurvivalWorld();
    world.inv = { stone_pickaxe: 1 };
    let veinExposed = false;
    world.onRequest = (type, params) => {
      if (type === "baritone" && params.command === "mine") {
        if (!veinExposed) throw new BridgeError("not_visible", "no iron_ore/deepslate_iron_ore in sight");
        world.inv.raw_iron = 3;
        world.emitLater("baritone_idle", { process: "Mine" });
        return {};
      }
      if (type === "mine_branch") {
        // Exposes vein (+1 mined during branch, then baritone mines the rest).
        world.inv.raw_iron = 1;
        veinExposed = true;
        world.emitLater("branch_finished", { found: true, target_y: params.target_y });
        return {};
      }
      return {};
    };
    world.runner = new ObtainRunner(world, "raw_iron", 3, FAST);
    const res = await world.runner.run();
    expect(res).toEqual({ ok: true, message: "拿到粗鐵×3了" });
    expect(world.mineEntrances).toBe(1);
    const branch = world.requests.find((r) => r.type === "mine_branch");
    expect(branch?.params).toMatchObject({
      target_y: 16,
      ores: ["iron_ore", "deepslate_iron_ore"],
      max_steps: 64,
      torch_interval: 8,
    });
  });

  it("does not attempt Overworld mine_branch while in the Nether", async () => {
    const world = new SurvivalWorld();
    world.dimension = "the_nether";
    world.inv = { stone_pickaxe: 1 };
    world.onRequest = (type, params) => {
      if (type === "baritone" && params.command === "mine") {
        throw new BridgeError("not_visible", "no iron_ore in sight");
      }
      return {};
    };
    world.runner = new ObtainRunner(world, "raw_iron", 1, FAST);
    const res = await world.runner.run();
    expect(res.ok).toBe(false);
    expect(world.requests.some((r) => r.type === "mine_branch")).toBe(false);
  });

  it("waits cleanly for recoverable reflex_resumed and does not fail on repeated reflex_aborted", async () => {
    // Part 1: recoverable pause + reflex_resumed finishes the same mine_branch without restarting.
    const w1 = new SurvivalWorld();
    w1.inv = { iron_pickaxe: 1 };
    let branchCalls = 0;
    w1.onRequest = (type, params) => {
      if (type === "baritone" && params.command === "mine") {
        if (branchCalls === 0) throw new BridgeError("not_visible", "no diamond_ore in sight");
        return {};
      }
      if (type === "mine_branch") {
        branchCalls++;
        setTimeout(() => w1.runner.feed({ name: "reflex", data: { kind: "eat", recoverable: true, paused_task: true } }), 2);
        setTimeout(() => w1.runner.feed({ name: "reflex_resumed", data: { kind: "eat" } }), 6);
        setTimeout(() => {
          w1.inv.diamond = 1;
          w1.runner.feed({ name: "branch_finished", data: { found: true } });
        }, 12);
        return {};
      }
      return {};
    };
    w1.runner = new ObtainRunner(w1, "diamond", 1, FAST);
    expect(await w1.runner.run()).toEqual({ ok: true, message: "拿到鑽石了" });
    expect(branchCalls).toBe(1);

    // Part 2: reflex_aborted >= 3 times never exhausts the step failure budget (limit=2).
    const w2 = new SurvivalWorld();
    w2.visible.add("oak_log");
    let mines = 0;
    w2.onRequest = (type, params) => {
      if (type === "baritone" && params.command === "mine") {
        mines++;
        if (mines <= 3) {
          setTimeout(() => w2.runner.feed({ name: "reflex", data: { kind: "fight", recoverable: true } }), 2);
          setTimeout(() => w2.runner.feed({ name: "reflex_aborted", data: { kind: "fight" } }), 5);
          return {};
        }
        w2.inv.oak_log = 1;
        w2.emitLater("baritone_idle", { process: "Mine" });
      }
      return {};
    };
    w2.runner = new ObtainRunner(w2, "#logs", 1, FAST);
    expect(await w2.runner.run()).toEqual({ ok: true, message: "拿到原木了" });
    expect(mines).toBe(4);
  });

  it("executes hunt, fill_water, and chest_take steps", async () => {
    const world = new SurvivalWorld();
    world.inv = { bucket: 1 };
    world.nearbyBlocks = [{ block: "water", count: 4, distance: 3, nearest: { x: 1, y: 63, z: 2 } }];
    world.chests = [{ key: "chest:5_64_5", x: 5, y: 64, z: 5, items: { iron_ingot: 4 } }];
    world.onRequest = (type, params) => {
      if (type === "hunt") {
        world.inv[params.entity === "cow" ? "leather" : "unknown"] = 1;
        world.emitLater("hunt_finished", { entity: params.entity, collected: 1 });
      } else if (type === "use") {
        delete world.inv.bucket;
        world.inv.water_bucket = 1;
      } else if (type === "chest" && params.op === "take") {
        world.inv.iron_ingot = 2;
        world.emitLater("chest_finished", { op: "take", items: { iron_ingot: 2 } });
      }
      return {};
    };

    world.runner = new ObtainRunner(world, "water_bucket", 1, FAST);
    expect(await world.runner.run()).toEqual({ ok: true, message: "拿到水桶了" });
    expect(world.requests.some((r) => r.type === "select_slot" && r.params.item === "bucket")).toBe(true);
    expect(world.requests.some((r) => r.type === "look")).toBe(true);

    world.runner = new ObtainRunner(world, "leather", 1, FAST);
    expect(await world.runner.run()).toEqual({ ok: true, message: "拿到皮革了" });

    world.runner = new ObtainRunner(world, "iron_ingot", 2, FAST);
    expect(await world.runner.run()).toEqual({ ok: true, message: "拿到鐵錠×2了" });
    expect(world.requests.some((r) => r.type === "chest" && r.params.op === "take")).toBe(true);
    expect(worldOf(await world.observe(), world.chests)).toMatchObject({ water: true, chests: world.chests });
  });
});
