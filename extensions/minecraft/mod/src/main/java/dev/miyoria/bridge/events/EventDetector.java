package dev.miyoria.bridge.events;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.miyoria.bridge.model.Models.EntityInfo;
import dev.miyoria.bridge.util.TimeOfDay;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Turns a stream of per-tick game state into protocol events (death, damage, low_health,
 * hostile_near, item_picked, night_started). Pure logic, no Minecraft types: unit-tested.
 * Events that come from elsewhere (chat, advancement, Baritone goal_*) are pushed directly.
 */
public final class EventDetector {

    public record Config(float lowHealthThreshold, double hostileRadius, int hostileCooldownTicks, int itemFlushTicks) {
        public static final Config DEFAULT = new Config(6f, 16.0, 100, 10);
    }

    public record GameEvent(String name, JsonObject data) {}

    /** One tick of state sampled on the client thread. */
    public record TickState(boolean inWorld, boolean dead, float health, int food,
                            Map<String, Integer> inventory, String dimension, long timeOfDay,
                            double x, double y, double z,
                            List<EntityInfo> nearby,
                            String damageSource, String damageAttacker) {}

    private final Config cfg;

    private long tick;
    private boolean deadReported;
    private float prevHealth = Float.NaN;
    private boolean lowHealthArmed = true;
    private Map<String, Integer> prevInventory;
    private final Map<String, Integer> pendingPickups = new LinkedHashMap<>();
    private long lastItemFlush;
    private Set<String> prevHostileTypes = new HashSet<>();
    private final Map<String, Long> hostileCooldown = new HashMap<>();
    private Boolean wasNight;
    private String prevDimension;

    public EventDetector(Config cfg) {
        this.cfg = cfg;
    }

    public List<GameEvent> onTick(TickState s) {
        List<GameEvent> out = new ArrayList<>();
        tick++;

        if (!s.inWorld()) {
            resetWorldState();
            return out;
        }

        if (s.dead()) {
            if (!deadReported) {
                deadReported = true;
                JsonObject d = new JsonObject();
                d.addProperty("dimension", s.dimension());
                d.add("position", pos(s));
                d.addProperty("last_damage_source", s.damageSource() == null ? "unknown" : s.damageSource());
                if (s.damageAttacker() != null) d.addProperty("last_attacker", s.damageAttacker());
                out.add(new GameEvent("death", d));
            }
            prevHealth = 0f;
            return out;
        }
        if (deadReported) {
            // respawned: re-baseline everything so respawn does not look like damage / pickups
            deadReported = false;
            prevHealth = s.health();
            prevInventory = new HashMap<>(s.inventory());
            pendingPickups.clear();
            lowHealthArmed = s.health() > cfg.lowHealthThreshold();
            prevHostileTypes = new HashSet<>();
            wasNight = null;
            prevDimension = s.dimension();
            return out;
        }

        // ---- damage / low health ----
        if (!Float.isNaN(prevHealth) && s.health() < prevHealth - 0.01f) {
            JsonObject d = new JsonObject();
            d.addProperty("amount", round1(prevHealth - s.health()));
            d.addProperty("source", s.damageSource() == null ? "unknown" : s.damageSource());
            if (s.damageAttacker() != null) d.addProperty("attacker", s.damageAttacker());
            d.addProperty("health", round1(s.health()));
            out.add(new GameEvent("damage", d));
        }
        if (s.health() <= cfg.lowHealthThreshold() && s.health() > 0f) {
            if (lowHealthArmed) {
                lowHealthArmed = false;
                JsonObject d = new JsonObject();
                d.addProperty("health", round1(s.health()));
                d.addProperty("threshold", cfg.lowHealthThreshold());
                d.addProperty("food", s.food());
                out.add(new GameEvent("low_health", d));
            }
        } else if (s.health() > cfg.lowHealthThreshold() + 4f) {
            lowHealthArmed = true; // hysteresis: must recover a couple of hearts first
        }
        prevHealth = s.health();

        // ---- hostile_near ----
        Set<String> typesNow = new HashSet<>();
        List<EntityInfo> hostiles = new ArrayList<>();
        for (EntityInfo e : s.nearby()) {
            if (e.hostile() && e.distance() <= cfg.hostileRadius()) {
                typesNow.add(e.type());
                hostiles.add(e);
            }
        }
        boolean anyNewReady = false;
        List<String> newTypes = new ArrayList<>();
        for (String t : typesNow) {
            if (!prevHostileTypes.contains(t)) {
                Long last = hostileCooldown.get(t);
                if (last == null || tick - last >= cfg.hostileCooldownTicks()) {
                    anyNewReady = true;
                    newTypes.add(t);
                    hostileCooldown.put(t, tick);
                }
            }
        }
        if (anyNewReady) {
            hostiles.sort(Comparator.comparingDouble(EntityInfo::distance));
            JsonObject d = new JsonObject();
            d.addProperty("count", hostiles.size());
            JsonArray arr = new JsonArray();
            for (int i = 0; i < Math.min(8, hostiles.size()); i++) {
                JsonObject eo = new JsonObject();
                eo.addProperty("type", hostiles.get(i).type());
                eo.addProperty("distance", round1(hostiles.get(i).distance()));
                arr.add(eo);
            }
            d.add("entities", arr);
            JsonArray nt = new JsonArray();
            newTypes.stream().sorted().forEach(nt::add);
            d.add("new_types", nt);
            out.add(new GameEvent("hostile_near", d));
        }
        prevHostileTypes = typesNow;

        // ---- item_picked (inventory totals increased) ----
        if (prevInventory != null) {
            for (var en : s.inventory().entrySet()) {
                int before = prevInventory.getOrDefault(en.getKey(), 0);
                if (en.getValue() > before) pendingPickups.merge(en.getKey(), en.getValue() - before, Integer::sum);
            }
        }
        prevInventory = new HashMap<>(s.inventory());
        if (!pendingPickups.isEmpty() && tick - lastItemFlush >= cfg.itemFlushTicks()) {
            JsonObject items = new JsonObject();
            pendingPickups.forEach(items::addProperty);
            JsonObject d = new JsonObject();
            d.add("items", items);
            out.add(new GameEvent("item_picked", d));
            pendingPickups.clear();
            lastItemFlush = tick;
        }

        // ---- night_started (overworld only) ----
        if (!s.dimension().equals(prevDimension)) {
            wasNight = null;
            prevDimension = s.dimension();
        }
        if ("overworld".equals(s.dimension())) {
            boolean night = TimeOfDay.isNight(s.timeOfDay());
            if (wasNight != null && !wasNight && night) {
                JsonObject d = new JsonObject();
                d.addProperty("time_of_day", TimeOfDay.wrap(s.timeOfDay()));
                out.add(new GameEvent("night_started", d));
            }
            wasNight = night;
        }

        return out;
    }

    private void resetWorldState() {
        deadReported = false;
        prevHealth = Float.NaN;
        lowHealthArmed = true;
        prevInventory = null;
        pendingPickups.clear();
        prevHostileTypes = new HashSet<>();
        wasNight = null;
        prevDimension = null;
    }

    private static JsonObject pos(TickState s) {
        JsonObject p = new JsonObject();
        p.addProperty("x", (int) Math.floor(s.x()));
        p.addProperty("y", (int) Math.floor(s.y()));
        p.addProperty("z", (int) Math.floor(s.z()));
        return p;
    }

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }
}
