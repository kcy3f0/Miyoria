// Which pickaxe a block needs before it drops anything (vanilla 1.21.1 `needs_*_tool` and
// `mineable/pickaxe` tags, for the blocks she meets in survival). The one table behind both the
// `mine` refusal and the "what can I mine" line of the summary.

import { zh } from "./names.js";

/** 0 = no pickaxe, 1 = wooden / golden, 2 = stone, 3 = iron, 4 = diamond / netherite. */
export type Tier = 0 | 1 | 2 | 3 | 4;

const PICKAXES: Record<string, Tier> = {
  wooden_pickaxe: 1,
  golden_pickaxe: 1,
  stone_pickaxe: 2,
  iron_pickaxe: 3,
  diamond_pickaxe: 4,
  netherite_pickaxe: 4,
};

/** The pickaxe to make for each tier (what the refusal tells her to craft). */
const TIER_PICKAXE: Record<Exclude<Tier, 0>, string> = {
  1: "wooden_pickaxe",
  2: "stone_pickaxe",
  3: "iron_pickaxe",
  4: "diamond_pickaxe",
};

const STONE_TIER = new Set([
  "iron_ore",
  "deepslate_iron_ore",
  "copper_ore",
  "deepslate_copper_ore",
  "lapis_ore",
  "deepslate_lapis_ore",
  "raw_iron_block",
  "raw_copper_block",
  "iron_block",
  "lapis_block",
  "copper_block",
]);
const IRON_TIER = new Set([
  "gold_ore",
  "deepslate_gold_ore",
  "diamond_ore",
  "deepslate_diamond_ore",
  "emerald_ore",
  "deepslate_emerald_ore",
  "redstone_ore",
  "deepslate_redstone_ore",
  "raw_gold_block",
  "gold_block",
  "diamond_block",
  "emerald_block",
]);
const DIAMOND_TIER = new Set(["obsidian", "crying_obsidian", "ancient_debris", "respawn_anchor", "netherite_block"]);
/** Stone-like blocks that drop nothing without at least a wooden pickaxe. */
const ANY_PICKAXE = new Set([
  "stone",
  "cobblestone",
  "mossy_cobblestone",
  "deepslate",
  "cobbled_deepslate",
  "andesite",
  "diorite",
  "granite",
  "tuff",
  "calcite",
  "dripstone_block",
  "pointed_dripstone",
  "sandstone",
  "red_sandstone",
  "smooth_stone",
  "netherrack",
  "basalt",
  "smooth_basalt",
  "blackstone",
  "end_stone",
  "furnace",
  "blast_furnace",
  "smoker",
  "bricks",
  "stone_bricks",
  "terracotta",
  "amethyst_block",
  "magma_block",
  "nether_bricks",
  "prismarine",
]);

/** Pickaxe tier a block needs to drop something; 0 = mineable by hand (logs, dirt, sand...). */
export function requiredTier(block: string): Tier {
  if (DIAMOND_TIER.has(block)) return 4;
  if (IRON_TIER.has(block)) return 3;
  if (STONE_TIER.has(block)) return 2;
  if (ANY_PICKAXE.has(block)) return 1;
  // every other ore (coal, nether gold, nether quartz) and coloured stone variants
  if (block.endsWith("_ore") || block.endsWith("_terracotta") || block.endsWith("_concrete")) return 1;
  return 0;
}

/** Best pickaxe tier in an inventory (`item id → count`). */
export function pickaxeTier(inventory: Record<string, number> | undefined): Tier {
  let best: Tier = 0;
  for (const [item, count] of Object.entries(inventory ?? {})) {
    const tier = PICKAXES[item];
    if (tier !== undefined && count > 0 && tier > best) best = tier;
  }
  return best;
}

/**
 * Why she cannot get anything out of `block` with what she has, or `null` when she can. In
 * Traditional Chinese for the model: the block, the pickaxe it needs and the next thing to make.
 */
export function harvestProblem(block: string, inventory: Record<string, number> | undefined): string | null {
  const need = requiredTier(block);
  const have = pickaxeTier(inventory);
  if (need <= have || need === 0) return null;
  const tool = TIER_PICKAXE[need as Exclude<Tier, 0>];
  const now = have === 0 ? "你現在沒有鎬" : `你最好的是${zh(TIER_PICKAXE[have as Exclude<Tier, 0>])}`;
  const next = have === 0 ? "先空手打原木、做木鎬" : `先做${zh(TIER_PICKAXE[(have + 1) as Exclude<Tier, 0>])}`;
  return `${zh(block)}要${zh(tool)}以上才挖得到東西(${now}),現在挖只會白費時間。${next}。`;
}

const TIER_LINE: Record<Tier, string> = {
  0: "沒有鎬:只能挖原木、泥土、沙子這類;石頭和礦石要先做木鎬",
  1: "最好的鎬:木鎬(能挖石頭、煤礦;鐵、銅、青金石要石鎬)",
  2: "最好的鎬:石鎬(能挖鐵、銅、青金石;金、鑽石、紅石、綠寶石要鐵鎬)",
  3: "最好的鎬:鐵鎬(能挖鑽石、金、紅石、綠寶石;黑曜石要鑽石鎬)",
  4: "最好的鎬:鑽石鎬(黑曜石也挖得動)",
};

/** One summary line: her best pickaxe and what it can and cannot mine. */
export function toolLine(inventory: Record<string, number> | undefined): string {
  return TIER_LINE[pickaxeTier(inventory)];
}
