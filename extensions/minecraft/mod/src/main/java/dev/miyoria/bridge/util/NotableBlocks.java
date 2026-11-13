package dev.miyoria.bridge.util;

import java.util.Set;

/**
 * Which blocks are worth reporting to the LLM ("what is around me"). Ids are normalized. Besides
 * ores and workstations this includes the early-game resources (logs, stone, sand, gravel, clay):
 * the next survival step depends on whether she can see a tree or bare stone.
 */
public final class NotableBlocks {
    private NotableBlocks() {}

    private static final Set<String> EXACT = Set.of(
            "ancient_debris", "nether_quartz_ore", "nether_gold_ore",
            "chest", "trapped_chest", "ender_chest", "barrel",
            "crafting_table", "furnace", "blast_furnace", "smoker", "anvil", "enchanting_table",
            "brewing_stand", "smithing_table", "loom", "stonecutter", "grindstone",
            "spawner", "trial_spawner", "vault",
            "nether_portal", "end_portal_frame", "end_portal",
            "obsidian", "crying_obsidian",
            "water", "lava", "water_cauldron", "bell", "beacon", "respawn_anchor", "lodestone",
            "sugar_cane", "hay_block", "melon", "pumpkin", "wheat", "carrots", "potatoes", "beetroots", "nether_wart",
            "sweet_berry_bush", "cocoa",
            "stone", "sand", "gravel", "clay");

    public static boolean isNotable(String normalizedId) {
        if (normalizedId == null) return false;
        if (EXACT.contains(normalizedId)) return true;
        return normalizedId.endsWith("_ore")
                || normalizedId.endsWith("_log")
                || normalizedId.endsWith("_stem")
                || normalizedId.endsWith("_bed")
                || normalizedId.endsWith("shulker_box");
    }

    /** Lower = more interesting; used to order the (capped) result list. */
    public static int priority(String id) {
        if (id.equals("diamond_ore") || id.equals("deepslate_diamond_ore") || id.equals("ancient_debris")) return 0;
        if (id.endsWith("_ore")) return 1;
        if (id.endsWith("_log") || id.endsWith("_stem")) return 1;
        if (id.equals("spawner") || id.equals("trial_spawner") || id.equals("vault")) return 1;
        if (id.equals("lava")) return 2;
        if (id.contains("chest") || id.equals("barrel") || id.endsWith("shulker_box")) return 2;
        if (id.endsWith("_portal") || id.startsWith("end_portal")
                || id.equals("obsidian") || id.equals("crying_obsidian")) return 2;
        if (id.endsWith("_bed")) return 2;
        if (id.equals("stone") || id.equals("sand") || id.equals("gravel")
                || id.equals("clay") || id.equals("water")) return 4;
        return 3;
    }
}
