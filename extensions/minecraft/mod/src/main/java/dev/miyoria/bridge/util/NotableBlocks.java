package dev.miyoria.bridge.util;

import java.util.Set;

/** Which blocks are worth reporting to the LLM ("what is around me"). Ids are normalized. */
public final class NotableBlocks {
    private NotableBlocks() {}

    private static final Set<String> EXACT = Set.of(
            "ancient_debris", "nether_quartz_ore", "nether_gold_ore",
            "chest", "trapped_chest", "ender_chest", "barrel",
            "crafting_table", "furnace", "blast_furnace", "smoker", "anvil", "enchanting_table",
            "brewing_stand", "smithing_table", "loom", "stonecutter", "grindstone",
            "spawner", "trial_spawner", "vault",
            "nether_portal", "end_portal_frame", "end_portal",
            "lava", "water_cauldron", "bell", "beacon", "respawn_anchor", "lodestone",
            "sugar_cane", "melon", "pumpkin", "wheat", "carrots", "potatoes", "beetroots", "nether_wart",
            "sweet_berry_bush", "cocoa");

    public static boolean isNotable(String normalizedId) {
        if (normalizedId == null) return false;
        if (EXACT.contains(normalizedId)) return true;
        return normalizedId.endsWith("_ore")
                || normalizedId.endsWith("_bed")
                || normalizedId.endsWith("shulker_box");
    }

    /** Lower = more interesting; used to order the (capped) result list. */
    public static int priority(String id) {
        if (id.equals("diamond_ore") || id.equals("deepslate_diamond_ore") || id.equals("ancient_debris")) return 0;
        if (id.endsWith("_ore")) return 1;
        if (id.equals("spawner") || id.equals("trial_spawner") || id.equals("vault")) return 1;
        if (id.equals("lava")) return 2;
        if (id.contains("chest") || id.equals("barrel") || id.endsWith("shulker_box")) return 2;
        if (id.endsWith("_portal") || id.startsWith("end_portal")) return 2;
        return 3;
    }
}
