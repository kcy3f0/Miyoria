import type { GameEvent } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { toRequests } from "../src/actions.js";
import { MinecraftAdapter, taskOf } from "../src/adapter.js";
import { BridgeClient } from "../src/bridge.js";
import { mapEvent } from "../src/events.js";
import { compactState, summarize } from "../src/summary.js";
import { FakeMod, SNAPSHOT, waitFor } from "./fake-mod.js";

let mod: FakeMod | undefined;
let bridge: BridgeClient | undefined;

afterEach(async () => {
  bridge?.close();
  bridge = undefined;
  await mod?.stop();
  mod = undefined;
});

async function setup(opts: ConstructorParameters<typeof MinecraftAdapter>[1] = {}) {
  mod = await FakeMod.start();
  const m = mod;
  bridge = new BridgeClient({
    endpoint: () => ({ url: m.url, token: m.token }),
    reconnectMinMs: 20,
    requestTimeoutMs: 500,
  });
  const adapter = new MinecraftAdapter(bridge, opts);
  bridge.start();
  const b = bridge;
  await waitFor(() => b.ready);
  return { mod: m, adapter };
}

/** Collects events from the adapter's stream in the background. */
function collect(adapter: MinecraftAdapter): GameEvent[] {
  const out: GameEvent[] = [];
  void (async () => {
    for await (const e of adapter.events()) out.push(e);
  })();
  return out;
}

describe("summary", () => {
  it("summarizes a snapshot in Traditional Chinese", () => {
    const text = summarize(SNAPSHOT);
    expect(text).toContain("血量 17.5/20、飢餓 18/20");
    expect(text).toContain("位置 (100, 64, -21)・主世界・平原");
    expect(text).toContain("白天(約 5 分鐘後天黑)、晴天");
    expect(text).toContain("手上:鐵鎬(耐久 88%)");
    expect(text).toContain("背包:鵝卵石×84、蘋果×3、鐵鎬×1(空格 32)");
    expect(text).toContain("看著:橡木原木(2.4 格)");
    expect(text).toContain("附近:殭屍 3 格(敵對)、玩家 Steve 8 格、牛 12 格");
    expect(text).toContain("看得到的方塊:鑽石礦×2 40 格、箱子×1 5 格");
    expect(text).toContain("最好的鎬:鐵鎬");
    expect(text).toContain("食物:蘋果×3");
    expect(text).toContain("Baritone 執行中(Mine)");
  });

  it("keeps a compact structured state with ids", () => {
    const state = compactState(SNAPSHOT);
    expect(state).toMatchObject({
      connected: true,
      in_game: true,
      busy: true,
      health: 17.5,
      position: { x: 100, y: 64, z: -21 },
      held: "iron_pickaxe",
      inventory: { cobblestone: 84, apple: 3, iron_pickaxe: 1 },
      entities: [{ type: "zombie", d: 3, hostile: true }, { type: "player", name: "Steve", d: 8 }, { type: "cow", d: 12 }],
      blocks: [{ block: "diamond_ore", count: 2, at: { x: 30, y: 12, z: 30 } }, { block: "chest", count: 1 }],
      baritone: { busy: true, process: "Mine" },
    });
    expect(state).not.toHaveProperty("hotbar");
    expect(state).not.toHaveProperty("altoclef");
    expect(JSON.stringify(state).length).toBeLessThan(JSON.stringify(SNAPSHOT).length);
  });
});

describe("actions", () => {
  it("maps high-level actions onto mod requests", () => {
    expect(toRequests({ name: "goto", args: { x: 1.4, z: -3 } })).toEqual([
      { type: "baritone", params: { command: "goto", x: 1, z: -3 } },
    ]);
    expect(toRequests({ name: "goto", args: { block: "Crafting Table" } })).toEqual([
      { type: "baritone", params: { command: "goto", block: "crafting_table" } },
    ]);
    expect(toRequests({ name: "mine", args: { blocks: ["iron_ore"], block: "deepslate_iron_ore", count: "12" } })).toEqual([
      { type: "baritone", params: { command: "mine", blocks: ["iron_ore", "deepslate_iron_ore"], count: 12 } },
    ]);
    expect(toRequests({ name: "follow", args: { player: "Owen" } })[0]?.params).toEqual({ command: "follow", player: "Owen" });
    expect(toRequests({ name: "explore" })[0]?.params).toEqual({ command: "explore" });
    expect(toRequests({ name: "farm", args: { range: 10 } })[0]?.params).toEqual({ command: "farm", range: 10 });
    expect(toRequests({ name: "build", args: { schematic: "house.schem" } })[0]?.params).toEqual({
      command: "build",
      schematic: "house.schem",
    });
    expect(toRequests({ name: "get", args: { item: "iron_pickaxe" } })).toEqual([
      { type: "altoclef", params: { command: "get iron_pickaxe 1" } },
    ]);
    expect(toRequests({ name: "chat", args: { message: "大家好" } })).toEqual([{ type: "chat", params: { message: "大家好" } }]);
    expect(toRequests({ name: "look", args: { at: { x: 1, y: 2, z: 3 } } })).toEqual([
      { type: "look", params: { at: { x: 1, y: 2, z: 3 } } },
    ]);
    expect(toRequests({ name: "look", args: { pitch: 200 } })[0]?.params).toEqual({ pitch: 90 });
    expect(toRequests({ name: "use", args: { hold_ticks: 32 } })).toEqual([{ type: "use", params: { hold_ticks: 32 } }]);
    expect(toRequests({ name: "attack" })).toEqual([{ type: "attack", params: {} }]);
    expect(toRequests({ name: "select", args: { item: "bread" } })).toEqual([{ type: "select_slot", params: { item: "bread" } }]);
    expect(toRequests({ name: "respawn" })).toEqual([{ type: "respawn", params: {} }]);
    expect(toRequests({ name: "stop" })).toEqual([{ type: "stop", params: {} }]);
  });

  it("rejects bad arguments with a message for the model", () => {
    expect(() => toRequests({ name: "goto", args: {} })).toThrow("goto 要給");
    expect(() => toRequests({ name: "mine", args: {} })).toThrow("mine 要給");
    expect(() => toRequests({ name: "chat", args: { message: "/op me" } })).toThrow("不能下指令");
    expect(toRequests({ name: "chat", args: { message: "/time set day" } }, { allowCommands: true })).toHaveLength(1);
    expect(() => toRequests({ name: "select", args: { slot: 9 } })).toThrow("0–8");
    expect(() => toRequests({ name: "fly" })).toThrow("沒有「fly」");
  });
});

describe("events", () => {
  it("maps mod events with text and importance", () => {
    expect(mapEvent({ name: "death", data: { last_damage_source: "mob", last_attacker: "creeper" } })).toEqual({
      type: "death",
      data: { last_damage_source: "mob", last_attacker: "creeper", text: "死掉了(苦力怕)" },
      important: true,
    });
    expect(mapEvent({ name: "damage", data: { amount: 1, source: "fall", health: 19 } })).toMatchObject({
      important: false,
      data: { text: "受傷 -1(摔落),剩 19 血" },
    });
    expect(mapEvent({ name: "damage", data: { amount: 6, source: "explosion" } })?.important).toBe(true);
    expect(mapEvent({ name: "damage", data: { amount: 2 } }, { damageImportant: 2 })?.important).toBe(true);
    expect(mapEvent({ name: "hostile_near", data: { new_types: ["zombie"] } })?.important).toBe(false);
    expect(mapEvent({ name: "hostile_near", data: { new_types: ["creeper"] } })).toMatchObject({
      important: true,
      data: { text: "附近出現 苦力怕" },
    });
    expect(mapEvent({ name: "item_picked", data: { items: { diamond: 1 } } })?.important).toBe(true);
    expect(mapEvent({ name: "chat", data: { sender: "Me", message: "hi", system: false, self: true } })).toBeNull();
    expect(mapEvent({ name: "chat", data: { sender: "Steve", message: "你好", system: false, self: false } })).toMatchObject({
      important: true,
      data: { text: "Steve 在遊戲裡說:你好" },
    });
    expect(mapEvent({ name: "advancement", data: { kind: "task", title: "Stone Age" } })?.data).toMatchObject({
      text: "達成成就「Stone Age」",
    });
    expect(mapEvent({ name: "baritone_idle", data: { cancelled: true } })?.important).toBe(false);
    expect(mapEvent({ name: "Weird Name", data: {} })).toBeNull();
    expect(mapEvent({ name: "something_new", data: { a: 1 } })).toEqual({ type: "something_new", data: { a: 1 } });
  });
});

describe("MinecraftAdapter", () => {
  it("describes the game", async () => {
    const { adapter } = await setup();
    const info = adapter.describe();
    expect(info.id).toBe("minecraft");
    expect(info.actions.map((a) => a.name)).toEqual([
      "goto",
      "mine",
      "follow",
      "explore",
      "farm",
      "build",
      "get",
      "craft",
      "smelt",
      "place",
      "chat",
      "stop",
      "look",
      "attack",
      "use",
      "select",
      "respawn",
    ]);
  });

  it("observes through the mod", async () => {
    const { mod, adapter } = await setup();
    mod.respond = (req) => (req.type === "observe" ? { ok: true, data: SNAPSHOT } : { ok: true });
    const obs = await adapter.observe();
    expect(obs.summary).toContain("血量 17.5/20");
    expect(obs.state).toMatchObject({ busy: true, capabilities: { baritone: true, altoclef: true } });

    mod.respond = () => ({ ok: false, code: "not_in_game", message: "no world" });
    const menu = await adapter.observe();
    expect(menu.summary).toContain("主選單");
    expect(menu.state).toMatchObject({ connected: true, in_game: false });
  });

  it("reports a missing connection instead of throwing", async () => {
    const b = new BridgeClient({ endpoint: () => ({ url: "ws://127.0.0.1:1", token: "x" }) });
    const adapter = new MinecraftAdapter(b);
    const obs = await adapter.observe();
    expect(obs.state).toEqual({ connected: false });
    expect(obs.summary).toContain("沒有連上 Minecraft");
    expect(await adapter.act({ name: "stop" })).toMatchObject({ ok: false, message: expect.stringContaining("沒有連上") });
  });

  it("acts and maps mod errors", async () => {
    const { mod, adapter } = await setup();
    mod.respond = (req) =>
      req.type === "baritone" ? { ok: true, data: { command: req.command } } : { ok: false, code: "invalid_args", message: "slot must be 0-8" };
    expect(await adapter.act({ name: "mine", args: { block: "iron_ore", count: 3 } })).toEqual({
      ok: true,
      message: "開始挖 iron_ore ×3",
      data: { command: "mine" },
    });
    expect(mod.requests.at(-1)).toMatchObject({ type: "baritone", command: "mine", blocks: ["iron_ore"], count: 3 });
    expect(await adapter.act({ name: "select", args: { item: "x" } })).toEqual({
      ok: false,
      message: "參數不對:slot must be 0-8",
    });
    expect(await adapter.act({ name: "goto", args: {} })).toMatchObject({ ok: false });
    // observe (her pickaxe, for the mine check), mine, select_slot
    expect(mod.requests.map((r) => r.type)).toEqual(["observe", "baritone", "select_slot"]);
  });

  it("checks capabilities before sending", async () => {
    mod = await FakeMod.start();
    mod.capabilities = { baritone: true, altoclef: false, screenshot: false };
    const m = mod;
    bridge = new BridgeClient({ endpoint: () => ({ url: m.url, token: m.token }) });
    const adapter = new MinecraftAdapter(bridge);
    bridge.start();
    const b = bridge;
    await waitFor(() => b.ready);
    expect(await adapter.act({ name: "get", args: { item: "iron_pickaxe" } })).toMatchObject({
      ok: false,
      message: expect.stringContaining("AltoClef"),
    });
    expect(m.requests).toHaveLength(0);
  });

  it("streams mapped events, connection changes included", async () => {
    mod = await FakeMod.start();
    const m = mod;
    bridge = new BridgeClient({ endpoint: () => ({ url: m.url, token: m.token }), reconnectMinMs: 20 });
    const adapter = new MinecraftAdapter(bridge);
    const events = collect(adapter);
    bridge.start();
    const b = bridge;
    await waitFor(() => b.ready);
    m.emit("death", { last_damage_source: "lava" });
    m.emit("chat", { sender: "Me", message: "x", system: false, self: true });
    m.emit("goal_reached", { goal: "GoalBlock{x=1,y=2,z=3}" });
    await waitFor(() => events.length === 3);
    expect(events.map((e) => e.type)).toEqual(["connected", "death", "goal_reached"]);
    expect(events[0]?.data).toMatchObject({ text: "連上 Minecraft 1.21.1(Baritone、AltoClef)" });
    expect(events[1]).toMatchObject({ important: true, data: { text: "死掉了(岩漿)" } });
    m.kick();
    await waitFor(() => events.some((e) => e.type === "disconnected"));
    await waitFor(() => events.filter((e) => e.type === "connected").length === 2);
    adapter.close();
  });
});

describe("path events", () => {
  it("knows which task an action leaves running", () => {
    expect(taskOf(toRequests({ name: "goto", args: { x: 1, z: 2 } }))).toBe("goto");
    expect(taskOf(toRequests({ name: "mine", args: { block: "iron_ore" } }))).toBe("baritone");
    expect(taskOf(toRequests({ name: "follow", args: { player: "Owen" } }))).toBe("baritone");
    expect(taskOf(toRequests({ name: "get", args: { item: "bread" } }))).toBe("altoclef");
    expect(taskOf(toRequests({ name: "stop" }))).toBeNull();
    expect(taskOf(toRequests({ name: "chat", args: { message: "hi" } }))).toBeUndefined();
    expect(taskOf(toRequests({ name: "look", args: { yaw: 0 } }))).toBeUndefined();
  });

  /** Emits a marker and waits for it, so everything sent before it has been handled. */
  async function flush(m: FakeMod, events: GameEvent[]): Promise<void> {
    const n = events.filter((e) => e.type === "night_started").length;
    m.emit("night_started", { time_of_day: 13000 });
    await waitFor(() => events.filter((e) => e.type === "night_started").length === n + 1);
  }

  const types = (events: GameEvent[]) => events.map((e) => e.type).filter((t) => t !== "night_started");

  it("only lets a goto end on goal_reached; mining ends on baritone_idle", async () => {
    const { mod: m, adapter } = await setup();
    const events = collect(adapter);
    await waitFor(() => events.length === 1); // connected

    expect(await adapter.act({ name: "mine", args: { block: "iron_ore", count: 5 } })).toMatchObject({ ok: true });
    expect(adapter.task).toBe("baritone");
    // Baritone reaches (or fails to path to) one ore after another while mining.
    m.emit("goal_reached", { goal: "GoalComposite" });
    m.emit("goal_failed", { reason: "no_path", goal: "GoalComposite" });
    await flush(m, events);
    expect(types(events)).toEqual(["connected"]);
    m.emit("baritone_idle", { process: "Mine", goal: null, cancelled: false });
    await waitFor(() => types(events).includes("baritone_idle"));
    expect(adapter.task).toBeNull();

    expect(await adapter.act({ name: "goto", args: { x: 10, y: 64, z: 10 } })).toMatchObject({ ok: true });
    expect(adapter.task).toBe("goto");
    m.emit("goal_reached", { goal: "GoalBlock{x=10,y=64,z=10}" });
    await waitFor(() => types(events).includes("goal_reached"));
    expect(types(events)).toEqual(["connected", "baritone_idle", "goal_reached"]);
  });

  it("chat and look do not change the running task", async () => {
    const { mod: m, adapter } = await setup();
    const events = collect(adapter);
    await adapter.act({ name: "follow", args: { player: "Owen" } });
    await adapter.act({ name: "chat", args: { message: "我跟著你" } });
    m.emit("goal_reached", { goal: "GoalNear" });
    await flush(m, events);
    expect(types(events)).toEqual(["connected"]);
    expect(adapter.task).toBe("baritone");
  });

  it("waits for AltoClef itself to be idle before ending a get", async () => {
    const { mod: m, adapter } = await setup();
    let altoBusy: boolean | null = true;
    m.respond = (req) =>
      req.type === "observe"
        ? { ok: true, data: { ...SNAPSHOT, altoclef: { available: true, busy: altoBusy } } }
        : { ok: true, data: {} };
    const events = collect(adapter);
    await waitFor(() => events.length === 1);
    expect(await adapter.act({ name: "get", args: { item: "iron_pickaxe" } })).toMatchObject({ ok: true });
    expect(adapter.task).toBe("altoclef");

    // Baritone finishes one leg of the AltoClef task (walk to a tree), AltoClef keeps going.
    m.emit("goal_reached", { goal: "GoalGetToBlock" });
    m.emit("baritone_idle", { process: "Custom Goal", goal: null, cancelled: false });
    await waitFor(() => m.requests.filter((r) => r.type === "observe").length === 1);
    await flush(m, events);
    expect(types(events)).toEqual(["connected"]);
    expect(adapter.task).toBe("altoclef");

    // The last leg: AltoClef is idle now.
    altoBusy = false;
    m.emit("baritone_idle", { process: "Custom Goal", goal: null, cancelled: false });
    await waitFor(() => types(events).includes("baritone_idle"));
    expect(events.find((e) => e.type === "baritone_idle")).toMatchObject({
      data: { text: "AltoClef 任務做完了,停下來", altoclef_done: true },
    });
    expect(adapter.task).toBeNull();
  });

  it("forwards an idle we caused during an AltoClef task right away", async () => {
    const { mod: m, adapter } = await setup();
    const events = collect(adapter);
    await adapter.act({ name: "get", args: { item: "bread" } });
    m.emit("baritone_idle", { process: "Custom Goal", goal: null, cancelled: true });
    await waitFor(() => types(events).includes("baritone_idle"));
    expect(m.requests.some((r) => r.type === "observe")).toBe(false);
  });
});
