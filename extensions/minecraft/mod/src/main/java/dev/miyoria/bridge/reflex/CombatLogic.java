package dev.miyoria.bridge.reflex;

import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * Pure-Java tactical combat evaluator. Decides human-like combat behavior (shield blocking,
 * jump-crit melee with strafing, ballistic bow shooting, emergency pillar retreat, or sprint flee)
 * without touching {@code net.minecraft.*} types.
 */
public final class CombatLogic {
    public static final double MELEE_START_RANGE = 4.0;
    public static final double MELEE_CONTINUE_RANGE = 6.0;
    public static final double MELEE_STRIKE_RANGE = 3.0;
    public static final double BOW_MIN_RANGE = 5.0;
    public static final double BOW_MAX_RANGE = 18.0;
    public static final double PILLAR_CROWD_RANGE = 6.0;
    public static final int PILLAR_CROWD_COUNT = 3;
    public static final int PILLAR_MIN_BLOCKS = 3;
    public static final float CREEPER_SWELL_THRESHOLD = 0.2f;
    public static final double CREEPER_SHIELD_RANGE = 3.5;
    public static final double CREEPER_FLEE_RANGE = 6.0;
    public static final double LOW_HP_FLEE_RANGE = 10.0;
    public static final double RANGED_SHIELD_RANGE = 20.0;
    public static final float CRIT_COOLDOWN_THRESHOLD = 0.9f;

    public enum Mode {
        NONE,
        SHIELD_BLOCK,
        RETREAT_PILLAR,
        FLEE,
        MELEE_CRIT,
        MELEE_APPROACH,
        BOW_SHOT
    }

    public record Threat(
            String type,
            double distance,
            double dx,
            double dy,
            double dz,
            boolean creeper,
            float fuseProgress,
            boolean rangedAiming,
            boolean lineOfSight
    ) {
        public Threat {
            type = type == null ? "unknown" : type.toLowerCase(Locale.ROOT);
        }

        public Threat(String type, double distance, boolean creeper) {
            this(type, distance, 0.0, 0.0, distance, creeper, 0f, false, true);
        }

        public Threat(String type, double distance, boolean creeper, float fuseProgress, boolean rangedAiming) {
            this(type, distance, 0.0, 0.0, distance, creeper, fuseProgress, rangedAiming, true);
        }

        public boolean isSwellingCreeper() {
            return creeper && (fuseProgress > CREEPER_SWELL_THRESHOLD || distance <= CREEPER_SHIELD_RANGE);
        }

        public boolean isRangedThreat() {
            return rangedAiming && distance <= RANGED_SHIELD_RANGE;
        }
    }

    public record State(
            float health,
            float fleeHealth,
            float attackCooldown,
            boolean onGround,
            boolean inWater,
            boolean hasShield,
            boolean shieldOnCooldown,
            boolean hasBowAndArrow,
            int buildingBlocks,
            boolean safeCeiling,
            boolean allowFight,
            boolean allowShieldBlock,
            boolean allowPillarEscape,
            long combatTicks,
            List<Threat> threats
    ) {
        public State(float health, float fleeHealth, float attackCooldown, boolean onGround, boolean inWater,
                     boolean hasShield, boolean shieldOnCooldown, boolean hasBowAndArrow,
                     int buildingBlocks, boolean safeCeiling, long combatTicks, List<Threat> threats) {
            this(health, fleeHealth, attackCooldown, onGround, inWater,
                    hasShield, shieldOnCooldown, hasBowAndArrow,
                    buildingBlocks, safeCeiling, true, true, true, combatTicks, threats);
        }
    }

    public record Decision(
            Mode mode,
            Threat target,
            boolean jumpCrit,
            boolean strikeReady,
            boolean strafe,
            int strafeSign,
            boolean raiseShield,
            boolean drawBow
    ) {
        public static final Decision IDLE = new Decision(Mode.NONE, null, false, false, false, 0, false, false);
    }

    private CombatLogic() {}

    public static Decision decide(State s) {
        if (s == null || s.threats() == null || s.threats().isEmpty()) {
            return Decision.IDLE;
        }
        List<Threat> visible = s.threats().stream()
                .filter(t -> t != null && t.lineOfSight() && Double.isFinite(t.distance()) && t.distance() >= 0)
                .sorted(Comparator.comparingDouble(Threat::distance))
                .toList();
        if (visible.isEmpty()) {
            return Decision.IDLE;
        }

        Threat nearestAny = visible.get(0);
        Threat swellingCreeper = visible.stream().filter(Threat::isSwellingCreeper).findFirst().orElse(null);
        Threat rangedThreat = visible.stream().filter(Threat::isRangedThreat).findFirst().orElse(null);
        Threat closeCreeper = visible.stream().filter(t -> t.creeper() && t.distance() <= CREEPER_FLEE_RANGE).findFirst().orElse(null);
        Threat closeMelee = visible.stream().filter(t -> !t.creeper() && t.distance() <= MELEE_CONTINUE_RANGE).findFirst().orElse(null);
        Threat bowTarget = visible.stream()
                .filter(t -> t.distance() >= BOW_MIN_RANGE && t.distance() <= BOW_MAX_RANGE)
                .findFirst()
                .orElse(null);

        long hostilesWithin6m = visible.stream().filter(t -> t.distance() <= PILLAR_CROWD_RANGE).count();
        boolean canShield = s.allowShieldBlock() && s.hasShield() && !s.shieldOnCooldown();

        // 1. Swelling creeper right beside player: raising shield mitigates blast immediately.
        if (canShield && swellingCreeper != null) {
            return new Decision(Mode.SHIELD_BLOCK, swellingCreeper, false, false, false, 0, true, false);
        }

        // 2. Pillar escape when outnumbered (>=3 within 6m) or low HP with safe headroom and blocks.
        if (shouldPillarRetreat(s, hostilesWithin6m, nearestAny, closeCreeper)) {
            return new Decision(Mode.RETREAT_PILLAR, nearestAny, false, false, false, 0, false, false);
        }

        // 3. Shield block against aiming skeletons/pillagers.
        if (canShield && rangedThreat != null) {
            return new Decision(Mode.SHIELD_BLOCK, rangedThreat, false, false, false, 0, true, false);
        }

        // 4. Sprint flee from close creepers or when low HP without pillar option.
        if (closeCreeper != null || (s.health() <= s.fleeHealth() && nearestAny.distance() <= LOW_HP_FLEE_RANGE)) {
            Threat fleeFrom = closeCreeper != null ? closeCreeper : nearestAny;
            return new Decision(Mode.FLEE, fleeFrom, false, false, false, 0, false, false);
        }

        if (!s.allowFight() || s.health() <= s.fleeHealth()) {
            return Decision.IDLE;
        }

        int strafeSign = ((s.combatTicks() / 20L) % 2L == 0L) ? 1 : -1;

        // 5. Bow combat at 5..18m when no non-creeper mob is already inside melee brawl range.
        boolean closeMeleeUrgent = closeMelee != null && closeMelee.distance() <= MELEE_START_RANGE;
        if (s.hasBowAndArrow() && !closeMeleeUrgent && bowTarget != null) {
            return new Decision(Mode.BOW_SHOT, bowTarget, false, false, true, strafeSign, false, true);
        }

        // 6. Melee combat with strafe + jump-crit timing.
        if (closeMelee != null) {
            double d = closeMelee.distance();
            boolean inCritZone = d <= MELEE_STRIKE_RANGE + 0.5;
            boolean wantJumpCrit = inCritZone && s.onGround() && !s.inWater()
                    && s.attackCooldown() >= CRIT_COOLDOWN_THRESHOLD - 0.05f;
            boolean strikeReady = d <= MELEE_STRIKE_RANGE && s.attackCooldown() >= CRIT_COOLDOWN_THRESHOLD;
            Mode mode = d <= MELEE_STRIKE_RANGE + 0.2 ? Mode.MELEE_CRIT : Mode.MELEE_APPROACH;
            return new Decision(mode, closeMelee, wantJumpCrit, strikeReady, true, strafeSign, false, false);
        }

        return Decision.IDLE;
    }

    public static boolean shouldPillarRetreat(State s, long hostilesWithin6m, Threat nearestAny, Threat closeCreeper) {
        if (!s.allowPillarEscape() || !s.safeCeiling() || s.buildingBlocks() < PILLAR_MIN_BLOCKS || s.inWater()) {
            return false;
        }
        if (hostilesWithin6m >= PILLAR_CROWD_COUNT) {
            return closeCreeper == null || closeCreeper.fuseProgress() <= CREEPER_SWELL_THRESHOLD;
        }
        return s.health() <= s.fleeHealth()
                && nearestAny != null
                && nearestAny.distance() <= LOW_HP_FLEE_RANGE
                && closeCreeper == null;
    }

    public static boolean shouldShieldBlock(List<Threat> threats, boolean hasShield, boolean shieldOnCooldown) {
        if (!hasShield || shieldOnCooldown || threats == null || threats.isEmpty()) return false;
        for (Threat t : threats) {
            if (t == null || !t.lineOfSight()) continue;
            if (t.isSwellingCreeper() || t.isRangedThreat()) return true;
        }
        return false;
    }
}
