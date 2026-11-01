package dev.miyoria.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.miyoria.bridge.model.Models.BlockInfo;
import dev.miyoria.bridge.model.Models.EntityInfo;
import dev.miyoria.bridge.model.Models.StackInfo;
import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.model.RawObservation.AltoState;
import dev.miyoria.bridge.model.RawObservation.BaritoneState;
import dev.miyoria.bridge.model.RawObservation.LookTarget;
import dev.miyoria.bridge.model.RawObservation.StackSlot;
import dev.miyoria.bridge.snapshot.SnapshotSummarizer;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class SnapshotSummarizerTest {

    private static RawObservation base() {
        RawObservation r = new RawObservation();
        r.health = 17.5f;
        r.food = 18;
        r.saturation = 4.25f;
        r.air = 300;
        r.x = 100.456;
        r.y = 64.0;
        r.z = -20.2;
        r.yaw = 91.26f;
        r.pitch = -12.34f;
        r.dimension = "overworld";
        r.biome = "plains";
        r.timeOfDay = 6000;
        return r;
    }

    @Test
    void basicFieldsAndRounding() {
        JsonObject o = SnapshotSummarizer.summarize(base());
        assertEquals(17.5, o.get("health").getAsDouble());
        assertEquals(20.0, o.get("max_health").getAsDouble());
        assertEquals(18, o.get("food").getAsInt());
        assertEquals(4.3, o.get("saturation").getAsDouble(), 1e-9);
        assertEquals(100.46, o.getAsJsonObject("position").get("x").getAsDouble(), 1e-9);
        assertEquals(-21, o.getAsJsonObject("block_position").get("z").getAsInt()); // floor(-20.2)
        assertEquals("plains", o.get("biome").getAsString());
        assertEquals("overworld", o.get("dimension").getAsString());
        assertEquals(6000, o.get("time_of_day").getAsInt());
        assertEquals("day", o.get("time_phase").getAsString());
        assertFalse(o.get("is_night").getAsBoolean());
        assertEquals("clear", o.get("weather").getAsString());
        assertFalse(o.has("absorption"));
    }

    @Test
    void weatherAndNight() {
        RawObservation r = base();
        r.timeOfDay = 24000L * 3 + 14000; // wraps
        r.raining = true;
        JsonObject o = SnapshotSummarizer.summarize(r);
        assertEquals(14000, o.get("time_of_day").getAsInt());
        assertEquals("night", o.get("time_phase").getAsString());
        assertTrue(o.get("is_night").getAsBoolean());
        assertEquals("rain", o.get("weather").getAsString());

        r.thundering = true;
        assertEquals("thunder", SnapshotSummarizer.summarize(r).get("weather").getAsString());

        r.dimension = "the_nether"; // no day/night cycle there
        assertFalse(SnapshotSummarizer.summarize(r).get("is_night").getAsBoolean());
    }

    @Test
    void inventoryIsSummedAcrossSlotsAndSorted() {
        RawObservation r = base();
        r.mainSlots = new ArrayList<>(List.of(
                new StackSlot(0, new StackInfo("iron_pickaxe", 1, 88)),
                new StackSlot(3, new StackInfo("cobblestone", 64, null)),
                new StackSlot(10, new StackInfo("cobblestone", 20, null)),
                new StackSlot(11, new StackInfo("apple", 3, null))));
        r.heldSlot = 0;
        JsonObject o = SnapshotSummarizer.summarize(r);

        JsonObject inv = o.getAsJsonObject("inventory");
        assertEquals(84, inv.get("cobblestone").getAsInt());
        assertEquals(3, inv.get("apple").getAsInt());
        assertEquals(1, inv.get("iron_pickaxe").getAsInt());
        assertEquals(List.of("apple", "cobblestone", "iron_pickaxe"), List.copyOf(inv.keySet()));
        assertEquals(36 - 4, o.get("inventory_free_slots").getAsInt());

        JsonObject held = o.getAsJsonObject("held_item");
        assertEquals("iron_pickaxe", held.get("item").getAsString());
        assertEquals(88, held.get("durability_pct").getAsInt());
        assertEquals(0, held.get("slot").getAsInt());

        JsonArray hotbar = o.getAsJsonArray("hotbar");
        assertEquals(9, hotbar.size());
        assertEquals("iron_pickaxe", hotbar.get(0).getAsJsonObject().get("item").getAsString());
        assertTrue(hotbar.get(1).isJsonNull());
        assertEquals("cobblestone", hotbar.get(3).getAsJsonObject().get("item").getAsString());
        assertTrue(hotbar.get(8).isJsonNull());
    }

    @Test
    void emptyHandAndArmor() {
        RawObservation r = base();
        r.heldSlot = 4;
        r.head = new StackInfo("iron_helmet", 1, 50);
        r.feet = new StackInfo("leather_boots", 1, 100);
        JsonObject o = SnapshotSummarizer.summarize(r);
        assertTrue(o.get("held_item").isJsonNull());
        JsonObject armor = o.getAsJsonObject("armor");
        assertEquals("iron_helmet", armor.getAsJsonObject("head").get("item").getAsString());
        assertTrue(armor.get("chest").isJsonNull());
        assertTrue(armor.get("legs").isJsonNull());
        assertEquals("leather_boots", armor.getAsJsonObject("feet").get("item").getAsString());
        assertTrue(o.get("offhand").isJsonNull());
    }

    @Test
    void entitiesSortedByDistanceCappedAndCounted() {
        RawObservation r = base();
        r.entities = new ArrayList<>(List.of(
                new EntityInfo("cow", null, 12.0, false),
                new EntityInfo("zombie", null, 3.04, true),
                new EntityInfo("player", "Steve", 8.0, false),
                new EntityInfo("skeleton", null, 20.0, true)));
        JsonObject o = SnapshotSummarizer.summarize(r, new SnapshotSummarizer.Options(3, 20));
        JsonArray ents = o.getAsJsonArray("nearby_entities");
        assertEquals(3, ents.size());
        assertEquals("zombie", ents.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals(3.0, ents.get(0).getAsJsonObject().get("distance").getAsDouble());
        assertTrue(ents.get(0).getAsJsonObject().get("hostile").getAsBoolean());
        assertFalse(ents.get(0).getAsJsonObject().has("name"));
        assertEquals("Steve", ents.get(1).getAsJsonObject().get("name").getAsString());
        assertEquals("cow", ents.get(2).getAsJsonObject().get("type").getAsString());
        assertEquals(4, o.get("nearby_entities_total").getAsInt());
        assertEquals(2, o.get("hostile_count").getAsInt());
    }

    @Test
    void notableBlocksGroupedByKindOresFirst() {
        List<BlockInfo> blocks = List.of(
                new BlockInfo("chest", 1, 64, 1, 5.0),
                new BlockInfo("iron_ore", 10, 40, 10, 14.1),
                new BlockInfo("iron_ore", 4, 60, 3, 6.2),
                new BlockInfo("iron_ore", 8, 50, 8, 11.0),
                new BlockInfo("diamond_ore", 30, 12, 30, 40.0),
                new BlockInfo("crafting_table", 2, 64, 2, 3.0));
        JsonArray arr = SnapshotSummarizer.notableBlocks(blocks, 20);
        assertEquals(4, arr.size());
        assertEquals("diamond_ore", arr.get(0).getAsJsonObject().get("block").getAsString()); // priority 0
        assertEquals("iron_ore", arr.get(1).getAsJsonObject().get("block").getAsString());
        JsonObject iron = arr.get(1).getAsJsonObject();
        assertEquals(3, iron.get("count").getAsInt());
        assertEquals(4, iron.getAsJsonObject("nearest").get("x").getAsInt()); // nearest instance
        assertEquals(6.2, iron.get("distance").getAsDouble());
        assertEquals("chest", arr.get(2).getAsJsonObject().get("block").getAsString());
        assertEquals("crafting_table", arr.get(3).getAsJsonObject().get("block").getAsString());

        assertEquals(2, SnapshotSummarizer.notableBlocks(blocks, 2).size());
        assertEquals(0, SnapshotSummarizer.notableBlocks(List.of(), 5).size());
    }

    @Test
    void lookingAtBlockEntityAndNothing() {
        RawObservation r = base();
        assertEquals("none", SnapshotSummarizer.summarize(r).getAsJsonObject("looking_at").get("kind").getAsString());

        r.lookingAt = new LookTarget("block", "oak_log", null, 5, 64, -3, "north", 2.449);
        JsonObject b = SnapshotSummarizer.summarize(r).getAsJsonObject("looking_at");
        assertEquals("block", b.get("kind").getAsString());
        assertEquals("oak_log", b.get("block").getAsString());
        assertEquals("north", b.get("face").getAsString());
        assertEquals(-3, b.getAsJsonObject("position").get("z").getAsInt());
        assertEquals(2.4, b.get("distance").getAsDouble());

        r.lookingAt = new LookTarget("entity", "cow", null, 1, 2, 3, null, 3.0);
        JsonObject e = SnapshotSummarizer.summarize(r).getAsJsonObject("looking_at");
        assertEquals("entity", e.get("kind").getAsString());
        assertEquals("cow", e.get("entity").getAsString());
        assertFalse(e.has("block"));
    }

    @Test
    void baritoneAndAltoState() {
        RawObservation r = base();
        JsonObject off = SnapshotSummarizer.summarize(r);
        assertFalse(off.getAsJsonObject("baritone").get("available").getAsBoolean());
        assertFalse(off.getAsJsonObject("altoclef").get("available").getAsBoolean());

        r.baritone = new BaritoneState(true, true, "Mine", "GoalBlock{x=1,y=2,z=3}");
        r.altoclef = new AltoState(true, null);
        JsonObject on = SnapshotSummarizer.summarize(r);
        JsonObject bar = on.getAsJsonObject("baritone");
        assertTrue(bar.get("busy").getAsBoolean());
        assertEquals("Mine", bar.get("process").getAsString());
        assertEquals("GoalBlock{x=1,y=2,z=3}", bar.get("goal").getAsString());
        assertTrue(on.getAsJsonObject("altoclef").get("busy").isJsonNull());
    }
}
