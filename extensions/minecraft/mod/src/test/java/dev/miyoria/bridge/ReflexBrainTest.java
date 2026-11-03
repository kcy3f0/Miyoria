package dev.miyoria.bridge;

import dev.miyoria.bridge.reflex.ReflexBrain;
import dev.miyoria.bridge.reflex.ReflexBrain.Kind;
import dev.miyoria.bridge.reflex.ReflexBrain.Sense;
import dev.miyoria.bridge.reflex.ReflexBrain.Step;
import dev.miyoria.bridge.reflex.ReflexBrain.Threat;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ReflexBrainTest {
    private ReflexBrain brain;

    @BeforeEach
    void setUp() {
        brain = new ReflexBrain(new ReflexBrain.Config(true, true, true, 8f, 14, 6, 100));
    }

    /** A builder over the calm default: in a world, full health and food, nothing around. */
    private static final class S {
        boolean active = true, inLava, inFire, submerged, inWall, falling, hasFood = true, busy, pathing, breaking, drops;
        int air = 300, food = 20;
        float health = 20f;
        Threat threat;
        double x, y = 64, z;

        Sense get() {
            return new Sense(active, inLava, inFire, submerged, air, 300, inWall, falling, health, food, hasFood,
                    threat, busy, pathing, breaking, x, y, z, drops);
        }
    }

    private Step run(int ticks, S s) {
        Step last = null;
        for (int i = 0; i < ticks; i++) last = brain.tick(s.get());
        return last;
    }

    @Test
    void calmMeansNoReflex() {
        assertNull(brain.tick(new S().get()).active());
        assertFalse(brain.blocksRequests());
    }

    @Test
    void lavaStartsAnEscapeThatEndsAfterHalfASecondOutOfIt() {
        S s = new S();
        s.inLava = true;
        Step first = brain.tick(s.get());
        assertEquals(Kind.LAVA, first.started());
        assertTrue(brain.blocksRequests());
        s.inLava = false;
        for (int i = 0; i < 9; i++) assertEquals(Kind.LAVA, brain.tick(s.get()).active(), "tick " + i);
        Step end = brain.tick(s.get());
        assertEquals(Kind.LAVA, end.ended());
        assertTrue(end.endedOk());
        assertNull(end.active());
    }

    @Test
    void fightsWhenHealthyAndFleesWhenNot() {
        S s = new S();
        s.threat = new Threat("zombie", 3, false);
        assertEquals(Kind.FIGHT, brain.tick(s.get()).started());
        // hurt below the flee line: running away takes over
        s.health = 6f;
        Step step = brain.tick(s.get());
        assertEquals(Kind.FLEE, step.started());
        assertEquals(Kind.FIGHT, step.ended());
        assertFalse(step.endedOk());
        // the zombie is left behind: two seconds of calm end it
        s.threat = null;
        Step end = run(40, s);
        assertEquals(Kind.FLEE, end.ended());
    }

    @Test
    void neverFightsACreeperAndIgnoresFarHostiles() {
        S s = new S();
        s.threat = new Threat("zombie", 9, false);
        assertNull(brain.tick(s.get()).active());
        s.threat = new Threat("creeper", 3, true);
        assertEquals(Kind.FLEE, brain.tick(s.get()).started());
    }

    @Test
    void eatsWhenHungryAndIdleOrStarving() {
        S s = new S();
        s.food = 14;
        s.busy = true;
        assertNull(brain.tick(s.get()).active(), "busy and only a bit hungry: later");
        s.busy = false;
        assertEquals(Kind.EAT, brain.tick(s.get()).started());
        brain.finish(true);
        assertEquals(Kind.EAT, brain.tick(s.get()).ended());

        brain = new ReflexBrain(new ReflexBrain.Config(true, true, true, 8f, 14, 6, 100));
        s.busy = true;
        s.food = 6;
        assertEquals(Kind.EAT, brain.tick(s.get()).started(), "starving: stops the task to eat");
    }

    @Test
    void aMealThatFailedIsNotRetriedEveryTick() {
        S s = new S();
        s.food = 10;
        brain.tick(s.get());
        brain.finish(false);
        Step end = brain.tick(s.get());
        assertEquals(Kind.EAT, end.ended());
        assertFalse(end.endedOk());
        assertNull(run(150, s).active());
        assertEquals(Kind.EAT, run(60, s).active());
    }

    @Test
    void aTaskThatDoesNotMoveHerIsStuck() {
        S s = new S();
        s.busy = true;
        // standing next to a followed player (no path) is not stuck
        assertNull(run(300, s).active());
        s.pathing = true;
        assertNull(run(99, s).active());
        assertEquals(Kind.UNSTUCK, brain.tick(s.get()).started());
        brain.finish(true);
        assertEquals(Kind.UNSTUCK, brain.tick(s.get()).ended());
        // breaking blocks or walking is progress
        brain = new ReflexBrain(new ReflexBrain.Config(true, true, true, 8f, 14, 6, 100));
        for (int i = 0; i < 300; i++) {
            s.breaking = i % 50 == 0;
            assertNull(brain.tick(s.get()).active(), "tick " + i);
        }
    }

    @Test
    void picksUpDropsRightAfterATaskOnly() {
        S s = new S();
        s.busy = true;
        brain.tick(s.get());
        s.busy = false;
        s.drops = true;
        // not before Baritone has reported the end of her task
        assertNull(run(14, s).active());
        assertEquals(Kind.PICKUP, brain.tick(s.get()).started());
        assertFalse(brain.blocksRequests(), "a pickup never holds up her requests");
        assertEquals(Kind.PICKUP, brain.yieldNonUrgent());
        assertNull(brain.active());

        // drops lying around long after anything she did are not chased
        brain = new ReflexBrain(new ReflexBrain.Config(true, true, true, 8f, 14, 6, 100));
        assertNull(run(20, s).active());
    }

    @Test
    void urgentReflexesDoNotYield() {
        S s = new S();
        s.inWall = true;
        brain.tick(s.get());
        assertNull(brain.yieldNonUrgent());
        assertEquals(Kind.SUFFOCATION, brain.active());
    }

    @Test
    void drowningSwimsUpUntilThereIsAir() {
        S s = new S();
        s.submerged = true;
        s.air = 200;
        assertNull(brain.tick(s.get()).active(), "still plenty of air");
        s.air = 100;
        assertEquals(Kind.DROWNING, brain.tick(s.get()).started());
        s.submerged = false;
        assertEquals(Kind.DROWNING, brain.tick(s.get()).ended());
    }

    @Test
    void givesUpAfterMaxTicksAndStopsWhenSheLeaves() {
        S s = new S();
        s.inWall = true;
        Step last = run(Kind.SUFFOCATION.maxTicks + 2, s);
        assertEquals(Kind.SUFFOCATION, last.ended() != null ? last.ended() : last.active());
        // leaving the world (death, main menu) ends whatever is active
        brain.tick(s.get());
        s.active = false;
        Step end = brain.tick(s.get());
        assertNull(end.active());
    }

    @Test
    void switchedOffDoesNothing() {
        brain = new ReflexBrain(new ReflexBrain.Config(false, true, true, 8f, 14, 6, 100));
        S s = new S();
        s.inLava = true;
        assertNull(brain.tick(s.get()).active());
    }
}
