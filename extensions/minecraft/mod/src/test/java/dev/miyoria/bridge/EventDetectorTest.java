package dev.miyoria.bridge;

import dev.miyoria.bridge.events.EventDetector;
import dev.miyoria.bridge.events.EventDetector.GameEvent;
import dev.miyoria.bridge.events.EventDetector.TickState;
import dev.miyoria.bridge.model.Models.EntityInfo;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class EventDetectorTest {
    private EventDetector det;

    @BeforeEach
    void setUp() {
        det = new EventDetector(new EventDetector.Config(6f, 16.0, 100, 10));
    }

    private static TickState st(float health, Map<String, Integer> inv, long time, List<EntityInfo> near) {
        return new TickState(true, false, health, 20, inv, "overworld", time, 10.5, 64, -3.2, near, null, null);
    }

    private static TickState st(float health) {
        return st(health, Map.of(), 1000, List.of());
    }

    private static List<String> names(List<GameEvent> evs) {
        return evs.stream().map(GameEvent::name).toList();
    }

    private List<GameEvent> run(int ticks, TickState s) {
        List<GameEvent> all = new ArrayList<>();
        for (int i = 0; i < ticks; i++) all.addAll(det.onTick(s));
        return all;
    }

    @Test
    void firstTickEmitsNothing() {
        assertTrue(det.onTick(st(20f)).isEmpty());
    }

    @Test
    void damageWithAmountAndSource() {
        det.onTick(st(20f));
        TickState hit = new TickState(true, false, 16.5f, 20, Map.of(), "overworld", 1000, 0, 64, 0, List.of(), "mob", "zombie");
        List<GameEvent> evs = det.onTick(hit);
        assertEquals(List.of("damage"), names(evs));
        var d = evs.get(0).data();
        assertEquals(3.5, d.get("amount").getAsDouble());
        assertEquals("mob", d.get("source").getAsString());
        assertEquals("zombie", d.get("attacker").getAsString());
        assertEquals(16.5, d.get("health").getAsDouble());
        // no change next tick -> no repeat
        assertTrue(det.onTick(hit).isEmpty());
    }

    @Test
    void damageWithUnknownSource() {
        det.onTick(st(20f));
        var evs = det.onTick(st(19f));
        assertEquals("unknown", evs.get(0).data().get("source").getAsString());
        assertFalse(evs.get(0).data().has("attacker"));
    }

    @Test
    void healingIsNotDamage() {
        det.onTick(st(10f));
        assertTrue(det.onTick(st(14f)).isEmpty());
    }

    @Test
    void lowHealthFiresOnceWithHysteresis() {
        det.onTick(st(20f));
        List<GameEvent> evs = det.onTick(st(5f));
        assertEquals(List.of("damage", "low_health"), names(evs));
        assertEquals(6.0, evs.get(1).data().get("threshold").getAsDouble());

        // staying low / hurting more does not re-fire low_health
        assertEquals(List.of("damage"), names(det.onTick(st(3f))));
        // heal just above the threshold: still disarmed
        det.onTick(st(7f));
        assertEquals(List.of("damage"), names(det.onTick(st(4f))));
        // recover well past threshold + 4 -> re-armed
        det.onTick(st(16f));
        assertEquals(List.of("damage", "low_health"), names(det.onTick(st(2f))));
    }

    @Test
    void deathEmittedOnceThenRespawnRebaselines() {
        det.onTick(st(20f));
        TickState dead = new TickState(true, true, 0f, 20, Map.of(), "overworld", 1000, 5.9, 70, -1.1, List.of(), "lava", null);
        List<GameEvent> evs = det.onTick(dead);
        assertEquals(List.of("death"), names(evs));
        var d = evs.get(0).data();
        assertEquals("lava", d.get("last_damage_source").getAsString());
        assertEquals(5, d.getAsJsonObject("position").get("x").getAsInt());
        assertEquals(-2, d.getAsJsonObject("position").get("z").getAsInt()); // floor
        assertTrue(det.onTick(dead).isEmpty()); // death screen lingers: no repeat

        // respawn with fresh items/health: no damage, no pickups, no low_health
        assertTrue(det.onTick(st(20f, Map.of("bread", 5), 1000, List.of())).isEmpty());
        assertTrue(det.onTick(st(20f, Map.of("bread", 5), 1000, List.of())).isEmpty());
        // dying again later works
        assertEquals(List.of("death"), names(det.onTick(dead)));
    }

    @Test
    void hostileNearOnEntryWithCooldown() {
        det.onTick(st(20f));
        EntityInfo far = new EntityInfo("zombie", null, 30, true);
        assertTrue(det.onTick(st(20f, Map.of(), 1000, List.of(far))).isEmpty());

        EntityInfo z = new EntityInfo("zombie", null, 10, true);
        EntityInfo sk = new EntityInfo("skeleton", null, 14, true);
        EntityInfo cow = new EntityInfo("cow", null, 2, false);
        List<GameEvent> evs = det.onTick(st(20f, Map.of(), 1000, List.of(z, sk, cow)));
        assertEquals(List.of("hostile_near"), names(evs));
        var d = evs.get(0).data();
        assertEquals(2, d.get("count").getAsInt());
        assertEquals("zombie", d.getAsJsonArray("entities").get(0).getAsJsonObject().get("type").getAsString());
        assertEquals(2, d.getAsJsonArray("new_types").size());

        // same hostiles still around: nothing new
        assertTrue(run(5, st(20f, Map.of(), 1000, List.of(z, sk))).isEmpty());

        // all gone, one zombie returns inside the cooldown: suppressed
        run(3, st(20f));
        assertTrue(det.onTick(st(20f, Map.of(), 1000, List.of(z))).isEmpty());

        // after the cooldown it fires again
        run(120, st(20f));
        assertEquals(List.of("hostile_near"), names(det.onTick(st(20f, Map.of(), 1000, List.of(z)))));
    }

    @Test
    void newHostileTypeWhileOthersPresentFires() {
        det.onTick(st(20f));
        EntityInfo z = new EntityInfo("zombie", null, 10, true);
        det.onTick(st(20f, Map.of(), 1000, List.of(z)));
        EntityInfo creeper = new EntityInfo("creeper", null, 9, true);
        var evs = det.onTick(st(20f, Map.of(), 1000, List.of(z, creeper)));
        assertEquals(List.of("hostile_near"), names(evs));
        assertEquals("creeper", evs.get(0).data().getAsJsonArray("new_types").get(0).getAsString());
    }

    @Test
    void itemPickedAggregatesAndIgnoresDecreases() {
        det.onTick(st(20f, Map.of("oak_log", 1), 1000, List.of()));
        // +2 logs, +1 apple within the flush window
        det.onTick(st(20f, Map.of("oak_log", 2, "apple", 1), 1000, List.of()));
        List<GameEvent> evs = new ArrayList<>(run(12, st(20f, Map.of("oak_log", 3, "apple", 1), 1000, List.of())));
        List<GameEvent> picked = evs.stream().filter(e -> e.name().equals("item_picked")).toList();
        assertEquals(1, picked.size());
        var items = picked.get(0).data().getAsJsonObject("items");
        assertEquals(2, items.get("oak_log").getAsInt());
        assertEquals(1, items.get("apple").getAsInt());

        // dropping items emits nothing
        assertTrue(run(15, st(20f, Map.of("oak_log", 1), 1000, List.of())).isEmpty());
    }

    @Test
    void nightStartedOnlyOnTransitionInOverworld() {
        det.onTick(st(20f, Map.of(), 12990, List.of()));
        assertTrue(det.onTick(st(20f, Map.of(), 12999, List.of())).isEmpty());
        List<GameEvent> evs = det.onTick(st(20f, Map.of(), 13000, List.of()));
        assertEquals(List.of("night_started"), names(evs));
        assertEquals(13000, evs.get(0).data().get("time_of_day").getAsLong());
        assertTrue(det.onTick(st(20f, Map.of(), 13001, List.of())).isEmpty());
        // morning, then the next night again
        assertTrue(det.onTick(st(20f, Map.of(), 23500, List.of())).isEmpty());
        assertTrue(det.onTick(st(20f, Map.of(), 24000 + 100, List.of())).isEmpty());
        assertEquals(List.of("night_started"), names(det.onTick(st(20f, Map.of(), 24000 + 13000, List.of()))));
    }

    @Test
    void joiningDuringNightDoesNotFire() {
        assertTrue(det.onTick(st(20f, Map.of(), 15000, List.of())).isEmpty());
        assertTrue(det.onTick(st(20f, Map.of(), 15001, List.of())).isEmpty());
    }

    @Test
    void noNightEventsInTheNether() {
        TickState a = new TickState(true, false, 20f, 20, Map.of(), "the_nether", 12999, 0, 0, 0, List.of(), null, null);
        TickState b = new TickState(true, false, 20f, 20, Map.of(), "the_nether", 13000, 0, 0, 0, List.of(), null, null);
        det.onTick(a);
        assertTrue(det.onTick(b).isEmpty());
    }

    @Test
    void leavingTheWorldResetsState() {
        det.onTick(st(20f, Map.of("dirt", 1), 1000, List.of()));
        det.onTick(new TickState(false, false, 0, 0, Map.of(), "overworld", 0, 0, 0, 0, List.of(), null, null));
        // coming back at lower health / more items must not look like damage or pickups
        assertTrue(det.onTick(st(5f, Map.of("dirt", 64), 1000, List.of())).stream()
                .noneMatch(e -> e.name().equals("damage") || e.name().equals("item_picked")));
    }

    @Test
    void dawnAndTheEndDoNotEmitNightStarted() {
        det.onTick(new TickState(true, false, 20f, 12, Map.of(), "overworld", 23999, 0, 64, 0, List.of(), null, null));
        List<GameEvent> dawn = det.onTick(new TickState(true, false, 20f, 12, Map.of(), "overworld", 24000, 0, 64, 0, List.of(), null, null));
        assertFalse(names(dawn).contains("night_started"));

        det.onTick(new TickState(true, false, 20f, 20, Map.of(), "the_end", 12999, 0, 64, 0, List.of(), null, null));
        List<GameEvent> endNight = det.onTick(new TickState(true, false, 20f, 20, Map.of(), "the_end", 13000, 0, 64, 0, List.of(), null, null));
        assertTrue(endNight.isEmpty());
    }
}
