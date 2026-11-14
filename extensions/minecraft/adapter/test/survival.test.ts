// What a task changed, exploring, night and death (docs/design/v4-plan.md §11.2 items 3 and 7),
// against the fake mod. Each test is one cause of 2026-11-08: an empty mine and a timed-out
// explore that counted as done, nothing for the night, nothing after a death.

import type { GameEvent, TaskEvent, TaskSpec } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { MinecraftAdapter } from "../src/adapter.js";
import { BridgeClient, BridgeError, type BridgeEvent } from "../src/bridge.js";
import { ObtainRunner, type RunnerHost, worldOf } from "../src/obtain.js";
import { describeStep, knows, normalizeItem, plan, preferredY } from "../src/planner.js";
import { exploreOutcome, inventoryDelta, outcomeOf, sightings } from "../src/progress.js";
import type { Snapshot } from "../src/summary.js";
import { bedOf, isNight, roofAims, roofBlock } from "../src/survival.js";
import { FakeMod, waitFor } from "./fake-mod.js";

let mod: FakeMod | undefined;
let bridge: BridgeClient | undefined;

afterEach(async () => {
  bridge?.close();
  bridge = undefined;
  await mod?.stop();
  mod = undefined;
});

/** A tiny world behind the fake mod: `observe` answers with `world`, requests may change it. */
async function setup(
  world: Snapshot,
  onRequest: (req: Record<string, unknown>, m: FakeMod) => void = () => {},
) {
  mod = await FakeMod.start();
  const m = mod;
  m.respond = (req) => {
    if (req.type === "observe") return { ok: true, data: structuredClone(world) };
    onRequest(req, m);
    return { ok: true, data: req.type === "place" ? { item: req.item, position: { x: 1, y: 64, z: 0 } } : {} };
  };
  bridge = new BridgeClient({ endpoint: () => ({ url: m.url, token: m.token }), reconnectMinMs: 20, requestTimeoutMs: 500 });
  const adapter = new MinecraftAdapter(bridge, {
    progressSettleMs: 1,
    explorePollMs: 10,
    recoverPickupMs: 1,
    shelterPollMs: 10,
    bedWaitMs: 50,
  });
  const events: GameEvent[] = [];
  void (async () => {
    for await (const e of adapter.events()) events.push(e);
  })();
  const tasks: TaskEvent[] = [];
  void (async () => {
    for await (const e of adapter.tasks.events()) tasks.push(e);
  })();
  bridge.start();
  const b = bridge;
  await waitFor(() => b.ready);
  return { mod: m, adapter, events, tasks };
}

const spec = (id: string, goal: string, args: Record<string, unknown> = {}, budget_s = 30): TaskSpec => ({
  id,
  goal,
  args,
  budget_s,
});

function end(tasks: TaskEvent[], id: string): TaskEvent | undefined {
  return tasks.find((e) => e.task === id && (e.type === "done" || e.type === "failed"));
}

async function ended(tasks: TaskEvent[], id: string, ms = 3000): Promise<TaskEvent> {
  await waitFor(() => end(tasks, id) !== undefined, ms);
  return end(tasks, id) as TaskEvent;
}

describe("progress, measured", () => {
  it("compares inventories, counts pickups, and tells place from items", () => {
    expect(inventoryDelta({ oak_log: 2, stick: 4 }, { oak_log: 5, stick: 1 })).toEqual({
      gained: { oak_log: 3 },
      lost: { stick: 3 },
    });
    const at = (x: number, inventory: Record<string, number>): Snapshot => ({ inventory, block_position: { x, y: 64, z: 0 } });
    expect(outcomeOf("mine", at(0, { dirt: 1 }), at(0, { dirt: 1 }))).toMatchObject({
      progressed: false,
      note: "背包沒有變化",
    });
    expect(outcomeOf("mine", at(0, {}), at(0, {}), { oak_log: 2 })).toMatchObject({
      progressed: true,
      gained: { oak_log: 2 },
      note: "+橡木原木×2",
    });
    expect(outcomeOf("obtain", at(0, { wooden_sword: 1 }), at(0, { wooden_sword: 1 }), {}, true)).toMatchObject({
      progressed: false,
      note: "背包裡本來就有了,不用再拿",
    });
    expect(outcomeOf("goto", at(0, {}), at(30, {}))).toMatchObject({ progressed: true, note: "移動了 30 格" });
    expect(outcomeOf("mine", {}, at(0, {}))).toBeNull();
    expect(outcomeOf("explore", at(0, {}), at(0, {}))).toBeNull();
  });

  it("explore: only what is new in sight is progress", () => {
    const sea: Snapshot = { biome: "ocean", nearby_entities: [{ type: "drowned", distance: 9, hostile: true }] };
    expect(sightings(sea)).toEqual(new Set(["drowned", "biome:ocean"]));
    expect(exploreOutcome(sea, sea, new Set(), null)).toMatchObject({ progressed: false });
    expect(exploreOutcome(sea, sea, new Set(["biome:beach", "oak_log"]), null)).toMatchObject({
      progressed: true,
      note: "看到新的:沙灘、橡木原木",
    });
    expect(exploreOutcome(sea, sea, new Set(), "cow")).toMatchObject({ progressed: true, note: "找到牛了" });
  });

  it("an empty mine ends done, without progress", async () => {
    const { mod: m, adapter, tasks } = await setup({ inventory: { dirt: 3 } });
    await adapter.tasks.start(spec("m1", "mine", { block: "oak_log" }));
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));
    m.emit("baritone_idle", { process: "Mine", cancelled: false, reason: "nothing_visible" });
    const e = await ended(tasks, "m1");
    expect(e).toMatchObject({
      type: "done",
      detail: "看得到的都挖完了",
      data: { outcome: { progressed: false, note: "背包沒有變化", inventory: { dirt: 3 } } },
    });
  });

  it("a mine whose drops were picked up is progress, even when the inventory lags", async () => {
    const { mod: m, adapter, tasks } = await setup({ inventory: {} });
    await adapter.tasks.start(spec("m1", "mine", { block: "oak_log" }));
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));
    m.emit("item_picked", { items: { oak_log: 3 } });
    m.emit("baritone_idle", { process: "Mine", cancelled: false });
    const e = await ended(tasks, "m1");
    expect(e).toMatchObject({ type: "done", data: { outcome: { progressed: true, gained: { oak_log: 3 } } } });
  });

  it("an explore that runs out its time over the same sea is done without progress", async () => {
    const { adapter, tasks } = await setup({ biome: "ocean", inventory: {} });
    await adapter.tasks.start(spec("x1", "explore", {}, 1));
    const e = await ended(tasks, "x1");
    expect(e).toMatchObject({ type: "done", data: { outcome: { progressed: false } } });
    expect((e as { detail: string }).detail).toContain("沒看到新的東西");
  });

  it("an explore with find stops as soon as it is in sight", async () => {
    const world: Snapshot = { biome: "plains", inventory: {}, nearby_entities: [] };
    const { mod: m, adapter, tasks } = await setup(world);
    await adapter.tasks.start(spec("x1", "explore", { find: ["cow"] }, 30));
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));
    expect(m.requests.find((r) => r.type === "baritone")).not.toHaveProperty("find");
    world.nearby_entities = [{ type: "cow", distance: 12, hostile: false }];
    const e = await ended(tasks, "x1");
    expect(e).toMatchObject({ type: "done", data: { outcome: { progressed: true, note: "找到牛了" } } });
    expect(m.requests.some((r) => r.type === "stop")).toBe(true);
  });

  it("hunt refuses what it does not hunt", async () => {
    const { adapter, tasks } = await setup({ inventory: {} });
    await adapter.tasks.start(spec("h1", "hunt", { entity: "creeper" }));
    expect(await ended(tasks, "h1")).toMatchObject({ type: "failed", code: "invalid" });
  });
});

describe("night", () => {
  it("is told once per night from what she sees, from dusk on", async () => {
    const world: Snapshot = { dimension: "overworld", time_phase: "day", time_of_day: 11000, inventory: {} };
    const { mod: m, adapter, events } = await setup(world);
    await adapter.observe();
    world.time_phase = "dusk";
    await adapter.observe();
    await adapter.observe();
    await waitFor(() => events.some((e) => e.type === "night_started"));
    expect(events.filter((e) => e.type === "night_started")).toEqual([
      { type: "night_started", data: { time_of_day: 11000, text: "天快黑了" } },
    ]);
    // The mod's own event for the same night still passes (it is the mod's word).
    m.emit("night_started", { time_of_day: 13000 });
    await waitFor(() => events.filter((e) => e.type === "night_started").length === 2);
    // A new day, a new night.
    world.time_phase = "day";
    await adapter.observe();
    world.time_phase = "night";
    await adapter.observe();
    await waitFor(() => events.filter((e) => e.type === "night_started").length === 3);
  });

  it("shelter without a bed: digs three down, roofs it from inside, waits for the day", async () => {
    const world: Snapshot = {
      dimension: "overworld",
      time_phase: "night",
      block_position: { x: 10, y: 64, z: -5 },
      inventory: { cobblestone: 5 },
    };
    const { adapter, tasks, mod: m } = await setup(world, (req, fake) => {
      if (req.type === "baritone" && req.command === "goto") {
        world.block_position = { x: 10, y: 61, z: -5 };
        setTimeout(() => fake.emit("goal_reached", { goal: "GoalBlock" }), 5);
      }
      // The first aim finds air (a cave); the second takes the block.
      if (req.type === "use" && fake.requests.filter((r) => r.type === "use").length === 2) {
        world.inventory = { cobblestone: 4 };
        setTimeout(() => {
          world.time_phase = "day";
        }, 30);
      }
    });
    await adapter.tasks.start(spec("s1", "shelter", {}, 60));
    const e = await ended(tasks, "s1");
    expect(e).toMatchObject({ type: "done", data: { outcome: { progressed: true } } });
    expect((e as { detail: string }).detail).toBe("往下挖了三格、封了頂,天亮了");
    expect(m.requests.find((r) => r.type === "baritone")).toMatchObject({ command: "goto", x: 10, y: 61, z: -5 });
    expect(m.requests.find((r) => r.type === "select_slot")).toMatchObject({ item: "cobblestone" });
    const looks = m.requests.filter((r) => r.type === "look").map((r) => r.at);
    expect(looks).toEqual(roofAims({ x: 10, y: 61, z: -5 }).slice(0, 2));
  });

  it("shelter with a bed sleeps in it", async () => {
    const world: Snapshot = { dimension: "overworld", time_phase: "night", block_position: { x: 0, y: 64, z: 0 }, inventory: { red_bed: 1 } };
    const { adapter, tasks, mod: m } = await setup(world, (req) => {
      if (req.type === "use") world.time_phase = "day";
    });
    await adapter.tasks.start(spec("s1", "shelter", {}, 60));
    const e = await ended(tasks, "s1");
    expect((e as { detail: string }).detail).toBe("放下紅色床睡了一覺,天亮了");
    expect(m.requests.map((r) => r.type).filter((t) => t !== "observe")).toEqual(["place", "look", "use"]);
    expect(m.requests.some((r) => r.type === "baritone")).toBe(false);
  });

  it("shelter by day or in the nether is nothing to do", async () => {
    const { adapter, tasks } = await setup({ dimension: "the_nether", inventory: {} });
    await adapter.tasks.start(spec("s1", "shelter"));
    expect(await ended(tasks, "s1")).toMatchObject({
      type: "done",
      data: { outcome: { progressed: false, note: "這裡沒有日夜,不用躲" } },
    });
  });

  it("knows night, beds and roof blocks", () => {
    expect(isNight({ time_phase: "dusk" })).toBe(true);
    expect(isNight({ time_phase: "dawn" })).toBe(false);
    expect(isNight({ time_phase: "night", dimension: "the_end" })).toBe(false);
    expect(bedOf({ dirt: 3, white_bed: 1 })).toBe("white_bed");
    expect(roofBlock({ sand: 30, dirt: 2, cobblestone: 9 })).toBe("cobblestone");
    expect(roofBlock({ sand: 30, gravel: 2 })).toBeNull();
  });
});

describe("death", () => {
  it("remembers where she died and what she had, and goes back for it", async () => {
    const world: Snapshot = {
      dimension: "overworld",
      block_position: { x: 0, y: 64, z: 0 },
      inventory: { wooden_pickaxe: 1, oak_log: 4 },
    };
    const { mod: m, adapter, tasks } = await setup(world, (req) => {
      if (req.type === "baritone" && req.command === "goto") {
        world.inventory = { wooden_pickaxe: 1, oak_log: 4 };
        setTimeout(() => m.emit("goal_reached", { goal: "GoalNear" }), 5);
      }
    });
    await adapter.observe(); // she had the pickaxe and the logs
    m.emit("death", { dimension: "overworld", position: { x: 1392.4, y: 62, z: 1849.6 }, last_attacker: "drowned" });
    world.inventory = {};
    let obs = await adapter.observe();
    for (let i = 0; i < 100 && obs.state.last_death === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
      obs = await adapter.observe();
    }
    expect(obs.state.last_death).toMatchObject({
      x: 1392,
      y: 62,
      z: 1850,
      dimension: "overworld",
      lost: { wooden_pickaxe: 1, oak_log: 4 },
    });
    expect(obs.summary).toContain("上次死在 (1392, 62, 1850)");
    expect(obs.summary).toContain("掉了 木鎬×1、橡木原木×4");

    await adapter.tasks.start(spec("r1", "recover"));
    const e = await ended(tasks, "r1");
    expect(m.requests.find((r) => r.type === "baritone")).toMatchObject({ command: "goto", x: 1392, y: 62, z: 1850, near: 1 });
    expect(e).toMatchObject({ type: "done", data: { outcome: { progressed: true, gained: { wooden_pickaxe: 1, oak_log: 4 } } } });
    // Got it back: nothing to recover any more.
    expect((await adapter.observe()).state).not.toHaveProperty("last_death");
    await adapter.tasks.start(spec("r2", "recover"));
    expect(await ended(tasks, "r2")).toMatchObject({ type: "failed", code: "precondition" });
  });
});

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
      "打牛、哞菇拿生牛肉×1",
      "用熔爐燒牛排×1",
    ]);
    expect(lines("cooked_porkchop", { porkchop: 2 }, { smoker: true }, 2)).toEqual([
      "砍原木×1",
      "做木材×4",
      "用熔爐燒烤豬排×2",
    ]);
    expect(lines("bread", {}, { table: true })).toEqual(["收成小麥×3", "做麵包×1"]);
    expect(lines("baked_potato", { potato: 2, coal: 1 }, { smoker: true }, 2)).toEqual(["用熔爐燒烤馬鈴薯×2"]);
    expect(lines("charcoal", { oak_log: 2 }, { furnace: true })).toEqual(["做木材×4", "用熔爐燒木炭×1"]);
  });

  it("plans armor sets, shield, bow, arrows, buckets, flint_and_steel, boats, and beds", () => {
    expect(lines("iron_chestplate", { iron_ingot: 8 }, { table: true })).toEqual(["做鐵胸甲×1"]);
    expect(lines("diamond_helmet", { diamond: 5 }, { table: true })).toEqual(["做鑽石頭盔×1"]);
    expect(lines("diamond_boots", { diamond: 4 }, { table: true })).toEqual(["做鑽石靴子×1"]);
    expect(lines("shield", { iron_ingot: 1, oak_planks: 6 }, { table: true })).toEqual(["做盾牌×1"]);
    expect(lines("bow", { stick: 3 }, { table: true })).toEqual(["打蜘蛛拿線×3", "做弓×1"]);
    expect(lines("arrow", {}, { table: true, furnace: true })).toEqual([
      "挖燧石×1",
      "砍原木×1",
      "做木材×4",
      "做木棒×4",
      "打雞拿羽毛×1",
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
    expect(lines("white_bed", { oak_planks: 3 }, { table: true })).toEqual(["打羊拿白色羊毛×3", "做白色床×1"]);
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
  modHunt: true,
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
        world.emitLater("clear_leaves_finished", { broken: 6, max_blocks: 24 });
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
