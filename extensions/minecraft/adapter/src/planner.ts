// Works backwards from an item she wants to the steps that get it in survival: recipes, smelting,
// the blocks that drop it and the pickaxe tier each block needs (harvest.ts), hunting drops, water
// filling, remembered chests, and the crafting table / furnace each step stands at. Pure: inventory
// and world in, steps out. The runner (obtain.ts) executes the first step and plans again from
// what the game really shows.
//
// Ingredients that any member of a vanilla tag satisfies are groups: `#logs`, `#planks`,
// `#stone`, `#coal`, `#boats`, `#wool`, `#beds`. Each source is produced in one go for the whole
// plan (all the logs at once, not a trip per plank).

import { type Tier, pickaxeTier, requiredTier } from "./harvest.js";
import { zh } from "./names.js";

export type Inventory = Record<string, number>;

const WOODS = ["oak", "birch", "spruce", "jungle", "acacia", "dark_oak", "mangrove", "cherry"];
const STEMS = ["crimson", "warped"];
const WOOL_COLORS = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
];

const GROUPS: Record<string, string[]> = {
  "#logs": [
    ...WOODS.flatMap((w) => [`${w}_log`, `stripped_${w}_log`, `${w}_wood`, `stripped_${w}_wood`]),
    ...STEMS.flatMap((w) => [`${w}_stem`, `stripped_${w}_stem`, `${w}_hyphae`, `stripped_${w}_hyphae`]),
  ],
  "#planks": [...WOODS, ...STEMS, "bamboo"].map((w) => `${w}_planks`),
  "#stone": ["cobblestone", "cobbled_deepslate", "blackstone"],
  "#coal": ["coal", "charcoal"],
  "#boats": [...WOODS.map((w) => `${w}_boat`), "bamboo_raft"],
  "#wool": WOOL_COLORS.map((c) => `${c}_wool`),
  "#beds": WOOL_COLORS.map((c) => `${c}_bed`),
};

/** The planks a log makes (`stripped_birch_wood` → `birch_planks`). */
export function planksOf(log: string): string | undefined {
  // longest match first: `dark_oak` before `oak`
  const wood = [...WOODS, ...STEMS].sort((a, b) => b.length - a.length).find((w) => log.includes(w));
  return wood ? `${wood}_planks` : undefined;
}

/** The boat a planks item makes (`birch_planks` → `birch_boat`, `bamboo_planks` → `bamboo_raft`). */
export function boatOf(planks: string): string | undefined {
  if (planks === "bamboo_planks") return "bamboo_raft";
  const wood = [...WOODS].sort((a, b) => b.length - a.length).find((w) => planks === `${w}_planks`);
  return wood ? `${wood}_boat` : undefined;
}

/** The bed a wool item makes (`red_wool` → `red_bed`). */
export function bedOf(wool: string): string | undefined {
  const color = [...WOOL_COLORS].sort((a, b) => b.length - a.length).find((c) => wool === `${c}_wool`);
  return color ? `${color}_bed` : undefined;
}

export function isGroup(item: string): boolean {
  return item.startsWith("#");
}

export function members(item: string): string[] {
  return GROUPS[item] ?? [item];
}

/** How many of `item` (a group counts every member) the inventory holds. */
export function countOf(inv: Inventory, item: string): number {
  let n = inv[item] ?? 0;
  if (isGroup(item)) for (const m of members(item)) n += inv[m] ?? 0;
  return n;
}

interface Recipe {
  yield: number;
  needs: Array<[string, number]>;
  /** 3x3: needs a crafting table. */
  table: boolean;
}

const recipe = (y: number, needs: Array<[string, number]>, table = true): Recipe => ({ yield: y, needs, table });

const RECIPES: Record<string, Recipe> = {
  "#planks": recipe(4, [["#logs", 1]], false),
  stick: recipe(4, [["#planks", 2]], false),
  crafting_table: recipe(1, [["#planks", 4]], false),
  furnace: recipe(1, [["#stone", 8]]),
  smoker: recipe(1, [["#logs", 4], ["furnace", 1]]),
  blast_furnace: recipe(1, [["iron_ingot", 5], ["furnace", 1], ["smooth_stone", 3]]),
  chest: recipe(1, [["#planks", 8]]),
  torch: recipe(4, [["#coal", 1], ["stick", 1]], false),
  bucket: recipe(1, [["iron_ingot", 3]]),
  shears: recipe(1, [["iron_ingot", 2]], false),
  shield: recipe(1, [["#planks", 6], ["iron_ingot", 1]]),
  bow: recipe(1, [["stick", 3], ["string", 3]]),
  arrow: recipe(4, [["flint", 1], ["stick", 1], ["feather", 1]]),
  flint_and_steel: recipe(1, [["iron_ingot", 1], ["flint", 1]], false),
  bread: recipe(1, [["wheat", 3]]),
  bowl: recipe(4, [["#planks", 3]]),
  ladder: recipe(3, [["stick", 7]]),
  "#boats": recipe(1, [["#planks", 5]]),
  bamboo_raft: recipe(1, [["bamboo_planks", 5]]),
  "#beds": recipe(1, [["#wool", 3], ["#planks", 3]]),
};
for (const w of WOODS) {
  RECIPES[`${w}_boat`] = recipe(1, [[`${w}_planks`, 5]]);
}
for (const c of WOOL_COLORS) {
  RECIPES[`${c}_bed`] = recipe(1, [[`${c}_wool`, 3], ["#planks", 3]]);
}

// Tools and armour of every material.
const TOOL_MATERIALS: Record<string, string> = {
  wooden: "#planks",
  stone: "#stone",
  iron: "iron_ingot",
  golden: "gold_ingot",
  diamond: "diamond",
};
for (const [prefix, material] of Object.entries(TOOL_MATERIALS)) {
  RECIPES[`${prefix}_pickaxe`] = recipe(1, [[material, 3], ["stick", 2]]);
  RECIPES[`${prefix}_axe`] = recipe(1, [[material, 3], ["stick", 2]]);
  RECIPES[`${prefix}_shovel`] = recipe(1, [[material, 1], ["stick", 2]]);
  RECIPES[`${prefix}_hoe`] = recipe(1, [[material, 2], ["stick", 2]]);
  RECIPES[`${prefix}_sword`] = recipe(1, [[material, 2], ["stick", 1]]);
}
for (const [prefix, material] of [
  ["leather", "leather"],
  ["iron", "iron_ingot"],
  ["golden", "gold_ingot"],
  ["diamond", "diamond"],
] as const) {
  RECIPES[`${prefix}_helmet`] = recipe(1, [[material, 5]]);
  RECIPES[`${prefix}_chestplate`] = recipe(1, [[material, 8]]);
  RECIPES[`${prefix}_leggings`] = recipe(1, [[material, 7]]);
  RECIPES[`${prefix}_boots`] = recipe(1, [[material, 4]]);
}

/** Furnace output → input. */
const SMELTING: Record<string, string> = {
  iron_ingot: "raw_iron",
  gold_ingot: "raw_gold",
  copper_ingot: "raw_copper",
  charcoal: "#logs",
  glass: "sand",
  stone: "cobblestone",
  smooth_stone: "stone",
  cooked_beef: "beef",
  cooked_porkchop: "porkchop",
  cooked_mutton: "mutton",
  cooked_chicken: "chicken",
  cooked_rabbit: "rabbit",
  cooked_cod: "cod",
  cooked_salmon: "salmon",
  baked_potato: "potato",
};

const ORE_SMELTS = new Set(["iron_ingot", "gold_ingot", "copper_ingot"]);
const FOOD_SMELTS = new Set([
  "cooked_beef",
  "cooked_porkchop",
  "cooked_mutton",
  "cooked_chicken",
  "cooked_rabbit",
  "cooked_cod",
  "cooked_salmon",
  "baked_potato",
]);

/** Items mined from blocks (Baritone counts the drops of these blocks in the inventory). */
const MINED: Record<string, string[]> = {
  "#logs": WOODS.map((w) => `${w}_log`),
  "#stone": ["stone", "cobblestone", "deepslate", "cobbled_deepslate"],
  cobblestone: ["stone", "cobblestone"],
  cobbled_deepslate: ["deepslate", "cobbled_deepslate"],
  "#coal": ["coal_ore", "deepslate_coal_ore"],
  coal: ["coal_ore", "deepslate_coal_ore"],
  raw_iron: ["iron_ore", "deepslate_iron_ore"],
  raw_copper: ["copper_ore", "deepslate_copper_ore"],
  raw_gold: ["gold_ore", "deepslate_gold_ore"],
  diamond: ["diamond_ore", "deepslate_diamond_ore"],
  redstone: ["redstone_ore", "deepslate_redstone_ore"],
  lapis_lazuli: ["lapis_ore", "deepslate_lapis_ore"],
  emerald: ["emerald_ore", "deepslate_emerald_ore"],
  dirt: ["dirt", "grass_block"],
  sand: ["sand"],
  red_sand: ["red_sand"],
  gravel: ["gravel"],
  flint: ["gravel"],
  clay_ball: ["clay"],
  obsidian: ["obsidian"],
  wheat: ["wheat"],
  potato: ["potatoes"],
  carrot: ["carrots"],
};

/** Items obtained by hunting a visible mob. */
const HUNTED: Record<string, string> = {
  beef: "cow",
  porkchop: "pig",
  mutton: "sheep",
  chicken: "chicken",
  rabbit: "rabbit",
  white_wool: "sheep",
  "#wool": "sheep",
  leather: "cow",
  feather: "chicken",
  string: "spider",
};

/** Optimal Overworld Y levels for underground ores (branch mining). */
const PREFERRED_Y: Record<string, number> = {
  raw_iron: 16,
  iron_ore: 16,
  deepslate_iron_ore: 16,
  "#coal": 48,
  coal: 48,
  coal_ore: 48,
  deepslate_coal_ore: 48,
  raw_copper: 48,
  copper_ore: 48,
  deepslate_copper_ore: 48,
  raw_gold: -16,
  gold_ore: -16,
  deepslate_gold_ore: -16,
  redstone: -16,
  redstone_ore: -16,
  deepslate_redstone_ore: -16,
  lapis_lazuli: -16,
  lapis_ore: -16,
  deepslate_lapis_ore: -16,
  diamond: -54,
  diamond_ore: -54,
  deepslate_diamond_ore: -54,
};

/** Returns the underground branch-mining Y hint for an ore drop or block id. */
export function preferredY(itemOrBlock: string): number | undefined {
  return PREFERRED_Y[itemOrBlock];
}

/** The pickaxe that reaches each tier. */
const TIER_PICKAXE: Record<Exclude<Tier, 0>, string> = {
  1: "wooden_pickaxe",
  2: "stone_pickaxe",
  3: "iron_pickaxe",
  4: "diamond_pickaxe",
};

/**
 * Fuels and how many items each smelts, in the order the mod picks them. Logs are not burnt
 * as they are: as planks the same log smelts four times as much.
 */
const FUELS: Array<[string, number]> = [
  ["#coal", 8],
  ["coal_block", 80],
  ["#planks", 1.5],
];

export interface KnownChest {
  key: string;
  x: number;
  y: number;
  z: number;
  items: Record<string, number>;
  distance?: number;
}

export type Step =
  | { kind: "mine"; item: string; blocks: string[]; count: number; preferredY?: number }
  | { kind: "craft"; item: string; count: number; table: boolean }
  | { kind: "smelt"; item: string; input: string; count: number }
  | { kind: "place"; item: "crafting_table" | "furnace" }
  | { kind: "hunt"; item: string; entity: string; count: number }
  | { kind: "fill_water"; item: "water_bucket" }
  | { kind: "chest_take"; item: string; count: number; chest: { x: number; y: number; z: number } };

/** Stations she can already use where she stands (from `observe`'s visible blocks + remembered chests). */
export interface World {
  table?: boolean;
  furnace?: boolean;
  blastFurnace?: boolean;
  smoker?: boolean;
  water?: boolean;
  chests?: KnownChest[];
}

/** The target cannot be planned (unknown item, a loop); the message goes back to her. */
export class PlanError extends Error {}

const MAX_DEPTH = 16;
const MAX_STEPS = 60;

/** Normalizes a requested item (`"Iron Pickaxe"`, `"minecraft:iron_pickaxe"`, `"planks"`). */
export function normalizeItem(raw: string): string {
  const id = raw.trim().toLowerCase().replace(/^minecraft:/, "").replace(/\s+/g, "_");
  if (id === "planks" || id === "wood_planks") return "#planks";
  if (id === "log" || id === "logs" || id === "wood") return "#logs";
  if (id === "boat" || id === "boats") return "#boats";
  if (id === "bed" || id === "beds") return "#beds";
  if (id === "wool") return "#wool";
  return id;
}

/** Whether the planner knows how to get `item` at all. */
export function knows(item: string): boolean {
  if (item === "water_bucket") return true;
  if (item in RECIPES || item in SMELTING || item in MINED || item in HUNTED) return true;
  return item.endsWith("_planks") && planksOf(item) !== undefined;
}

class Planner {
  readonly steps: Step[] = [];
  readonly #inv: Inventory;
  readonly #world: World;
  readonly #chests: KnownChest[];
  /** Pass 1 totals per produced item; pass 2 makes the whole amount the first time it is needed. */
  readonly #batch: Map<string, number>;
  readonly #made = new Map<string, number>();

  constructor(inv: Inventory, world: World, batch: Map<string, number>) {
    this.#inv = { ...inv };
    this.#world = { ...world };
    this.#chests = (world.chests ?? []).map((c) => ({ ...c, items: { ...c.items } }));
    this.#batch = batch;
  }

  /** Produced amount per step key (for the next pass). */
  totals(): Map<string, number> {
    const out = new Map<string, number>();
    for (const s of this.steps) {
      if (s.kind === "place" || s.kind === "chest_take" || s.kind === "fill_water") continue;
      out.set(s.item, (out.get(s.item) ?? 0) + s.count);
    }
    return out;
  }

  #take(item: string, n: number): number {
    let left = n;
    for (const key of isGroup(item) ? [item, ...members(item)] : [item]) {
      const have = this.#inv[key] ?? 0;
      const used = Math.min(have, left);
      if (used > 0) {
        this.#inv[key] = have - used;
        left -= used;
      }
      if (left === 0) break;
    }
    return n - left;
  }

  #add(item: string, n: number): void {
    this.#inv[item] = (this.#inv[item] ?? 0) + n;
  }

  /** Pulls missing items from remembered opened chests before mining/hunting/crafting. */
  #takeFromChests(item: string, missing: number): number {
    if (!this.#chests.length || missing <= 0) return 0;
    const keys = isGroup(item) ? members(item) : [item];
    let left = missing;
    for (const chest of this.#chests) {
      for (const k of keys) {
        if (left <= 0) break;
        const avail = chest.items[k] ?? 0;
        if (avail <= 0) continue;
        const take = Math.min(avail, left);
        chest.items[k] = avail - take;
        left -= take;
        this.steps.push({ kind: "chest_take", item: k, count: take, chest: { x: chest.x, y: chest.y, z: chest.z } });
        this.#add(k, take);
      }
      if (left <= 0) break;
    }
    return missing - left;
  }

  /** Makes sure `n` of `item` exist, then uses them up (`consume`) or keeps them (tools). */
  need(item: string, n: number, consume: boolean, depth: number): void {
    if (depth > MAX_DEPTH || this.steps.length > MAX_STEPS) {
      throw new PlanError(`${zh(item)}的步驟太多了,先自己做一部分`);
    }
    const have = countOf(this.#inv, item);
    if (have < n) {
      this.#takeFromChests(item, n - have);
      const afterChest = countOf(this.#inv, item);
      if (afterChest < n) this.#produce(item, n - afterChest, depth + 1);
    }
    if (consume) this.#take(item, n);
  }

  #tool(tier: Tier, depth: number): void {
    if (tier === 0 || pickaxeTier(this.#inv) >= tier) return;
    this.need(TIER_PICKAXE[tier as Exclude<Tier, 0>], 1, false, depth);
  }

  #station(kind: "crafting_table" | "furnace", depth: number): void {
    const key = kind === "crafting_table" ? "table" : "furnace";
    if (this.#world[key]) return;
    this.need(kind, 1, true, depth);
    this.steps.push({ kind: "place", item: kind });
    this.#world[key] = true;
  }

  #smeltStation(item: string, depth: number): void {
    if (ORE_SMELTS.has(item) && this.#world.blastFurnace) return;
    if (FOOD_SMELTS.has(item) && this.#world.smoker) return;
    this.#station("furnace", depth);
  }

  #fuel(items: number, depth: number): void {
    let left = items;
    for (const [fuel, burns] of FUELS) {
      if (left <= 0) return;
      const units = Math.min(countOf(this.#inv, fuel), Math.ceil(left / burns));
      this.#take(fuel, units);
      left -= units * burns;
    }
    if (left > 0) this.need("#planks", Math.ceil(left / 1.5), true, depth);
  }

  /** How many to make: the missing amount, or the whole batch the first time. */
  #amount(item: string, missing: number): number {
    const batch = this.#batch.get(item) ?? 0;
    const made = this.#made.get(item) ?? 0;
    const amount = Math.max(missing, batch - made);
    this.#made.set(item, made + amount);
    return amount;
  }

  /** For `#beds`, picks a wool color she already has >= 3 of, else `white_wool` (from sheep). */
  #bedWoolNeed(times: number): string {
    const needCount = 3 * times;
    for (const w of members("#wool")) {
      if ((this.#inv[w] ?? 0) >= needCount) return w;
    }
    for (const c of this.#chests) {
      for (const w of members("#wool")) {
        if ((this.#inv[w] ?? 0) + (c.items[w] ?? 0) >= needCount) return w;
      }
    }
    return "white_wool";
  }

  #produce(item: string, missing: number, depth: number): void {
    if (item === "water_bucket") {
      const amount = this.#amount(item, missing);
      this.need("bucket", amount, true, depth);
      for (let i = 0; i < amount; i++) this.steps.push({ kind: "fill_water", item: "water_bucket" });
      this.#add("water_bucket", amount);
      return;
    }

    // `oak_planks` asked for by name: any planks recipe, crafted as that wood when logs allow.
    const key = item.endsWith("_planks") && planksOf(item) ? "#planks" : item;
    const r = RECIPES[key];
    if (r) {
      if (r.table) this.#station("crafting_table", depth);
      const times = Math.ceil(this.#amount(key, missing) / r.yield);
      const needs =
        key === "#beds"
          ? ([[this.#bedWoolNeed(times), 3], ["#planks", 3]] as Array<[string, number]>)
          : r.needs;
      for (const [ing, qty] of needs) this.need(ing, qty * times, true, depth);
      this.steps.push({ kind: "craft", item, count: times * r.yield, table: r.table });
      this.#add(item, times * r.yield);
      return;
    }
    const input = SMELTING[item];
    if (input) {
      const amount = this.#amount(item, missing);
      this.#smeltStation(item, depth);
      this.need(input, amount, true, depth);
      this.#fuel(amount, depth);
      this.steps.push({ kind: "smelt", item, input, count: amount });
      this.#add(item, amount);
      return;
    }
    const blocks = MINED[item];
    if (blocks) {
      const amount = this.#amount(item, missing);
      this.#tool(Math.max(...blocks.map(requiredTier)) as Tier, depth);
      const step: Extract<Step, { kind: "mine" }> = { kind: "mine", item, blocks, count: amount };
      const yHint = preferredY(item);
      if (yHint !== undefined) {
        Object.defineProperty(step, "preferredY", { value: yHint, enumerable: false, configurable: true });
      }
      this.steps.push(step);
      this.#add(item, amount);
      return;
    }
    const entity = HUNTED[item];
    if (entity) {
      const amount = this.#amount(item, missing);
      this.steps.push({ kind: "hunt", item, entity, count: amount });
      this.#add(item, amount);
      return;
    }
    throw new PlanError(`不知道怎麼取得${zh(item)}(只會砍樹、挖礦、打獵、裝水、合成和用熔爐燒的東西)`);
  }
}

/**
 * The steps from `inv` to `count` of `target`; empty when she already has them. Throws
 * `PlanError`.
 */
export function plan(target: string, count: number, inv: Inventory, world: World = {}): Step[] {
  const item = normalizeItem(target);
  if (countOf(inv, item) >= count) return [];
  const first = new Planner(inv, world, new Map());
  first.need(item, count, false, 0);
  const second = new Planner(inv, world, first.totals());
  second.need(item, count, false, 0);
  return second.steps;
}

const GROUP_NAMES: Record<string, string> = {
  "#logs": "原木",
  "#planks": "木材",
  "#stone": "鵝卵石",
  "#coal": "煤炭",
  "#boats": "木船",
  "#wool": "羊毛",
  "#beds": "床",
};

/** Display name of an item or group. */
export function itemName(item: string): string {
  return GROUP_NAMES[item] ?? zh(item);
}

/** `做工作台`-style text of one step. */
export function describeStep(step: Step): string {
  const name = itemName;
  switch (step.kind) {
    case "mine":
      return `${step.item === "#logs" ? "砍" : "挖"}${name(step.item)}×${step.count}`;
    case "craft":
      return `做${name(step.item)}×${step.count}`;
    case "smelt":
      return `用熔爐燒${name(step.item)}×${step.count}`;
    case "place":
      return `放下${zh(step.item)}`;
    case "hunt":
      return `打獵${zh(step.entity)}拿${name(step.item)}×${step.count}`;
    case "fill_water":
      return "用鐵桶裝水";
    case "chest_take":
      return `從箱子拿${name(step.item)}×${step.count}`;
  }
}
