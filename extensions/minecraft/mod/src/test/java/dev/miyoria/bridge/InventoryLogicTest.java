package dev.miyoria.bridge;

import dev.miyoria.bridge.reflex.InventoryLogic;
import dev.miyoria.bridge.reflex.InventoryLogic.ArmorSlot;
import dev.miyoria.bridge.reflex.InventoryLogic.ArmorUpgrade;
import dev.miyoria.bridge.reflex.InventoryLogic.Equipped;
import dev.miyoria.bridge.reflex.InventoryLogic.ScanResult;
import dev.miyoria.bridge.reflex.InventoryLogic.SlotItem;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class InventoryLogicTest {

    @Test
    void scansFull36SlotsAndRanksWeaponsWithDurability() {
        List<SlotItem> slots = List.of(
                new SlotItem(0, "minecraft:wooden_sword", 1, 100),
                new SlotItem(18, "minecraft:iron_sword", 1, 90),
                new SlotItem(27, "minecraft:diamond_sword", 1, 80)
        );
        ScanResult res = InventoryLogic.scan(slots, Equipped.EMPTY);
        assertEquals(27, res.bestWeaponSlot());

        // Almost-broken diamond sword (2% durability) loses to healthy iron sword
        List<SlotItem> lowDur = List.of(
                new SlotItem(0, "diamond_sword", 1, 2),
                new SlotItem(25, "iron_sword", 1, 95)
        );
        assertEquals(25, InventoryLogic.scan(lowDur, Equipped.EMPTY).bestWeaponSlot());

        // Netherite beats diamond
        List<SlotItem> netherite = List.of(
                new SlotItem(1, "diamond_sword", 1, 100),
                new SlotItem(35, "netherite_sword", 1, 100)
        );
        assertEquals(35, InventoryLogic.scan(netherite, Equipped.EMPTY).bestWeaponSlot());
    }

    @Test
    void bowReadinessRequiresArrowsAcrossMainOrOffhand() {
        List<SlotItem> noArrows = List.of(new SlotItem(20, "bow", 1, 100));
        ScanResult r1 = InventoryLogic.scan(noArrows, Equipped.EMPTY);
        assertEquals(20, r1.bowSlot());
        assertFalse(r1.bowReady());

        List<SlotItem> withArrows = List.of(
                new SlotItem(20, "bow", 1, 100),
                new SlotItem(34, "spectral_arrow", 12)
        );
        ScanResult r2 = InventoryLogic.scan(withArrows, Equipped.EMPTY);
        assertTrue(r2.bowReady());
        assertEquals(12, r2.arrowCount());

        Equipped offhandBow = new Equipped(null, null, null, null, new SlotItem(-1, "bow", 1, 100));
        ScanResult r3 = InventoryLogic.scan(List.of(new SlotItem(30, "arrow", 5)), offhandBow);
        assertTrue(r3.bowInOffhand());
        assertTrue(r3.bowReady());
    }

    @Test
    void foodAvoidsBadFoodUnlessStarvingAndPrefersOrdinaryFoodWhenHealthy() {
        List<SlotItem> onlyBad = List.of(
                new SlotItem(10, "poisonous_potato", 2),
                new SlotItem(14, "rotten_flesh", 8)
        );
        ScanResult badScan = InventoryLogic.scan(onlyBad, Equipped.EMPTY, 20f);
        assertFalse(badScan.hasEdibleFood(false));
        assertEquals(-1, badScan.bestFoodSlot(false));
        assertTrue(badScan.hasEdibleFood(true));
        assertEquals(14, badScan.bestFoodSlot(true));

        List<SlotItem> goodFood = List.of(
                new SlotItem(2, "golden_apple", 1),
                new SlotItem(19, "bread", 5),
                new SlotItem(31, "cooked_beef", 4)
        );
        ScanResult healthy = InventoryLogic.scan(goodFood, Equipped.EMPTY, 18f);
        assertEquals(31, healthy.bestFoodSlot(false));
    }

    @Test
    void armorUpgradesFollowTierHierarchyAndProtectElytra() {
        List<SlotItem> armor = List.of(
                new SlotItem(10, "leather_helmet", 1),
                new SlotItem(11, "golden_helmet", 1),
                new SlotItem(12, "chainmail_helmet", 1),
                new SlotItem(13, "iron_helmet", 1),
                new SlotItem(14, "diamond_helmet", 1),
                new SlotItem(15, "netherite_helmet", 1),
                new SlotItem(16, "diamond_chestplate", 1),
                new SlotItem(17, "iron_leggings", 1),
                new SlotItem(18, "golden_boots", 1)
        );
        Equipped worn = new Equipped(
                new SlotItem(-1, "diamond_helmet", 1),
                new SlotItem(-1, "elytra", 1),
                null,
                new SlotItem(-1, "leather_boots", 1),
                null
        );
        ScanResult res = InventoryLogic.scan(armor, worn);
        List<ArmorUpgrade> ups = res.armorUpgrades();
        assertTrue(ups.stream().anyMatch(u -> u.piece() == ArmorSlot.HEAD && "netherite_helmet".equals(u.item())));
        assertFalse(ups.stream().anyMatch(u -> u.piece() == ArmorSlot.CHEST), "elytra must not be replaced");
        assertTrue(ups.stream().anyMatch(u -> u.piece() == ArmorSlot.LEGS && "iron_leggings".equals(u.item())));
        assertTrue(ups.stream().anyMatch(u -> u.piece() == ArmorSlot.FEET && "golden_boots".equals(u.item())));

        assertTrue(InventoryLogic.armorTier("netherite_boots") > InventoryLogic.armorTier("diamond_boots"));
        assertTrue(InventoryLogic.armorTier("diamond_boots") > InventoryLogic.armorTier("iron_boots"));
        assertTrue(InventoryLogic.armorTier("iron_boots") > InventoryLogic.armorTier("chainmail_boots"));
        assertTrue(InventoryLogic.armorTier("chainmail_boots") > InventoryLogic.armorTier("golden_boots"));
        assertTrue(InventoryLogic.armorTier("golden_boots") > InventoryLogic.armorTier("leather_boots"));
    }

    @Test
    void shieldEquipRespectsExistingShieldAndTotem() {
        List<SlotItem> withShield = List.of(new SlotItem(29, "shield", 1, 90));
        ScanResult emptyOffhand = InventoryLogic.scan(withShield, Equipped.EMPTY);
        assertEquals(29, emptyOffhand.shieldSlot());
        assertTrue(emptyOffhand.shouldEquipShield());

        Equipped hasTotem = new Equipped(null, null, null, null, new SlotItem(-1, "totem_of_undying", 1));
        assertFalse(InventoryLogic.scan(withShield, hasTotem).shouldEquipShield());

        Equipped hasShield = new Equipped(null, null, null, null, new SlotItem(-1, "shield", 1));
        ScanResult equippedShield = InventoryLogic.scan(withShield, hasShield);
        assertTrue(equippedShield.offhandHasShield());
        assertFalse(equippedShield.shouldEquipShield());
    }

    @Test
    void conservativeDropCandidatesActivateOnlyWhenNearlyFullAndProtectValuables() {
        // Free slots > 2: never drops anything
        List<SlotItem> spacious = List.of(
                new SlotItem(0, "poisonous_potato", 3),
                new SlotItem(1, "rotten_flesh", 10),
                new SlotItem(2, "cooked_beef", 8)
        );
        ScanResult spaciousRes = InventoryLogic.scan(spacious, Equipped.EMPTY);
        assertTrue(spaciousRes.freeSlots() > InventoryLogic.TIDY_FREE_SLOT_THRESHOLD);
        assertTrue(spaciousRes.dropCandidates().isEmpty());

        // Fill 34 of 36 slots (freeSlots == 2) with valuable items + junk
        List<SlotItem> full = new ArrayList<>();
        full.add(new SlotItem(0, "diamond_pickaxe", 1));
        full.add(new SlotItem(1, "diamond_sword", 1));
        full.add(new SlotItem(2, "water_bucket", 1));
        full.add(new SlotItem(3, "cooked_beef", 16));
        full.add(new SlotItem(4, "torch", 32));
        full.add(new SlotItem(5, "oak_log", 16));
        full.add(new SlotItem(6, "iron_ore", 12));
        full.add(new SlotItem(7, "raw_gold", 8));
        full.add(new SlotItem(8, "red_bed", 1));
        full.add(new SlotItem(9, "cobblestone", 64));
        full.add(new SlotItem(10, "dirt", 64));
        full.add(new SlotItem(11, "dirt", 7));
        full.add(new SlotItem(12, "gravel", 64));
        full.add(new SlotItem(13, "gravel", 4));
        full.add(new SlotItem(14, "poisonous_potato", 2));
        full.add(new SlotItem(15, "rotten_flesh", 5));
        for (int s = 16; s < 34; s++) {
            full.add(new SlotItem(s, "andesite", 64));
        }

        ScanResult crowded = InventoryLogic.scan(full, Equipped.EMPTY);
        assertEquals(2, crowded.freeSlots());
        assertEquals(List.of(11, 13, 14, 15), crowded.dropCandidates());
    }

    @Test
    void hotbarSwapTargetPreservesToolsAndScreenSlotMappingIsAccurate() {
        assertEquals(36, InventoryLogic.toPlayerScreenSlot(0));
        assertEquals(44, InventoryLogic.toPlayerScreenSlot(8));
        assertEquals(9, InventoryLogic.toPlayerScreenSlot(9));
        assertEquals(35, InventoryLogic.toPlayerScreenSlot(35));

        List<SlotItem> fullHotbar = List.of(
                new SlotItem(0, "diamond_sword", 1),
                new SlotItem(1, "diamond_pickaxe", 1),
                new SlotItem(2, "water_bucket", 1),
                new SlotItem(3, "cooked_beef", 16),
                new SlotItem(4, "torch", 32),
                new SlotItem(5, "bow", 1),
                new SlotItem(6, "cobblestone", 64), // non-protected, chosen for swap
                new SlotItem(7, "diamond_shovel", 1),
                new SlotItem(8, "diamond_axe", 1)
        );
        assertEquals(6, InventoryLogic.preferredHotbarSwapTarget(fullHotbar));

        List<SlotItem> withEmpty = List.of(
                new SlotItem(0, "diamond_sword", 1),
                new SlotItem(2, "water_bucket", 1)
        );
        assertEquals(1, InventoryLogic.preferredHotbarSwapTarget(withEmpty));
    }
}
