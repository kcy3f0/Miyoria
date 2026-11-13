import type { TaskEvent, TaskSpec } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { MinecraftAdapter } from "../src/adapter.js";
import { BridgeClient } from "../src/bridge.js";
import { mapEvent } from "../src/events.js";
import type { AdapterStorage } from "../src/waypoints.js";
import { FakeMod, waitFor } from "./fake-mod.js";

function memoryStorage(): AdapterStorage {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
}

const spec = (id: string, goal: string, args: Record<string, unknown> = {}, budget_s = 10): TaskSpec => ({
  id,
  goal,
  args,
  budget_s,
});

function taskEvents(adapter: MinecraftAdapter): TaskEvent[] {
  const out: TaskEvent[] = [];
  void (async () => {
    for await (const e of adapter.tasks.events()) out.push(e);
  })();
  return out;
}

const ends = (events: TaskEvent[]) =>
  events
    .filter((e) => e.type === "done" || e.type === "failed")
    .map((e) => [e.task, e.type === "done" ? "done" : e.code]);

const fastRunner = {
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

let mod: FakeMod | undefined;
let bridge: BridgeClient | undefined;
const adapters: MinecraftAdapter[] = [];

afterEach(async () => {
  for (const a of adapters.splice(0)) a.close();
  bridge?.close();
  bridge = undefined;
  if (mod) await mod.stop();
  mod = undefined;
});

async function setup(opts: { storage?: AdapterStorage; modTasks?: boolean; visionCooldownMs?: number } = {}) {
  mod = await FakeMod.start();
  if (opts.modTasks) mod.capabilities.tasks = true;
  const m = mod;
  bridge = new BridgeClient({ endpoint: () => ({ url: m.url, token: m.token }) });
  const adapter = new MinecraftAdapter(bridge, {
    storage: opts.storage,
    runner: fastRunner,
    vision: { enabled: true, cooldownMs: opts.visionCooldownMs ?? 15_000, maxWidth: 512, quality: 0.65 },
  });
  adapters.push(adapter);
  bridge.start();
  const b = bridge;
  await waitFor(() => b.ready);
  return { mod: m, adapter, bridge: b };
}

describe("new high-level actions, reflexes, and events", () => {
  it("runs hunt, sleep, chest, manage_inv, waypoint, and inspect actions cleanly", async () => {
    const { mod: m, adapter } = await setup();
    m.respond = (req) => {
      if (req.type === "observe") {
        return {
          ok: true,
          data: {
            world_id: "w_main",
            dimension: "overworld",
            position: { x: 10, y: 64, z: 20 },
            light_level: 4,
            inventory: { stone_sword: 1, cobble: 0 },
          },
        };
      }
      if (req.type === "chest" && req.op === "inspect") {
        return { ok: true, data: { position: { x: 12, y: 64, z: 20 }, items: { torch: 16 } } };
      }
      return { ok: true, data: {} };
    };

    const tasks = taskEvents(adapter);

    // manage_inv (instant)
    await adapter.tasks.start(spec("m1", "manage_inv", { op: "equip_best" }));
    await waitFor(() => ends(tasks).length === 1);
    expect(m.requests.find((r) => r.type === "manage_inv")).toMatchObject({ op: "equip_best" });

    // hunt (job)
    await adapter.tasks.start(spec("h1", "hunt", { entity: "cow", count: 2, range: 24 }));
    await waitFor(() => m.requests.some((r) => r.type === "hunt"));
    m.emit("hunt_finished", { entity: "cow", collected: 2 });
    await waitFor(() => ends(tasks).length === 2);
    expect(ends(tasks).at(-1)).toEqual(["h1", "done"]);

    // sleep (job)
    await adapter.tasks.start(spec("s1", "sleep"));
    await waitFor(() => m.requests.some((r) => r.type === "sleep"));
    m.emit("sleep_finished", { position: { x: 11, y: 64, z: 20 } });
    await waitFor(() => ends(tasks).length === 3);
    expect(ends(tasks).at(-1)).toEqual(["s1", "done"]);

    // chest inspect updates WaypointStore and finishes task cleanly.
    await adapter.tasks.start(spec("c1", "chest", { op: "inspect" }));
    await waitFor(() => m.requests.some((r) => r.type === "chest"));
    m.emit("chest_finished", { position: { x: 12, y: 64, z: 20 }, items: { torch: 16, iron_ingot: 4 } });
    await waitFor(() => ends(tasks).length === 4);
    expect(ends(tasks).at(-1)).toEqual(["c1", "done"]);
    const mem = await adapter.waypoints.list();
    expect(mem.waypoints.some((w) => w.name === "bed")).toBe(true);
    expect(mem.chests[0]?.items).toEqual({ torch: 16, iron_ingot: 4 });

    // waypoint save -> goto -> list -> delete
    await adapter.tasks.start(spec("w1", "waypoint", { op: "save", name: "farm", x: 30, y: 65, z: -10 }));
    await waitFor(() => ends(tasks).length === 5);
    await adapter.tasks.start(spec("w2", "waypoint", { op: "goto", name: "farm" }));
    await waitFor(() => m.requests.some((r) => r.type === "baritone" && r.x === 30));
    m.emit("goal_reached", { x: 30, y: 65, z: -10 });
    await waitFor(() => ends(tasks).length === 6);
    expect(ends(tasks).at(-1)).toEqual(["w2", "done"]);

    // goto { waypoint } direct act works as well.
    const directGoto = await adapter.act({ name: "goto", args: { waypoint: "farm" } });
    expect(directGoto.ok).toBe(true);
    expect(m.requests.at(-1)).toMatchObject({ type: "baritone", command: "goto", x: 30, y: 65, z: -10 });

    // inspect forces next screenshot capture bypassing cooldown.
    m.respond = (req) =>
      req.type === "observe"
        ? { ok: true, data: { world_id: "w_main", dimension: "overworld", position: { x: 10, y: 64, z: 20 } } }
        : req.type === "screenshot"
          ? { ok: true, data: { mime: "image/jpeg", data_base64: "AAAA" } }
          : { ok: true, data: {} };
    await adapter.observe(); // baseline
    const insp = await adapter.act({ name: "inspect", args: { reason: "看清建築" } });
    expect(insp.ok).toBe(true);
    const obs = await adapter.observe();
    expect((obs as { screenshot?: { mime: string; data: string; detail?: string } }).screenshot).toMatchObject({
      mime: "image/jpeg",
      data: "AAAA",
      detail: "high",
    });
    // Immediate second observe does NOT trigger another screenshot inside cooldown.
    const obs2 = await adapter.observe();
    expect(obs2.screenshot).toBeUndefined();
    expect(m.requests.filter((r) => r.type === "screenshot")).toHaveLength(1);
  });

  it("handles recoverable reflex pauses on mod jobs without failing prematurely", async () => {
    const { mod: m, adapter } = await setup();
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("g1", "goto", { x: 5, z: 5 }));
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));

    // Recoverable reflex pauses Baritone and resumes cleanly.
    m.emit("reflex", { kind: "eat", interrupted: "Goto", recoverable: true, paused_task: true });
    m.emit("baritone_idle", { paused: true, recoverable: true });
    await new Promise((r) => setTimeout(r, 15));
    expect(ends(tasks)).toEqual([]);

    m.emit("reflex_resumed", { kind: "eat" });
    m.emit("goal_reached", {});
    await waitFor(() => ends(tasks).length === 1);
    expect(ends(tasks)).toEqual([["g1", "done"]]);

    // If a recoverable reflex aborts instead of resuming, fail cleanly as busy.
    await adapter.tasks.start(spec("g2", "goto", { x: 9, z: 9 }));
    await waitFor(() => m.requests.filter((r) => r.type === "baritone").length === 2);
    m.emit("reflex", { kind: "lava", recoverable: true, paused_task: true });
    m.emit("reflex_aborted", { kind: "lava" });
    await waitFor(() => ends(tasks).length === 2);
    expect(ends(tasks).at(-1)).toEqual(["g2", "busy"]);
  });

  it("persists waypoints and remembered chests across adapter restarts and uses them in obtain", async () => {
    const storage = memoryStorage();
    let inv: Record<string, number> = { stick: 2 };
    const snap = () => ({
      world_id: "persist_world",
      dimension: "overworld",
      position: { x: 10, y: 64, z: 10 },
      inventory: inv,
      nearby_blocks: [{ block: "crafting_table", count: 1, distance: 2, nearest: { x: 11, y: 64, z: 10 } }],
    });

    // Session 1: observe + death + chest_contents
    const s1 = await setup({ storage });
    s1.mod.respond = (req) => (req.type === "observe" ? { ok: true, data: snap() } : { ok: true, data: {} });
    await s1.adapter.observe();
    s1.mod.emit("death", { last_damage_source: "fall", position: { x: 42, y: 50, z: -18 }, dimension: "overworld" });
    s1.mod.emit("chest_contents", { position: { x: 12, y: 64, z: 10 }, items: { iron_ingot: 3 } });
    await waitFor(
      () =>
        s1.adapter.waypoints.getSync("last_death") !== undefined &&
        s1.adapter.waypoints.nearbyChests("overworld", { x: 10, y: 64, z: 10 }).length > 0,
    );
    await s1.adapter.waypoints.flush();
    s1.adapter.close();
    s1.bridge.close();
    await s1.mod.stop();
    mod = undefined;

    // Session 2: new FakeMod + new Adapter sharing the same storage!
    const s2 = await setup({ storage });
    s2.mod.respond = (req) => {
      if (req.type === "observe") return { ok: true, data: snap() };
      if (req.type === "chest" && req.op === "take") {
        inv = { ...inv, iron_ingot: 3 };
        setTimeout(() => s2.mod.emit("chest_finished", { position: { x: 12, y: 64, z: 10 }, taken: { iron_ingot: 3 } }), 2);
      } else if (req.type === "craft" && req.item === "iron_pickaxe") {
        inv = { iron_pickaxe: 1 };
        setTimeout(() => s2.mod.emit("craft_finished", { item: "iron_pickaxe", crafted: 1 }), 2);
      }
      return { ok: true, data: {} };
    };

    // First observe loads persist_world into WaypointStore.
    await s2.adapter.observe();
    const goDeath = await s2.adapter.act({ name: "goto", args: { waypoint: "last_death" } });
    expect(goDeath.ok).toBe(true);
    expect(s2.mod.requests.at(-1)).toMatchObject({ type: "baritone", command: "goto", x: 42, y: 50, z: -18 });

    // `obtain iron_pickaxe` uses remembered chest_take -> craft without re-mining iron!
    const tasks = taskEvents(s2.adapter);
    await s2.adapter.tasks.start(spec("o1", "obtain", { item: "iron_pickaxe" }));
    await waitFor(() => ends(tasks).length === 1);
    expect(ends(tasks)).toEqual([["o1", "done"]]);
    expect(s2.mod.requests.some((r) => r.type === "chest" && r.op === "take")).toBe(true);
    expect(s2.mod.requests.some((r) => r.type === "baritone" && r.command === "mine")).toBe(false);
  });

  it("supports live TaskSteer on mine, goto, explore, follow, and hunt (both modTasks false and true)", async () => {
    // 1. Legacy mod (modTasks: false): mine steer suppresses old Baritone cancel echo and keeps outer TaskId!
    const s1 = await setup({ modTasks: false });
    s1.mod.respond = (req) => {
      if (req.type === "observe") {
        return { ok: true, data: { world_id: "w1", position: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } } };
      }
      // Second baritone mine triggers a cancel echo from the replaced job.
      if (req.type === "baritone" && req.command === "mine" && s1.mod.requests.filter((r) => r.type === "baritone").length === 2) {
        setTimeout(() => s1.mod.emit("baritone_idle", { cancelled: true, process: "Mine" }), 2);
      }
      return { ok: true, data: {} };
    };

    const t1 = taskEvents(s1.adapter);
    await s1.adapter.tasks.start(spec("m_live", "mine", { block: "coal_ore", count: 4 }));
    await waitFor(() => s1.mod.requests.some((r) => r.type === "baritone" && (r.blocks as string[])[0] === "coal_ore"));

    // Weak pickaxe steer for diamond_ore is rejected WITHOUT breaking running coal_ore mining!
    await s1.adapter.tasks.steer({
      id: "bad_pick",
      task: "m_live",
      patch: { block: "diamond_ore" },
      why: "need diamond",
      cause: "user",
    });
    await waitFor(() => t1.some((e) => e.type === "steered" && e.steer === "bad_pick"));
    expect(t1.find((e) => e.type === "steered" && e.steer === "bad_pick")).toMatchObject({ outcome: "rejected" });
    expect(s1.adapter.tasks.running).toEqual(["m_live"]);

    // Valid steer to iron_ore re-targets mod live while keeping task "m_live".
    await s1.adapter.tasks.steer({
      id: "to_iron",
      task: "m_live",
      patch: { block: "iron_ore", count: 3 },
      why: "switch ore",
      cause: "user",
    });
    await waitFor(() => t1.some((e) => e.type === "steered" && e.steer === "to_iron"));
    expect(t1.find((e) => e.type === "steered" && e.steer === "to_iron")).toMatchObject({ outcome: "applied" });
    expect(s1.mod.requests.filter((r) => r.type === "baritone").at(-1)).toMatchObject({ blocks: ["iron_ore"], count: 3 });

    // Wait past cancel echo, then complete new target.
    await new Promise((r) => setTimeout(r, 15));
    s1.mod.emit("baritone_idle", { process: "Mine" });
    await waitFor(() => ends(t1).length === 1);
    expect(ends(t1)).toEqual([["m_live", "done"]]);

    // Hunt, explore, follow live steer cleanly too.
    await s1.adapter.tasks.start(spec("h_live", "hunt", { entity: "cow", count: 2 }));
    await waitFor(() => s1.mod.requests.some((r) => r.type === "hunt"));
    await s1.adapter.tasks.steer({ id: "h_steer", task: "h_live", patch: { entity: "sheep", count: 3 }, why: "wool", cause: "user" });
    await waitFor(() => t1.some((e) => e.type === "steered" && e.steer === "h_steer" && e.outcome === "applied"));
    expect(s1.mod.requests.filter((r) => r.type === "hunt").at(-1)).toMatchObject({ entity: "sheep", count: 3 });
    s1.mod.emit("hunt_finished", { entity: "sheep", collected: 3 });
    await waitFor(() => ends(t1).some(([id]) => id === "h_live"));

    // Non-steerable goal (`sleep` / `craft`) rejects steer cleanly.
    await s1.adapter.tasks.start(spec("slp", "sleep"));
    await waitFor(() => s1.mod.requests.some((r) => r.type === "sleep"));
    await s1.adapter.tasks.steer({ id: "slp_s", task: "slp", patch: { x: 1 }, why: "x", cause: "user" });
    await waitFor(() => t1.some((e) => e.type === "steered" && e.steer === "slp_s"));
    expect(t1.find((e) => e.type === "steered" && e.steer === "slp_s")).toMatchObject({ outcome: "rejected" });
    s1.mod.emit("sleep_finished", {});
    await waitFor(() => ends(t1).some(([id]) => id === "slp"));

    s1.adapter.close();
    s1.bridge.close();
    await s1.mod.stop();
    mod = undefined;

    // 2. Task-aware mod (modTasks: true): goto steer bumps modTaskId and ignores superseded event from old modTaskId.
    const s2 = await setup({ modTasks: true });
    s2.mod.respond = (req) => {
      if (req.type === "baritone" && req.task === "g_live~1") {
        setTimeout(() => s2.mod.emit("task_failed", { task: "g_live", code: "superseded", message: "replaced" }), 2);
      }
      return { ok: true, data: {} };
    };
    const t2 = taskEvents(s2.adapter);
    await s2.adapter.tasks.start(spec("g_live", "goto", { x: 10, z: 10 }));
    await waitFor(() => s2.mod.requests.some((r) => r.type === "baritone" && r.task === "g_live"));
    await s2.adapter.tasks.steer({ id: "g_s", task: "g_live", patch: { x: 25, z: -40 }, why: "new dest", cause: "user" });
    await waitFor(() => s2.mod.requests.some((r) => r.type === "baritone" && r.task === "g_live~1"));
    await new Promise((r) => setTimeout(r, 15));
    expect(ends(t2)).toEqual([]); // old task_failed(superseded) ignored!
    s2.mod.emit("task_done", { task: "g_live~1", detail: "到新地點了" });
    await waitFor(() => ends(t2).length === 1);
    expect(ends(t2)).toEqual([["g_live", "done"]]);

    // Explore & follow steer under modTasks: true as well.
    await s2.adapter.tasks.start(spec("ex1", "explore", {}, 2));
    await waitFor(() => s2.mod.requests.some((r) => r.command === "explore" && r.task === "ex1"));
    await s2.adapter.tasks.steer({ id: "ex_s", task: "ex1", patch: { x: 100, z: 100 }, why: "north", cause: "user" });
    await waitFor(() => s2.mod.requests.some((r) => r.command === "explore" && r.task === "ex1~1"));
    await s2.adapter.tasks.cancel("ex1");

    await s2.adapter.tasks.start(spec("fw1", "follow", { entity: "cow" }, 2));
    await waitFor(() => s2.mod.requests.some((r) => r.command === "follow" && r.task === "fw1"));
    await s2.adapter.tasks.steer({ id: "fw_s", task: "fw1", patch: { player: "Steve" }, why: "follow Steve", cause: "user" });
    await waitFor(() => s2.mod.requests.some((r) => r.command === "follow" && r.task === "fw1~1" && r.player === "Steve"));
    await s2.adapter.tasks.cancel("fw1");
  });

  it("maps new reflex and worker events in Traditional Chinese", () => {
    expect(mapEvent({ name: "reflex", data: { kind: "shield_block", target: "skeleton", recoverable: true } })?.data).toMatchObject({
      text: "舉起盾牌擋住攻擊(骷髏)",
    });
    expect(mapEvent({ name: "reflex_resumed", data: { kind: "eat", resumed_task: "Mine" } })?.data).toMatchObject({
      text: "吃飽了,已自動恢復原本的動作",
    });
    expect(mapEvent({ name: "reflex_resumed", data: { task: "t1", kind: "mine_branch", reflex: "eat" } })?.data).toMatchObject({
      text: "吃飽了,已自動恢復原本的動作",
    });
    expect(mapEvent({ name: "reflex_aborted", data: { kind: "lava", reason: "太危險" } })?.data).toMatchObject({
      text: "本能反應後沒能恢復原本的動作(太危險)",
    });
    expect(mapEvent({ name: "sleep_finished", data: {} })?.data).toMatchObject({ text: "在床上睡醒了(已設重生點)" });
    expect(mapEvent({ name: "sleep_finished", data: { slept: false, spawn_set: true } })?.data).toMatchObject({
      text: "點了床設好重生點(現在是白天)",
    });
    expect(mapEvent({ name: "hunt_finished", data: { entity: "cow", collected: 3 } })?.data).toMatchObject({
      text: "打獵結束(牛×3)",
    });
    expect(mapEvent({ name: "hunt_finished", data: { entity: "pig", killed: 2 } })?.data).toMatchObject({
      text: "打獵結束(豬×2)",
    });
    expect(mapEvent({ name: "branch_progress", data: { position: { x: 1, y: -54, z: 2 }, steps: 16 } })?.data).toMatchObject({
      text: "分支挖礦中(Y=-54) 前進 16 格",
    });
    expect(mapEvent({ name: "branch_finished", data: { target_y: -54, found: true } })?.data).toMatchObject({
      text: "分支挖礦結束",
    });
    expect(mapEvent({ name: "clear_leaves_finished", data: { cleared: 12 } })?.data).toMatchObject({
      text: "清除了擋路的樹葉(12 格)",
    });
    expect(mapEvent({ name: "clear_leaves_finished", data: { broken: 8, max_blocks: 24 } })?.data).toMatchObject({
      text: "清除了擋路的樹葉(8 格)",
    });
    expect(mapEvent({ name: "chest_contents", data: { items: { diamond: 2, torch: 10 } } })?.data).toMatchObject({
      text: "打開箱子看到:鑽石×2、火把×10",
    });
  });
});
