package dev.miyoria.bridge.snapshot;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.miyoria.bridge.model.Models.BlockInfo;
import dev.miyoria.bridge.model.Models.EntityInfo;
import dev.miyoria.bridge.model.Models.StackInfo;
import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.model.RawObservation.LookTarget;
import dev.miyoria.bridge.model.RawObservation.StackSlot;
import dev.miyoria.bridge.util.NotableBlocks;
import dev.miyoria.bridge.util.TimeOfDay;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Turns a {@link RawObservation} into the compact JSON snapshot returned by {@code observe}. */
public final class SnapshotSummarizer {
    private SnapshotSummarizer() {}

    public record Options(int maxEntities, int maxBlockKinds) {
        public static final Options DEFAULT = new Options(16, 20);
    }

    public static JsonObject summarize(RawObservation raw) {
        return summarize(raw, Options.DEFAULT);
    }

    public static JsonObject summarize(RawObservation raw, Options opt) {
        JsonObject o = new JsonObject();

        o.addProperty("health", round(raw.health, 1));
        o.addProperty("max_health", round(raw.maxHealth, 1));
        if (raw.absorption > 0) o.addProperty("absorption", round(raw.absorption, 1));
        o.addProperty("food", raw.food);
        o.addProperty("saturation", round(raw.saturation, 1));
        o.addProperty("air", raw.air);

        JsonObject pos = new JsonObject();
        pos.addProperty("x", round(raw.x, 2));
        pos.addProperty("y", round(raw.y, 2));
        pos.addProperty("z", round(raw.z, 2));
        o.add("position", pos);
        JsonObject block = new JsonObject();
        block.addProperty("x", (int) Math.floor(raw.x));
        block.addProperty("y", (int) Math.floor(raw.y));
        block.addProperty("z", (int) Math.floor(raw.z));
        o.add("block_position", block);
        o.addProperty("yaw", round(raw.yaw, 1));
        o.addProperty("pitch", round(raw.pitch, 1));

        o.addProperty("dimension", raw.dimension);
        o.addProperty("biome", raw.biome);
        o.addProperty("time_of_day", TimeOfDay.wrap(raw.timeOfDay));
        o.addProperty("time_phase", TimeOfDay.phase(raw.timeOfDay));
        o.addProperty("is_night", "overworld".equals(raw.dimension) && TimeOfDay.isNight(raw.timeOfDay));
        o.addProperty("weather", raw.thundering ? "thunder" : raw.raining ? "rain" : "clear");

        // held item + inventory
        StackInfo held = heldStack(raw);
        if (held != null) {
            JsonObject h = stackJson(held);
            h.addProperty("slot", raw.heldSlot);
            o.add("held_item", h);
        } else {
            o.add("held_item", null);
        }
        o.add("inventory", inventorySummary(raw.mainSlots));
        o.addProperty("inventory_free_slots", Math.max(0, raw.mainSlotCount - raw.mainSlots.size()));
        o.add("hotbar", hotbar(raw.mainSlots));

        JsonObject armor = new JsonObject();
        armor.add("head", stackOrNull(raw.head));
        armor.add("chest", stackOrNull(raw.chest));
        armor.add("legs", stackOrNull(raw.legs));
        armor.add("feet", stackOrNull(raw.feet));
        o.add("armor", armor);
        o.add("offhand", stackOrNull(raw.offhand));

        o.add("looking_at", lookJson(raw.lookingAt));

        // entities
        List<EntityInfo> sorted = new ArrayList<>(raw.entities);
        sorted.sort(Comparator.comparingDouble(EntityInfo::distance));
        JsonArray ents = new JsonArray();
        int shown = Math.min(opt.maxEntities(), sorted.size());
        for (int i = 0; i < shown; i++) {
            EntityInfo e = sorted.get(i);
            JsonObject eo = new JsonObject();
            eo.addProperty("type", e.type());
            if (e.name() != null && !e.name().equals(e.type())) eo.addProperty("name", e.name());
            eo.addProperty("distance", round(e.distance(), 1));
            eo.addProperty("hostile", e.hostile());
            ents.add(eo);
        }
        o.add("nearby_entities", ents);
        o.addProperty("nearby_entities_total", sorted.size());
        o.addProperty("hostile_count", sorted.stream().filter(EntityInfo::hostile).count());

        o.add("nearby_blocks", notableBlocks(raw.notableBlocks, opt.maxBlockKinds()));

        JsonObject bar = new JsonObject();
        bar.addProperty("available", raw.baritone.available());
        bar.addProperty("busy", raw.baritone.busy());
        bar.addProperty("process", raw.baritone.process());
        bar.addProperty("goal", raw.baritone.goal());
        o.add("baritone", bar);

        JsonObject alto = new JsonObject();
        alto.addProperty("available", raw.altoclef.available());
        alto.addProperty("busy", raw.altoclef.busy());
        o.add("altoclef", alto);

        if (raw.crafting != null) {
            JsonObject c = new JsonObject();
            c.addProperty("kind", raw.crafting.kind());
            c.addProperty("item", raw.crafting.item());
            o.add("crafting", c);
        } else {
            o.add("crafting", null);
        }

        JsonObject reflex = new JsonObject();
        reflex.addProperty("active", raw.reflex);
        o.add("reflex", reflex);

        return o;
    }

    /** item id -> total count across all slots, sorted by id for stable output. */
    public static JsonObject inventorySummary(List<StackSlot> slots) {
        Map<String, Integer> totals = new TreeMap<>();
        for (StackSlot s : slots) {
            if (s.stack() == null || s.stack().count() <= 0) continue;
            totals.merge(s.stack().item(), s.stack().count(), Integer::sum);
        }
        JsonObject o = new JsonObject();
        totals.forEach(o::addProperty);
        return o;
    }

    /** Totals as a plain map (used by the event detector). */
    public static Map<String, Integer> inventoryTotals(List<StackSlot> slots) {
        Map<String, Integer> totals = new LinkedHashMap<>();
        for (StackSlot s : slots) {
            if (s.stack() == null || s.stack().count() <= 0) continue;
            totals.merge(s.stack().item(), s.stack().count(), Integer::sum);
        }
        return totals;
    }

    private static JsonArray hotbar(List<StackSlot> slots) {
        JsonArray arr = new JsonArray();
        StackInfo[] bar = new StackInfo[9];
        for (StackSlot s : slots) {
            if (s.slot() >= 0 && s.slot() < 9) bar[s.slot()] = s.stack();
        }
        for (int i = 0; i < 9; i++) {
            if (bar[i] == null) {
                arr.add((JsonObject) null);
            } else {
                arr.add(stackJson(bar[i]));
            }
        }
        return arr;
    }

    private static StackInfo heldStack(RawObservation raw) {
        for (StackSlot s : raw.mainSlots) {
            if (s.slot() == raw.heldSlot) return s.stack();
        }
        return null;
    }

    private static JsonObject stackOrNull(StackInfo s) {
        return s == null ? null : stackJson(s);
    }

    static JsonObject stackJson(StackInfo s) {
        JsonObject o = new JsonObject();
        o.addProperty("item", s.item());
        o.addProperty("count", s.count());
        if (s.durabilityPct() != null) o.addProperty("durability_pct", s.durabilityPct());
        return o;
    }

    private static JsonObject lookJson(LookTarget t) {
        JsonObject o = new JsonObject();
        if (t == null) {
            o.addProperty("kind", "none");
            return o;
        }
        o.addProperty("kind", t.kind());
        if (t.id() != null) o.addProperty(t.kind().equals("block") ? "block" : "entity", t.id());
        if (t.name() != null && !t.name().equals(t.id())) o.addProperty("name", t.name());
        if (t.x() != null) {
            JsonObject p = new JsonObject();
            p.addProperty("x", t.x());
            p.addProperty("y", t.y());
            p.addProperty("z", t.z());
            o.add("position", p);
        }
        if (t.face() != null) o.addProperty("face", t.face());
        if (t.distance() != null) o.addProperty("distance", round(t.distance(), 1));
        return o;
    }

    /**
     * Group scanned notable blocks by kind: count + the nearest instance.
     * Ordered by interest (ores first) then distance, capped at {@code maxKinds}.
     */
    public static JsonArray notableBlocks(List<BlockInfo> blocks, int maxKinds) {
        Map<String, List<BlockInfo>> byKind = new LinkedHashMap<>();
        for (BlockInfo b : blocks) byKind.computeIfAbsent(b.block(), k -> new ArrayList<>()).add(b);

        record Group(String kind, int count, BlockInfo nearest) {}
        List<Group> groups = new ArrayList<>();
        for (var en : byKind.entrySet()) {
            BlockInfo nearest = en.getValue().stream().min(Comparator.comparingDouble(BlockInfo::distance)).orElseThrow();
            groups.add(new Group(en.getKey(), en.getValue().size(), nearest));
        }
        groups.sort(Comparator.<Group>comparingInt(g -> NotableBlocks.priority(g.kind()))
                .thenComparingDouble(g -> g.nearest().distance())
                .thenComparing(Group::kind));

        JsonArray arr = new JsonArray();
        for (int i = 0; i < Math.min(maxKinds, groups.size()); i++) {
            Group g = groups.get(i);
            JsonObject o = new JsonObject();
            o.addProperty("block", g.kind());
            o.addProperty("count", g.count());
            JsonObject n = new JsonObject();
            n.addProperty("x", g.nearest().x());
            n.addProperty("y", g.nearest().y());
            n.addProperty("z", g.nearest().z());
            o.add("nearest", n);
            o.addProperty("distance", round(g.nearest().distance(), 1));
            arr.add(o);
        }
        return arr;
    }

    public static double round(double v, int decimals) {
        double f = Math.pow(10, decimals);
        return Math.round(v * f) / f;
    }
}
