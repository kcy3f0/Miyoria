package dev.miyoria.bridge.reflex;

import dev.miyoria.bridge.util.Ids;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Pure-Java inventory analyzer across all 36 main slots ({@code 0..35}), armor slots, and offhand.
 * Contains zero Minecraft types so it can be unit-tested directly without the MC runtime.
 */
public final class InventoryLogic {
    public static final int MAIN_SLOTS = 36;
    public static final int HOTBAR_SLOTS = 9;
    public static final int TIDY_FREE_SLOT_THRESHOLD = 2;

    public enum ArmorSlot {
        HEAD(5),
        CHEST(6),
        LEGS(7),
        FEET(8);

        /** Corresponding slot index in {@code PlayerScreenHandler}. */
        public final int screenSlot;

        ArmorSlot(int screenSlot) {
            this.screenSlot = screenSlot;
        }
    }

    public record SlotItem(int slot, String id, int count, Integer durabilityPct, Integer nutrition) {
        public SlotItem {
            id = normalizeId(id);
        }

        public SlotItem(int slot, String id, int count) {
            this(slot, id, count, null, null);
        }

        public SlotItem(int slot, String id, int count, Integer durabilityPct) {
            this(slot, id, count, durabilityPct, null);
        }

        public boolean isEmpty() {
            return id == null || id.isEmpty() || count <= 0;
        }
    }

    public record Equipped(SlotItem head, SlotItem chest, SlotItem legs, SlotItem feet, SlotItem offhand) {
        public static final Equipped EMPTY = new Equipped(null, null, null, null, null);
    }

    public record ArmorUpgrade(ArmorSlot piece, int sourceSlot, String item, int currentTier, int upgradeTier) {}

    public record ScanResult(
            int bestWeaponSlot,
            double bestWeaponScore,
            int bowSlot,
            boolean bowInOffhand,
            int arrowCount,
            int bestGoodFoodSlot,
            int bestAnyFoodSlot,
            List<ArmorUpgrade> armorUpgrades,
            int shieldSlot,
            boolean offhandHasShield,
            boolean shouldEquipShield,
            int torchSlot,
            int torchCount,
            int waterBucketSlot,
            int emptyBucketSlot,
            int buildingBlockSlot,
            int buildingBlockCount,
            int freeSlots,
            List<Integer> dropCandidates
    ) {
        public boolean bowReady() {
            return (bowSlot >= 0 || bowInOffhand) && arrowCount > 0;
        }

        public int bestFoodSlot(boolean starving) {
            if (bestGoodFoodSlot >= 0) return bestGoodFoodSlot;
            return starving ? bestAnyFoodSlot : -1;
        }

        public boolean hasEdibleFood(boolean starving) {
            return bestFoodSlot(starving) >= 0;
        }

        public boolean hasTorch() {
            return torchSlot >= 0 && torchCount > 0;
        }

        public boolean hasWaterBucket() {
            return waterBucketSlot >= 0;
        }
    }

    /** Foods with negative status effects; avoided unless starving. */
    public static final Set<String> BAD_FOOD = Set.of(
            "rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chorus_fruit", "suspicious_stew");

    private static final Map<String, Integer> VANILLA_FOOD_NUTRITION = Map.ofEntries(
            Map.entry("cooked_beef", 8),
            Map.entry("cooked_porkchop", 8),
            Map.entry("pumpkin_pie", 8),
            Map.entry("rabbit_stew", 10),
            Map.entry("cooked_mutton", 6),
            Map.entry("cooked_salmon", 6),
            Map.entry("cooked_chicken", 6),
            Map.entry("golden_carrot", 6),
            Map.entry("mushroom_stew", 6),
            Map.entry("beetroot_soup", 6),
            Map.entry("honey_bottle", 6),
            Map.entry("baked_potato", 5),
            Map.entry("bread", 5),
            Map.entry("cooked_cod", 5),
            Map.entry("cooked_rabbit", 5),
            Map.entry("apple", 4),
            Map.entry("golden_apple", 4),
            Map.entry("enchanted_golden_apple", 4),
            Map.entry("carrot", 3),
            Map.entry("beef", 3),
            Map.entry("porkchop", 3),
            Map.entry("rabbit", 3),
            Map.entry("melon_slice", 2),
            Map.entry("sweet_berries", 2),
            Map.entry("glow_berries", 2),
            Map.entry("cookie", 2),
            Map.entry("chicken", 2),
            Map.entry("mutton", 2),
            Map.entry("cod", 2),
            Map.entry("salmon", 2),
            Map.entry("tropical_fish", 1),
            Map.entry("dried_kelp", 1),
            Map.entry("potato", 1),
            Map.entry("beetroot", 1),
            Map.entry("rotten_flesh", 4),
            Map.entry("spider_eye", 2),
            Map.entry("poisonous_potato", 2),
            Map.entry("pufferfish", 1),
            Map.entry("chorus_fruit", 4),
            Map.entry("suspicious_stew", 6)
    );

    private static final Set<String> ARROW_ITEMS = Set.of("arrow", "spectral_arrow", "tipped_arrow");

    private static final Set<String> PILLAR_BLOCKS = Set.of(
            "cobblestone", "cobbled_deepslate", "dirt", "coarse_dirt", "netherrack", "stone",
            "andesite", "diorite", "granite", "tuff", "deepslate", "basalt", "blackstone",
            "bricks", "stone_bricks", "mud_bricks", "sandstone", "red_sandstone", "terracotta");

    private static final Set<String> EXCESS_JUNK_STACKS = Set.of("dirt", "coarse_dirt", "rooted_dirt", "gravel");

    private InventoryLogic() {}

    public static ScanResult scan(List<SlotItem> mainSlots, Equipped equipped) {
        return scan(mainSlots, equipped, 20f);
    }

    public static ScanResult scan(List<SlotItem> mainSlots, Equipped equipped, float health) {
        Equipped eq = equipped == null ? Equipped.EMPTY : equipped;
        Map<Integer, SlotItem> bySlot = new HashMap<>();
        if (mainSlots != null) {
            for (SlotItem item : mainSlots) {
                if (item != null && !item.isEmpty() && item.slot() >= 0 && item.slot() < MAIN_SLOTS) {
                    bySlot.put(item.slot(), item);
                }
            }
        }

        int bestWeaponSlot = -1;
        double bestWeaponScore = 0.0;

        int bowSlot = -1;
        double bestBowScore = -1.0;
        boolean bowInOffhand = eq.offhand() != null && !eq.offhand().isEmpty() && "bow".equals(eq.offhand().id());
        int arrowCount = 0;

        int bestGoodFoodSlot = -1;
        double bestGoodFoodScore = Double.NEGATIVE_INFINITY;
        int bestAnyFoodSlot = -1;
        double bestAnyFoodScore = Double.NEGATIVE_INFINITY;

        int shieldSlot = -1;
        double bestShieldScore = -1.0;
        boolean offhandHasShield = eq.offhand() != null && !eq.offhand().isEmpty() && "shield".equals(eq.offhand().id());

        int torchSlot = -1;
        double bestTorchScore = -1.0;
        int torchCount = 0;

        int waterBucketSlot = -1;
        int emptyBucketSlot = -1;

        int buildingBlockSlot = -1;
        double bestBlockScore = -1.0;
        int buildingBlockCount = 0;

        Map<ArmorSlot, Integer> currentArmorTier = new EnumMap<>(ArmorSlot.class);
        Map<ArmorSlot, Integer> currentArmorDur = new EnumMap<>(ArmorSlot.class);
        initCurrentArmor(ArmorSlot.HEAD, eq.head(), currentArmorTier, currentArmorDur);
        initCurrentArmor(ArmorSlot.CHEST, eq.chest(), currentArmorTier, currentArmorDur);
        initCurrentArmor(ArmorSlot.LEGS, eq.legs(), currentArmorTier, currentArmorDur);
        initCurrentArmor(ArmorSlot.FEET, eq.feet(), currentArmorTier, currentArmorDur);

        Map<ArmorSlot, SlotItem> bestArmorCandidate = new EnumMap<>(ArmorSlot.class);
        Map<ArmorSlot, Integer> bestArmorTier = new EnumMap<>(ArmorSlot.class);
        Map<ArmorSlot, Integer> bestArmorDur = new EnumMap<>(ArmorSlot.class);

        if (eq.offhand() != null && !eq.offhand().isEmpty() && ARROW_ITEMS.contains(eq.offhand().id())) {
            arrowCount += eq.offhand().count();
        }

        for (int slot = 0; slot < MAIN_SLOTS; slot++) {
            SlotItem s = bySlot.get(slot);
            if (s == null) continue;
            String id = s.id();
            boolean inHotbar = slot < HOTBAR_SLOTS;
            int dur = s.durabilityPct() == null ? 100 : Math.max(0, Math.min(100, s.durabilityPct()));

            // 1. Melee weapon
            double wScore = weaponScore(id, s.durabilityPct(), inHotbar);
            if (wScore > bestWeaponScore) {
                bestWeaponScore = wScore;
                bestWeaponSlot = slot;
            }

            // 2. Bow & arrows
            if ("bow".equals(id)) {
                double bScore = dur + (inHotbar ? 0.5 : 0.0);
                if (bScore > bestBowScore) {
                    bestBowScore = bScore;
                    bowSlot = slot;
                }
            }
            if (ARROW_ITEMS.contains(id)) {
                arrowCount += s.count();
            }

            // 3. Food
            int nutrition = foodNutrition(s);
            if (nutrition > 0) {
                boolean bad = BAD_FOOD.contains(id);
                double fScore = foodScore(id, nutrition, health, bad, inHotbar);
                if (!bad && fScore > bestGoodFoodScore) {
                    bestGoodFoodScore = fScore;
                    bestGoodFoodSlot = slot;
                }
                if (fScore > bestAnyFoodScore) {
                    bestAnyFoodScore = fScore;
                    bestAnyFoodSlot = slot;
                }
            }

            // 4. Armor upgrades
            ArmorSlot piece = armorPiece(id);
            if (piece != null) {
                int tier = armorTier(id);
                int curTier = currentArmorTier.getOrDefault(piece, 0);
                int curDur = currentArmorDur.getOrDefault(piece, 0);
                if (tier > curTier || (tier == curTier && dur > curDur + 20 && curTier > 0 && curDur <= 10)) {
                    int prevBestTier = bestArmorTier.getOrDefault(piece, -1);
                    int prevBestDur = bestArmorDur.getOrDefault(piece, -1);
                    if (tier > prevBestTier || (tier == prevBestTier && dur > prevBestDur)) {
                        bestArmorTier.put(piece, tier);
                        bestArmorDur.put(piece, dur);
                        bestArmorCandidate.put(piece, s);
                    }
                }
            }

            // 5. Shield
            if ("shield".equals(id)) {
                double sScore = dur + (inHotbar ? 0.5 : 0.0);
                if (sScore > bestShieldScore) {
                    bestShieldScore = sScore;
                    shieldSlot = slot;
                }
            }

            // 6. Torches
            if ("torch".equals(id) || "soul_torch".equals(id)) {
                torchCount += s.count();
                double tScore = ("torch".equals(id) ? 10.0 : 5.0) + (inHotbar ? 2.0 : 0.0) + Math.min(1.0, s.count() / 64.0);
                if (tScore > bestTorchScore) {
                    bestTorchScore = tScore;
                    torchSlot = slot;
                }
            }

            // 7. Buckets
            if ("water_bucket".equals(id)) {
                if (waterBucketSlot < 0 || (inHotbar && waterBucketSlot >= HOTBAR_SLOTS)) {
                    waterBucketSlot = slot;
                }
            } else if ("bucket".equals(id)) {
                if (emptyBucketSlot < 0 || (inHotbar && emptyBucketSlot >= HOTBAR_SLOTS)) {
                    emptyBucketSlot = slot;
                }
            }

            // 8. Safe solid building blocks for pillar escape
            if (isPillarBlock(id)) {
                buildingBlockCount += s.count();
                double blkScore = (inHotbar ? 100.0 : 0.0) + s.count();
                if (blkScore > bestBlockScore) {
                    bestBlockScore = blkScore;
                    buildingBlockSlot = slot;
                }
            }
        }

        List<ArmorUpgrade> armorUpgrades = new ArrayList<>();
        for (ArmorSlot piece : ArmorSlot.values()) {
            SlotItem cand = bestArmorCandidate.get(piece);
            if (cand != null) {
                int curTier = currentArmorTier.getOrDefault(piece, 0);
                int upTier = bestArmorTier.get(piece);
                if (upTier > curTier) {
                    armorUpgrades.add(new ArmorUpgrade(piece, cand.slot(), cand.id(), curTier, upTier));
                }
            }
        }

        boolean offhandIsTotem = eq.offhand() != null && !eq.offhand().isEmpty()
                && "totem_of_undying".equals(eq.offhand().id());
        boolean shouldEquipShield = !offhandHasShield && shieldSlot >= 0 && !offhandIsTotem;

        int freeSlots = Math.max(0, MAIN_SLOTS - bySlot.size());
        List<Integer> dropCandidates = freeSlots <= TIDY_FREE_SLOT_THRESHOLD
                ? findDropCandidates(bySlot, bestGoodFoodSlot >= 0)
                : List.of();

        return new ScanResult(
                bestWeaponSlot,
                bestWeaponScore,
                bowSlot,
                bowInOffhand,
                arrowCount,
                bestGoodFoodSlot,
                bestAnyFoodSlot,
                List.copyOf(armorUpgrades),
                shieldSlot,
                offhandHasShield,
                shouldEquipShield,
                torchSlot,
                torchCount,
                waterBucketSlot,
                emptyBucketSlot,
                buildingBlockSlot,
                buildingBlockCount,
                freeSlots,
                dropCandidates
        );
    }

    /**
     * Picks a hotbar slot ({@code 0..8}) to receive an item swapped from storage ({@code 9..35}).
     * Prefers empty slots, then non-essential items, falling back to slot 8.
     */
    public static int preferredHotbarSwapTarget(List<SlotItem> mainSlots) {
        SlotItem[] hotbar = new SlotItem[HOTBAR_SLOTS];
        if (mainSlots != null) {
            for (SlotItem s : mainSlots) {
                if (s != null && !s.isEmpty() && s.slot() >= 0 && s.slot() < HOTBAR_SLOTS) {
                    hotbar[s.slot()] = s;
                }
            }
        }
        // Prefer empty slots from slot 8 down (or 0..8: keep left hotbar tools undisturbed, empty slot 8..0)
        for (int i = 0; i < HOTBAR_SLOTS; i++) {
            if (hotbar[i] == null) return i;
        }
        // Avoid overwriting weapons, pickaxes/tools, bow, water_bucket, food, torch
        for (int i = HOTBAR_SLOTS - 1; i >= 0; i--) {
            String id = hotbar[i].id();
            if (!isProtectedHotbarItem(id)) return i;
        }
        return HOTBAR_SLOTS - 1;
    }

    /** Converts main inventory slot {@code 0..35} to {@code PlayerScreenHandler} slot id. */
    public static int toPlayerScreenSlot(int mainSlot) {
        return mainSlot < HOTBAR_SLOTS ? 36 + mainSlot : mainSlot;
    }

    public static double weaponScore(String id, Integer durabilityPct, boolean inHotbar) {
        if (id == null) return 0.0;
        double base = switch (id) {
            case "netherite_sword" -> 100.0;
            case "diamond_sword" -> 90.0;
            case "iron_sword" -> 80.0;
            case "trident" -> 78.0;
            case "netherite_axe" -> 76.0;
            case "diamond_axe" -> 74.0;
            case "mace" -> 72.0;
            case "stone_sword" -> 70.0;
            case "iron_axe" -> 68.0;
            case "golden_sword" -> 62.0;
            case "wooden_sword" -> 60.0;
            case "stone_axe" -> 58.0;
            case "golden_axe" -> 52.0;
            case "wooden_axe" -> 50.0;
            default -> 0.0;
        };
        if (base <= 0.0) return 0.0;
        int dur = durabilityPct == null ? 100 : Math.max(0, Math.min(100, durabilityPct));
        double durBonus = (dur / 100.0) * 5.0;
        double lowDurPenalty = dur <= 5 ? -12.0 : 0.0;
        return base + durBonus + lowDurPenalty + (inHotbar ? 0.1 : 0.0);
    }

    public static int armorTier(String id) {
        if (id == null) return 0;
        if ("elytra".equals(id)) return 100;
        if ("turtle_helmet".equals(id)) return 35;
        if (id.startsWith("netherite_")) return 60;
        if (id.startsWith("diamond_")) return 50;
        if (id.startsWith("iron_")) return 40;
        if (id.startsWith("chainmail_")) return 30;
        if (id.startsWith("golden_")) return 20;
        if (id.startsWith("leather_")) return 10;
        return 0;
    }

    public static ArmorSlot armorPiece(String id) {
        if (id == null) return null;
        if (id.endsWith("_helmet") || "turtle_helmet".equals(id)) return ArmorSlot.HEAD;
        if (id.endsWith("_chestplate")) return ArmorSlot.CHEST;
        if (id.endsWith("_leggings")) return ArmorSlot.LEGS;
        if (id.endsWith("_boots")) return ArmorSlot.FEET;
        return null;
    }

    public static boolean isPillarBlock(String id) {
        if (id == null) return false;
        return PILLAR_BLOCKS.contains(id) || id.endsWith("_planks");
    }

    private static void initCurrentArmor(ArmorSlot piece, SlotItem item,
                                         Map<ArmorSlot, Integer> tiers, Map<ArmorSlot, Integer> durs) {
        if (item == null || item.isEmpty()) {
            tiers.put(piece, 0);
            durs.put(piece, 0);
            return;
        }
        tiers.put(piece, armorTier(item.id()));
        durs.put(piece, item.durabilityPct() == null ? 100 : item.durabilityPct());
    }

    private static int foodNutrition(SlotItem s) {
        if (s.nutrition() != null && s.nutrition() > 0) return s.nutrition();
        return VANILLA_FOOD_NUTRITION.getOrDefault(s.id(), 0);
    }

    private static double foodScore(String id, int nutrition, float health, boolean bad, boolean inHotbar) {
        if (bad) {
            return nutrition - 100.0 + (inHotbar ? 0.1 : 0.0);
        }
        double score = nutrition * 10.0;
        // Save golden apples for emergencies or when no ordinary food is available
        if (("golden_apple".equals(id) || "enchanted_golden_apple".equals(id)) && health > 8f) {
            score -= 35.0;
        }
        if (inHotbar) score += 0.1;
        return score;
    }

    private static boolean isProtectedHotbarItem(String id) {
        if (id == null) return false;
        return weaponScore(id, 100, false) > 0
                || id.endsWith("_pickaxe") || id.endsWith("_shovel") || id.endsWith("_hoe")
                || "bow".equals(id) || "crossbow".equals(id) || "shield".equals(id)
                || "water_bucket".equals(id) || "torch".equals(id) || "soul_torch".equals(id)
                || VANILLA_FOOD_NUTRITION.containsKey(id);
    }

    private static List<Integer> findDropCandidates(Map<Integer, SlotItem> bySlot, boolean hasGoodFood) {
        List<Integer> drops = new ArrayList<>();
        // Track stacks of items where we conservatively keep at least the largest stack
        Map<String, List<SlotItem>> stacksByGroup = new HashMap<>();
        for (int slot = 0; slot < MAIN_SLOTS; slot++) {
            SlotItem s = bySlot.get(slot);
            if (s == null) continue;
            String id = s.id();
            if (isNeverDrop(id)) continue;
            if ("poisonous_potato".equals(id)) {
                drops.add(slot);
            } else if ("rotten_flesh".equals(id)) {
                if (hasGoodFood) {
                    drops.add(slot);
                } else {
                    stacksByGroup.computeIfAbsent("rotten_flesh", k -> new ArrayList<>()).add(s);
                }
            } else if (EXCESS_JUNK_STACKS.contains(id)) {
                String group = "gravel".equals(id) ? "gravel" : "dirt";
                stacksByGroup.computeIfAbsent(group, k -> new ArrayList<>()).add(s);
            }
        }
        for (List<SlotItem> group : stacksByGroup.values()) {
            if (group.size() <= 1) continue;
            // Keep the largest stack (tie-break: hotbar/lowest slot), drop excess smaller stacks
            group.sort(Comparator.comparingInt(SlotItem::count).reversed()
                    .thenComparingInt(SlotItem::slot));
            for (int i = 1; i < group.size(); i++) {
                drops.add(group.get(i).slot());
            }
        }
        drops.sort(Integer::compareTo);
        return List.copyOf(drops);
    }

    private static boolean isNeverDrop(String id) {
        if (id == null || id.isEmpty()) return true;
        if (weaponScore(id, 100, false) > 0 || armorPiece(id) != null || "elytra".equals(id)) return true;
        if (id.endsWith("_pickaxe") || id.endsWith("_shovel") || id.endsWith("_hoe")) return true;
        if ("bow".equals(id) || "crossbow".equals(id) || "shield".equals(id) || ARROW_ITEMS.contains(id)) return true;
        if (id.contains("bucket") || id.endsWith("_bed")) return true;
        if (id.endsWith("_ore") || id.startsWith("raw_") || "ancient_debris".equals(id)) return true;
        if (id.equals("coal") || id.equals("charcoal") || id.equals("diamond") || id.equals("emerald")
                || id.equals("iron_ingot") || id.equals("gold_ingot") || id.equals("copper_ingot")
                || id.equals("netherite_ingot") || id.equals("netherite_scrap") || id.equals("redstone")
                || id.equals("lapis_lazuli") || id.equals("quartz") || id.equals("amethyst_shard")) return true;
        if (id.endsWith("_log") || id.endsWith("_planks") || id.endsWith("_stem") || "stick".equals(id)) return true;
        if ("torch".equals(id) || "soul_torch".equals(id) || "crafting_table".equals(id)
                || "furnace".equals(id) || "blast_furnace".equals(id) || "smoker".equals(id)
                || "chest".equals(id) || "barrel".equals(id)) return true;
        if (VANILLA_FOOD_NUTRITION.containsKey(id) && !BAD_FOOD.contains(id)) return true;
        return false;
    }

    private static String normalizeId(String raw) {
        if (raw == null) return null;
        return Ids.normalize(raw.trim().toLowerCase(Locale.ROOT));
    }
}
