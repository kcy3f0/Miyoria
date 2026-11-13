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

    @Test
    void extinguishPreemptsLavaAndMlgWaterTriggersBeforeImpact() {
        ReflexBrain extBrain = new ReflexBrain(ReflexBrain.ReflexConfig.DEFAULT);

        // On fire with water bucket beats FLEE / LAVA priority-wise
        Sense burning = new Sense(true, false, true, false, 300, 300, false, false, 16f, 20, true,
                new Threat("zombie", 3.0, false), true, false, false, 0, 64, 0, false,
                true, 0.0, 0.0, Double.POSITIVE_INFINITY,
                true, false, false, false, 15, false, false, 0, false, false, java.util.List.of());
        assertEquals(Kind.EXTINGUISH, extBrain.tick(burning).started());
        assertTrue(ReflexBrain.isRecoverable(Kind.EXTINGUISH));

        // Falling fast into ground triggers MLG_WATER (non-recoverable)
        ReflexBrain mlgBrain = new ReflexBrain(ReflexBrain.ReflexConfig.DEFAULT);
        Sense falling = new Sense(true, false, false, false, 300, 300, false, false, 20f, 20, true,
                null, false, false, false, 0, 70, 0, false,
                false, 8.0, -0.8, 3.0,
                true, false, false, false, 15, false, false, 0, false, false, java.util.List.of());
        assertEquals(Kind.MLG_WATER, mlgBrain.tick(falling).started());
        assertFalse(ReflexBrain.isRecoverable(Kind.MLG_WATER));
    }

    @Test
    void pillarRetreatShieldBlockAndAutoTorchHonorPrioritiesAndConfig() {
        ReflexBrain combatBrain = new ReflexBrain(ReflexBrain.ReflexConfig.DEFAULT);

        // Aiming skeleton triggers SHIELD_BLOCK over FIGHT
        var aimingSkeleton = new dev.miyoria.bridge.reflex.CombatLogic.Threat("skeleton", 10.0, false, 0f, true);
        var meleeZombie = new dev.miyoria.bridge.reflex.CombatLogic.Threat("zombie", 3.0, false);
        Sense rangedSense = new Sense(true, false, false, false, 300, 300, false, false, 20f, 20, true,
                null, true, false, false, 0, 64, 0, false,
                false, 0.0, 0.0, Double.POSITIVE_INFINITY,
                false, true, false, false, 15, false, false, 0, false, false,
                java.util.List.of(aimingSkeleton, meleeZombie));
        assertEquals(Kind.SHIELD_BLOCK, combatBrain.tick(rangedSense).started());
        assertTrue(ReflexBrain.isRecoverable(Kind.SHIELD_BLOCK));

        // Crowded (>=3 within 6m) with safe ceiling & blocks >= 3 preempts SHIELD_BLOCK with RETREAT_PILLAR
        var crowded = java.util.List.of(
                aimingSkeleton,
                new dev.miyoria.bridge.reflex.CombatLogic.Threat("zombie", 2.5, false),
                new dev.miyoria.bridge.reflex.CombatLogic.Threat("zombie", 3.5, false),
                new dev.miyoria.bridge.reflex.CombatLogic.Threat("spider", 4.5, false)
        );
        Sense pillarSense = new Sense(true, false, false, false, 300, 300, false, false, 20f, 20, true,
                null, true, false, false, 0, 64, 0, false,
                false, 0.0, 0.0, Double.POSITIVE_INFINITY,
                false, true, false, false, 15, false, false, 12, true, false, crowded);
        Step escalate = combatBrain.tick(pillarSense);
        assertEquals(Kind.RETREAT_PILLAR, escalate.started());
        assertEquals(Kind.SHIELD_BLOCK, escalate.ended());
        assertFalse(ReflexBrain.isRecoverable(Kind.RETREAT_PILLAR));

        // Dark area with torch + spot triggers AUTO_TORCH; lit area does not
        ReflexBrain torchBrain = new ReflexBrain(ReflexBrain.ReflexConfig.DEFAULT);
        Sense lit = new Sense(true, false, false, false, 300, 300, false, false, 20f, 20, true,
                null, true, false, false, 0, 64, 0, false,
                false, 0.0, 0.0, Double.POSITIVE_INFINITY,
                false, false, false, false, 8, true, true, 0, false, false, java.util.List.of());
        assertNull(torchBrain.tick(lit).active());
        Sense dark = new Sense(true, false, false, false, 300, 300, false, false, 20f, 20, true,
                null, true, false, false, 0, 64, 0, false,
                false, 0.0, 0.0, Double.POSITIVE_INFINITY,
                false, false, false, false, 5, true, true, 0, false, false, java.util.List.of());
        assertEquals(Kind.AUTO_TORCH, torchBrain.tick(dark).started());
        assertFalse(Kind.AUTO_TORCH.urgent);
        assertTrue(ReflexBrain.isRecoverable(Kind.AUTO_TORCH));

        // Toggles in ReflexConfig disable features cleanly
        var disabledAll = new ReflexBrain.ReflexConfig(
                new ReflexBrain.Config(true, false, true, 8f, 14, 6, 100),
                false, false, false, 4.0, false, 7, false);
        ReflexBrain toggledOff = new ReflexBrain(disabledAll);
        assertNull(toggledOff.tick(dark).active());
        assertNull(toggledOff.tick(pillarSense).active());
        Sense falling = new Sense(true, false, false, false, 300, 300, false, false, 20f, 20, true,
                null, false, false, false, 0, 70, 0, false,
                false, 8.0, -0.8, 3.0,
                true, false, false, false, 15, false, false, 0, false, false, java.util.List.of());
        assertNull(toggledOff.tick(falling).active());
    }

    @Test
    void isRecoverableClassificationAndTimeoutRule() {
        for (Kind k : java.util.List.of(Kind.EXTINGUISH, Kind.EAT, Kind.FIGHT, Kind.SHIELD_BLOCK,
                Kind.AUTO_TORCH, Kind.UNSTUCK, Kind.PICKUP)) {
            assertTrue(ReflexBrain.isRecoverable(k), k + " should be recoverable");
            assertTrue(ReflexBrain.isRecoverable(k, true), k + " with ok=true should be recoverable");
            assertFalse(ReflexBrain.isRecoverable(k, false), k + " timeout/failure must not be recoverable");
        }
        for (Kind k : java.util.List.of(Kind.MLG_WATER, Kind.LAVA, Kind.SUFFOCATION, Kind.FALLING_BLOCK,
                Kind.DROWNING, Kind.RETREAT_PILLAR, Kind.FLEE)) {
            assertFalse(ReflexBrain.isRecoverable(k), k + " should be non-recoverable");
            assertFalse(ReflexBrain.isRecoverable(k, true), k + " should remain non-recoverable");
        }
        assertFalse(ReflexBrain.isRecoverable(null));
    }
}
