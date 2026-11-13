package dev.miyoria.bridge;

import dev.miyoria.bridge.reflex.CombatLogic;
import dev.miyoria.bridge.reflex.CombatLogic.Decision;
import dev.miyoria.bridge.reflex.CombatLogic.Mode;
import dev.miyoria.bridge.reflex.CombatLogic.State;
import dev.miyoria.bridge.reflex.CombatLogic.Threat;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class CombatLogicTest {

    @Test
    void shieldBlockTriggeredByAimingRangedMobAndRespectsCooldown() {
        Threat skeletonAiming = new Threat("skeleton", 11.0, false, 0f, true);
        State ready = new State(20f, 8f, 1.0f, true, false, true, false, false, 0, false, 0, List.of(skeletonAiming));
        Decision d1 = CombatLogic.decide(ready);
        assertEquals(Mode.SHIELD_BLOCK, d1.mode());
        assertTrue(d1.raiseShield());

        Threat pillager = new Threat("pillager", 16.0, false, 0f, true);
        State pReady = new State(20f, 8f, 1.0f, true, false, true, false, false, 0, false, 0, List.of(pillager));
        assertEquals(Mode.SHIELD_BLOCK, CombatLogic.decide(pReady).mode());

        // Shield on cooldown cannot block
        State cooling = new State(20f, 8f, 1.0f, true, false, true, true, false, 0, false, 0, List.of(skeletonAiming));
        assertNotEquals(Mode.SHIELD_BLOCK, CombatLogic.decide(cooling).mode());
    }

    @Test
    void shieldBlockTriggeredBySwellingOrVeryCloseCreeper() {
        Threat swelling = new Threat("creeper", 4.8, true, 0.35f, false);
        State s1 = new State(20f, 8f, 1.0f, true, false, true, false, false, 0, false, 0, List.of(swelling));
        assertEquals(Mode.SHIELD_BLOCK, CombatLogic.decide(s1).mode());

        Threat veryClose = new Threat("creeper", 3.0, true, 0.0f, false);
        State s2 = new State(20f, 8f, 1.0f, true, false, true, false, false, 0, false, 0, List.of(veryClose));
        assertEquals(Mode.SHIELD_BLOCK, CombatLogic.decide(s2).mode());

        // Without shield, creeper triggers FLEE
        State noShield = new State(20f, 8f, 1.0f, true, false, false, false, false, 0, false, 0, List.of(veryClose));
        assertEquals(Mode.FLEE, CombatLogic.decide(noShield).mode());
    }

    @Test
    void pillarRetreatWhenOutnumberedOrLowHpWithCeilingAndBlocks() {
        List<Threat> crowd = List.of(
                new Threat("zombie", 2.5, false),
                new Threat("zombie", 3.8, false),
                new Threat("skeleton", 5.2, false)
        );
        State canPillar = new State(18f, 8f, 1.0f, true, false, true, false, false, 8, true, 0, crowd);
        assertEquals(Mode.RETREAT_PILLAR, CombatLogic.decide(canPillar).mode());

        State noCeiling = new State(18f, 8f, 1.0f, true, false, false, false, false, 8, false, 0, crowd);
        assertNotEquals(Mode.RETREAT_PILLAR, CombatLogic.decide(noCeiling).mode());

        State tooFewBlocks = new State(18f, 8f, 1.0f, true, false, false, false, false, 2, true, 0, crowd);
        assertNotEquals(Mode.RETREAT_PILLAR, CombatLogic.decide(tooFewBlocks).mode());

        // Low HP single zombie -> pillar if safe ceiling + blocks >= 3, else FLEE
        List<Threat> oneClose = List.of(new Threat("zombie", 4.0, false));
        State lowHpPillar = new State(6f, 8f, 1.0f, true, false, false, false, false, 4, true, 0, oneClose);
        assertEquals(Mode.RETREAT_PILLAR, CombatLogic.decide(lowHpPillar).mode());

        State lowHpFlee = new State(6f, 8f, 1.0f, true, false, false, false, false, 1, true, 0, oneClose);
        assertEquals(Mode.FLEE, CombatLogic.decide(lowHpFlee).mode());
    }

    @Test
    void bowShotAtRangeAndMeleeCritWithStrafeCloseUp() {
        Threat midZombie = new Threat("zombie", 10.0, false);
        State withBow = new State(20f, 8f, 1.0f, true, false, false, false, true, 0, false, 5, List.of(midZombie));
        Decision bowDec = CombatLogic.decide(withBow);
        assertEquals(Mode.BOW_SHOT, bowDec.mode());
        assertTrue(bowDec.drawBow());
        assertTrue(bowDec.strafe());
        assertEquals(1, bowDec.strafeSign());

        // Close range switches to melee crit + jump
        Threat closeZombie = new Threat("zombie", 2.5, false);
        State meleeTick0 = new State(20f, 8f, 0.95f, true, false, false, false, true, 0, false, 5, List.of(closeZombie));
        Decision critDec = CombatLogic.decide(meleeTick0);
        assertEquals(Mode.MELEE_CRIT, critDec.mode());
        assertTrue(critDec.jumpCrit());
        assertTrue(critDec.strikeReady());
        assertTrue(critDec.strafe());
        assertEquals(1, critDec.strafeSign());

        // Cooldown not recharged yet: no crit jump / strike
        State coolingSwing = new State(20f, 8f, 0.4f, true, false, false, false, false, 0, false, 25, List.of(closeZombie));
        Decision waitDec = CombatLogic.decide(coolingSwing);
        assertEquals(Mode.MELEE_CRIT, waitDec.mode());
        assertFalse(waitDec.jumpCrit());
        assertFalse(waitDec.strikeReady());
        // Strafe reverses direction every 20 ticks
        assertEquals(-1, waitDec.strafeSign());
    }
}
