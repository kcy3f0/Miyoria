package dev.miyoria.bridge.reflex;

import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Decides every client tick, without the LLM, which survival reflex has her body: extinguish fire,
 * MLG water bucket, escape lava, suffocation, falling sand and drowning, pillar retreat, shield
 * block, fight (melee crit or bow) or flee by health, eat when hungry, place torches in dark
 * areas, get unstuck and pick up drops (Mindcraft's modes, mc_aiplayer's Safety Net). Pure logic,
 * no Minecraft types: the game side ({@code game.Reflexes}) samples a {@link Sense}, calls
 * {@link #tick} and carries out the active kind, reporting {@link #finish} for the kinds that end
 * on their own.
 *
 * <p>One reflex at a time. A more urgent danger takes over from a less urgent reflex; when a
 * reflex ends it may cool down before it can start again (a failed meal, an unstuck attempt).
 */
public final class ReflexBrain {

    /** In priority order: an urgent kind earlier in the list takes over from a later one. */
    public enum Kind {
        EXTINGUISH(true, 40),
        MLG_WATER(true, 60),
        LAVA(true, 200),
        SUFFOCATION(true, 200),
        FALLING_BLOCK(true, 30),
        DROWNING(true, 400),
        RETREAT_PILLAR(true, 80),
        SHIELD_BLOCK(true, 120),
        FLEE(true, 400),
        EAT(false, 100),
        FIGHT(true, 600),
        AUTO_TORCH(false, 30),
        UNSTUCK(false, 40),
        PICKUP(false, 300);

        /** Dangers: take over from other reflexes; requests wait until they end. */
        public final boolean urgent;
        /** Longest a reflex may run (ticks) before it is given up. */
        public final int maxTicks;

        Kind(boolean urgent, int maxTicks) {
            this.urgent = urgent;
            this.maxTicks = maxTicks;
        }

        /** Protocol id: {@code extinguish}, {@code mlg_water}, {@code lava}, ... */
        public String id() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /**
     * @param fleeHealth at or below this health she runs from hostiles instead of fighting
     * @param eatFood    she eats at or below this food level when nothing else is going on
     * @param eatFoodBusy she stops what she is doing to eat at or below this food level
     * @param stuckTicks a task that has not moved her (nor broken a block) this long is stuck
     */
    public record Config(boolean enabled, boolean fight, boolean pickup, float fleeHealth,
                         int eatFood, int eatFoodBusy, int stuckTicks) {
        public static final Config DEFAULT = new Config(true, true, true, 8f, 14, 6, 400);
    }

    /** Extended reflex configuration adding combat, MLG, auto-equip, and auto-torch options. */
    public record ReflexConfig(
            boolean enabled,
            boolean fight,
            boolean pickup,
            float fleeHealth,
            int eatFood,
            int eatFoodBusy,
            int stuckTicks,
            boolean autoEquip,
            boolean shieldBlock,
            boolean mlgWater,
            double mlgMinFallDistance,
            boolean autoTorch,
            int autoTorchMaxLight,
            boolean pillarEscape
    ) {
        public static final ReflexConfig DEFAULT = new ReflexConfig(
                true, true, true, 8f, 14, 6, 400,
                true, true, true, 4.0, true, 7, true);

        public ReflexConfig(Config base, boolean autoEquip, boolean shieldBlock, boolean mlgWater,
                            double mlgMinFallDistance, boolean autoTorch, int autoTorchMaxLight, boolean pillarEscape) {
            this(base.enabled(), base.fight(), base.pickup(), base.fleeHealth(),
                    base.eatFood(), base.eatFoodBusy(), base.stuckTicks(),
                    autoEquip, shieldBlock, mlgWater, mlgMinFallDistance, autoTorch, autoTorchMaxLight, pillarEscape);
        }

        public static ReflexConfig fromBase(Config base) {
            return new ReflexConfig(base, true, true, true, 4.0, true, 7, true);
        }

        public Config base() {
            return new Config(enabled, fight, pickup, fleeHealth, eatFood, eatFoodBusy, stuckTicks);
        }
    }

    /** The nearest hostile she can see. */
    public record Threat(String type, double distance, boolean creeper) {}

    /**
     * One tick of what her body feels.
     *
     * @param active    in a world, alive, not paused, and no other bot (AltoClef) driving
     * @param busy      a task of hers is running (Baritone, crafting, a held key), reflexes not counted
     * @param pathing   Baritone is walking a path for her task (standing by a followed player is not)
     * @param breaking  she is breaking a block right now (mining counts as progress)
     * @param dropsNearby an item on the ground she can see and pick up
     */
    public record Sense(
            boolean active, boolean inLava, boolean inFire, boolean submerged, int air, int maxAir,
            boolean inWall, boolean blockFalling, float health, int food, boolean hasFood,
            Threat threat, boolean busy, boolean pathing, boolean breaking,
            double x, double y, double z, boolean dropsNearby,
            boolean onFire, double fallDistance, double verticalSpeed, double groundDistance,
            boolean hasWaterBucket, boolean hasShield, boolean shieldOnCooldown, boolean hasBowAndArrow,
            int lightLevel, boolean hasTorch, boolean hasAdjacentTorchSpot,
            int buildingBlocks, boolean safeCeiling, boolean inWater,
            List<CombatLogic.Threat> threats
    ) {
        public Sense {
            threats = threats == null ? List.of() : List.copyOf(threats);
        }

        /** Backwards-compatible 19-arg constructor. */
        public Sense(boolean active, boolean inLava, boolean inFire, boolean submerged, int air, int maxAir,
                     boolean inWall, boolean blockFalling, float health, int food, boolean hasFood,
                     Threat threat, boolean busy, boolean pathing, boolean breaking,
                     double x, double y, double z, boolean dropsNearby) {
            this(active, inLava, inFire, submerged, air, maxAir, inWall, blockFalling, health, food, hasFood,
                    threat, busy, pathing, breaking, x, y, z, dropsNearby,
                    false, 0.0, 0.0, Double.POSITIVE_INFINITY,
                    false, false, false, false,
                    15, false, false, 0, false, submerged,
                    threat == null ? List.of() : List.of(new CombatLogic.Threat(threat.type(), threat.distance(), threat.creeper())));
        }
    }

    /** The reflex that has her body after this tick, and the ones that started / ended in it. */
    public record Step(Kind active, Kind started, Kind ended, boolean endedOk) {
        static final Step IDLE = new Step(null, null, null, false);
    }

    /** Ticks a task's drops stay worth picking up after it ended. */
    static final int PICKUP_WINDOW = 600;
    /**
     * Ticks after a task before a pickup starts: Baritone reports its idle 10 ticks after it
     * stops, and a pickup walking before that would swallow the end of her task.
     */
    static final int PICKUP_DELAY = 15;
    private static final int NEVER = Integer.MAX_VALUE / 2;

    private final ReflexConfig cfg;
    private final Map<Kind, Long> cooldownUntil = new EnumMap<>(Kind.class);
    private long tick;
    private Kind active;
    private int activeTicks;
    /** Ticks in a row the active reflex's danger was gone (ends it with some hysteresis). */
    private int calm;
    /** Set by {@link #finish}: the active reflex is done (ok / not ok). */
    private Boolean finished;

    private double ax, ay, az;
    private int stillTicks;
    private int sinceTask = NEVER;

    public ReflexBrain(Config cfg) {
        this(ReflexConfig.fromBase(cfg));
    }

    public ReflexBrain(ReflexConfig cfg) {
        this.cfg = cfg;
    }

    public Config config() {
        return cfg.base();
    }

    public ReflexConfig reflexConfig() {
        return cfg;
    }

    public Kind active() {
        return active;
    }

    /**
     * Whether a reflex is a transient interrupt from which an active task (such as Baritone)
     * can safely be resumed once it finishes successfully.
     */
    public static boolean isRecoverable(Kind kind) {
        if (kind == null) return false;
        return switch (kind) {
            case EAT, FIGHT, SHIELD_BLOCK, EXTINGUISH, AUTO_TORCH, UNSTUCK, PICKUP -> true;
            case MLG_WATER, LAVA, SUFFOCATION, FALLING_BLOCK, DROWNING, RETREAT_PILLAR, FLEE -> false;
        };
    }

    /** Timed-out or failed reflexes ({@code endedOk == false}) are never recoverable. */
    public static boolean isRecoverable(Kind kind, boolean endedOk) {
        return endedOk && isRecoverable(kind);
    }

    /** Requests wait while any reflex but a pickup has her body. */
    public boolean blocksRequests() {
        return active != null && active != Kind.PICKUP;
    }

    /** The game side finished the active reflex (eaten, freed, nothing left to pick up). */
    public void finish(boolean ok) {
        if (active != null) finished = ok;
    }

    /**
     * Ends the active reflex if it is not urgent (a request or {@code stop} wants her body);
     * returns what was ended, or null.
     */
    public Kind yieldNonUrgent() {
        if (active == null || active.urgent) return null;
        Kind k = active;
        end(k, false);
        return k;
    }

    public Step tick(Sense s) {
        tick++;
        if (!cfg.enabled() || !s.active()) {
            anchor(s);
            sinceTask = NEVER;
            if (active == null) return Step.IDLE;
            Kind k = active;
            end(k, false);
            return new Step(null, null, k, false);
        }
        trackStuck(s);
        if (s.busy()) sinceTask = 0;
        else if (sinceTask < NEVER) sinceTask++;

        Kind want = wanted(s);
        if (active == null) {
            if (want == null) return Step.IDLE;
            begin(want);
            return new Step(want, want, null, false);
        }
        activeTicks++;
        Kind current = active;
        if (want != null && want != current && want.urgent && want.ordinal() < current.ordinal()) {
            end(current, false);
            begin(want);
            return new Step(want, want, current, false);
        }
        if (finished != null) {
            boolean ok = finished;
            end(current, ok);
            return new Step(null, null, current, ok);
        }
        if (activeTicks > current.maxTicks) {
            end(current, false);
            return new Step(null, null, current, false);
        }
        if (!continues(current, s)) {
            end(current, true);
            return new Step(null, null, current, true);
        }
        return new Step(current, null, null, false);
    }

    /** The most urgent reflex whose trigger holds now (and that is not cooling down), or null. */
    private Kind wanted(Sense s) {
        List<CombatLogic.Threat> threats = effectiveThreats(s);
        CombatLogic.Decision combat = threats.isEmpty() ? CombatLogic.Decision.IDLE : CombatLogic.decide(toCombatState(s, threats));

        for (Kind k : Kind.values()) {
            if (tick < cooldownUntil.getOrDefault(k, 0L)) continue;
            boolean want = switch (k) {
                case EXTINGUISH -> s.hasWaterBucket() && s.onFire() && !s.inLava() && !s.submerged();
                case MLG_WATER -> cfg.mlgWater() && s.hasWaterBucket() && !s.inWater() && !s.submerged()
                        && s.fallDistance() >= cfg.mlgMinFallDistance()
                        && s.verticalSpeed() < -0.55
                        && s.groundDistance() >= 1.5 && s.groundDistance() <= 4.5;
                case LAVA -> s.inLava() || s.inFire();
                case SUFFOCATION -> s.inWall();
                case FALLING_BLOCK -> s.blockFalling();
                case DROWNING -> s.submerged() && s.air() < s.maxAir() * 0.4;
                case RETREAT_PILLAR -> cfg.pillarEscape() && combat.mode() == CombatLogic.Mode.RETREAT_PILLAR;
                case SHIELD_BLOCK -> cfg.shieldBlock() && CombatLogic.shouldShieldBlock(threats, s.hasShield(), s.shieldOnCooldown());
                case FLEE -> shouldFlee(s, threats);
                case EAT -> s.hasFood() && (s.food() <= cfg.eatFoodBusy() || (!s.busy() && s.food() <= cfg.eatFood()));
                case FIGHT -> cfg.fight() && s.health() > cfg.fleeHealth() && wantsFight(s, threats, combat);
                case AUTO_TORCH -> cfg.autoTorch() && s.hasTorch() && s.hasAdjacentTorchSpot()
                        && !s.inLava() && !s.inWater() && !s.submerged()
                        && s.lightLevel() <= cfg.autoTorchMaxLight();
                case UNSTUCK -> s.pathing() && stillTicks >= cfg.stuckTicks();
                case PICKUP -> cfg.pickup() && !s.busy() && s.dropsNearby()
                        && sinceTask >= PICKUP_DELAY && sinceTask <= PICKUP_WINDOW;
            };
            if (want) return k;
        }
        return null;
    }

    /** Whether the active reflex goes on (its danger has not been gone for long enough). */
    private boolean continues(Kind k, Sense s) {
        List<CombatLogic.Threat> threats = effectiveThreats(s);
        if (k == Kind.SHIELD_BLOCK && (!cfg.shieldBlock() || !s.hasShield() || s.shieldOnCooldown())) {
            return false;
        }
        boolean danger = switch (k) {
            case EXTINGUISH -> s.onFire() && !s.inLava() && !s.submerged();
            case MLG_WATER -> s.fallDistance() > 0.0 || activeTicks < 10;
            case LAVA -> s.inLava() || s.inFire();
            case SUFFOCATION -> s.inWall();
            case FALLING_BLOCK -> activeTicks < 15 || s.blockFalling();
            case DROWNING -> s.submerged() && s.air() < s.maxAir() * 0.9;
            case RETREAT_PILLAR, EAT, AUTO_TORCH, UNSTUCK -> true; // until finish() or timeout
            case SHIELD_BLOCK -> CombatLogic.shouldShieldBlock(threats, s.hasShield(), s.shieldOnCooldown());
            case FLEE -> threats.stream().anyMatch(t -> t.distance() < (t.creeper() ? 10 : 14));
            case FIGHT -> s.health() > cfg.fleeHealth() && continuesFight(s, threats);
            case PICKUP -> s.dropsNearby() && !s.busy();
        };
        calm = danger ? 0 : calm + 1;
        int need = switch (k) {
            case EXTINGUISH -> 5;
            case LAVA -> 10; // off the lava and the fire for half a second
            case SHIELD_BLOCK -> 10;
            case FLEE -> 40;
            case FIGHT -> 20;
            case PICKUP -> 10;
            default -> 1;
        };
        return calm < need;
    }

    private static List<CombatLogic.Threat> effectiveThreats(Sense s) {
        if (!s.threats().isEmpty()) return s.threats();
        if (s.threat() == null) return List.of();
        Threat t = s.threat();
        return List.of(new CombatLogic.Threat(t.type(), t.distance(), t.creeper()));
    }

    private CombatLogic.State toCombatState(Sense s, List<CombatLogic.Threat> threats) {
        return new CombatLogic.State(
                s.health(), cfg.fleeHealth(), 1.0f, true, s.inWater() || s.submerged(),
                s.hasShield(), s.shieldOnCooldown(), s.hasBowAndArrow(),
                s.buildingBlocks(), s.safeCeiling(),
                cfg.fight(), cfg.shieldBlock(), cfg.pillarEscape(),
                tick, threats);
    }

    private boolean shouldFlee(Sense s, List<CombatLogic.Threat> threats) {
        for (CombatLogic.Threat t : threats) {
            if (t.creeper() && t.distance() <= CombatLogic.CREEPER_FLEE_RANGE) return true;
            if (s.health() <= cfg.fleeHealth() && t.distance() <= CombatLogic.LOW_HP_FLEE_RANGE) return true;
        }
        return false;
    }

    private static boolean wantsFight(Sense s, List<CombatLogic.Threat> threats, CombatLogic.Decision combat) {
        if (combat.mode() == CombatLogic.Mode.BOW_SHOT && s.hasBowAndArrow()) return true;
        for (CombatLogic.Threat t : threats) {
            if (!t.creeper() && t.distance() <= CombatLogic.MELEE_START_RANGE) return true;
        }
        return false;
    }

    private static boolean continuesFight(Sense s, List<CombatLogic.Threat> threats) {
        for (CombatLogic.Threat t : threats) {
            if (!t.creeper() && t.distance() <= CombatLogic.MELEE_CONTINUE_RANGE) return true;
            if (s.hasBowAndArrow() && t.distance() >= CombatLogic.BOW_MIN_RANGE && t.distance() <= CombatLogic.BOW_MAX_RANGE) {
                return true;
            }
        }
        return false;
    }

    private void begin(Kind k) {
        active = k;
        activeTicks = 0;
        calm = 0;
        finished = null;
    }

    private void end(Kind k, boolean ok) {
        active = null;
        finished = null;
        int cooldown = switch (k) {
            case EXTINGUISH -> ok ? 10 : 40;
            case MLG_WATER -> ok ? 10 : 20;
            case RETREAT_PILLAR -> ok ? 100 : 120;
            case SHIELD_BLOCK -> ok ? 4 : 15;
            case EAT -> ok ? 20 : 200; // a meal that did not work is not retried every tick
            case AUTO_TORCH -> ok ? 40 : 100;
            case UNSTUCK -> 100;
            case PICKUP -> ok ? 40 : 200;
            case FIGHT -> ok ? 0 : 60; // a fight that ran out of time: flee or ignore for a while
            default -> 0;
        };
        if (cooldown > 0) cooldownUntil.put(k, tick + cooldown);
        if (k == Kind.UNSTUCK) stillTicks = 0;
    }

    private void trackStuck(Sense s) {
        double dx = s.x() - ax, dy = s.y() - ay, dz = s.z() - az;
        if (!s.pathing() || s.breaking() || dx * dx + dy * dy + dz * dz > 1.0) {
            anchor(s);
        } else {
            stillTicks++;
        }
    }

    private void anchor(Sense s) {
        ax = s.x();
        ay = s.y();
        az = s.z();
        stillTicks = 0;
    }
}
