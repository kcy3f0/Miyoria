import { describe, expect, it } from "vitest";
import { compactState, summarize } from "../src/summary.js";
import { type AdapterStorage, WaypointStore, chestKey, normalizeChestItems } from "../src/waypoints.js";

function memoryStorage(): AdapterStorage & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    async get<T>(key: string) {
      return raw.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      raw.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string) {
      raw.delete(key);
    },
  };
}

describe("WaypointStore", () => {
  it("persists per-world waypoints across store restarts without mixing worlds", async () => {
    const storage = memoryStorage();
    let now = 1000;
    const s1 = new WaypointStore({ storage, now: () => ++now });

    await s1.observeSnapshot({
      world_id: "survival_alpha",
      dimension: "overworld",
      block_position: { x: 100, y: 64, z: -200 },
      nearby_blocks: [
        { block: "crafting_table", count: 1, nearest: { x: 102, y: 64, z: -200 } },
        { block: "furnace", count: 1, nearest: { x: 103, y: 64, z: -200 } },
        { block: "red_bed", count: 1, nearest: { x: 101, y: 64, z: -199 } },
      ],
    });
    await s1.set("portal", { x: 50, y: 70, z: -80, dimension: "overworld", note: "山谷傳送門" });
    await s1.recordDeath({ position: { x: 120, y: 30, z: -220 }, dimension: "overworld" });
    await s1.recordMineEntrance({ x: 110, y: 62, z: -190 }, "overworld");

    // Second world should stay cleanly separated.
    await s1.observeSnapshot({
      world_id: "creative_beta",
      dimension: "overworld",
      block_position: { x: 0, y: 80, z: 0 },
    });
    await s1.flush();

    // New instance simulates extension restart reading the same storage.
    const s2 = new WaypointStore({ storage });
    await s2.ensureWorld("survival_alpha");
    expect(await s2.get("home", "survival_alpha")).toMatchObject({ x: 100, y: 64, z: -200, kind: "home" });
    expect(await s2.get("table", "survival_alpha")).toMatchObject({ x: 102, y: 64, z: -200 });
    expect(await s2.get("furnace", "survival_alpha")).toMatchObject({ x: 103, y: 64, z: -200 });
    expect(await s2.get("bed", "survival_alpha")).toMatchObject({ x: 101, y: 64, z: -199 });
    expect(await s2.get("last_death", "survival_alpha")).toMatchObject({ x: 120, y: 30, z: -220, kind: "last_death" });
    expect(await s2.get("mine", "survival_alpha")).toMatchObject({ x: 110, y: 62, z: -190, kind: "mine" });
    expect(await s2.get("portal", "survival_alpha")).toMatchObject({ note: "山谷傳送門" });

    expect(await s2.get("portal", "creative_beta")).toBeUndefined();
    expect(await s2.get("home", "creative_beta")).toMatchObject({ x: 0, y: 80, z: 0 });
  });

  it("never guesses unopened chests and only updates chest memory from chest_contents / chest_finished", async () => {
    const storage = memoryStorage();
    const store = new WaypointStore({ storage });

    await store.observeSnapshot({
      world_id: "w1",
      dimension: "overworld",
      block_position: { x: 10, y: 64, z: 10 },
      nearby_blocks: [{ block: "chest", count: 1, distance: 3, nearest: { x: 12, y: 64, z: 10 } }],
    });
    expect(store.nearbyChests("overworld", { x: 10, y: 64, z: 10 })).toEqual([]);
    expect((await store.list()).chests).toEqual([]);

    // Opening chest emits `chest_contents`.
    const opened = await store.recordChestEvent("chest_contents", {
      position: { x: 12, y: 64, z: 10 },
      items: [
        { item: "minecraft:iron_ingot", count: 5 },
        { item: "oak_log", count: 8 },
      ],
    });
    expect(opened?.key).toBe(chestKey({ x: 12, y: 64, z: 10 }));
    expect(opened?.items).toEqual({ iron_ingot: 5, oak_log: 8 });

    // Taking items via `chest_finished` delta adjusts remembered counts accurately.
    await store.recordChestEvent("chest_finished", {
      position: { x: 12, y: 64, z: 10 },
      taken: { iron_ingot: 3 },
      stored: { cobblestone: 12 },
    });
    const chests = store.nearbyChests("overworld", { x: 10, y: 64, z: 10 }, 64);
    expect(chests).toHaveLength(1);
    expect(chests[0]?.items).toEqual({ iron_ingot: 2, oak_log: 8, cobblestone: 12 });

    // Summary and compactState reflect waypoints & known chests concisely.
    const mem = store.summarySync();
    const summary = summarize({ world_id: "w1", position: { x: 10, y: 64, z: 10 } }, mem);
    const state = compactState({ world_id: "w1", position: { x: 10, y: 64, z: 10 } }, mem);
    expect(summary).toContain("記憶點 1 個:home(10,64,10)");
    expect(summary).toContain("已記箱子 1 個(共 22 件");
    expect(state).toMatchObject({ world_id: "w1", known_chests: 1, waypoints: { home: { x: 10, y: 64, z: 10 } } });
  });

  it("normalizes both array and record chest item shapes", () => {
    expect(normalizeChestItems([{ item: "minecraft:coal", count: 4 }, { item: "coal", count: 2 }])).toEqual({ coal: 6 });
    expect(normalizeChestItems({ "minecraft:torch": 10, dirt: 0 })).toEqual({ torch: 10 });
  });
});
