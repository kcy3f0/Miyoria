package dev.miyoria.bridge.reflex;

import java.util.EnumMap;
import java.util.Locale;
import java.util.Map;

/**
 * Decides every client tick, without the LLM, which survival reflex has her body: escape lava,
 * suffocation, falling sand and drowning, fight or flee by health, eat when hungry, get unstuck
 * and pick up drops (Mindcraft's modes, mc_aiplayer's Safety Net). Pure logic, no Minecraft
 * types: the game side ({@code game.Reflexes}) samples a {@link Sense}, calls {@link #tick} and
 * carries out the active kind, reporting {@link #finish} for the kinds that end on their own.
 *
 * <p>One reflex at a time. A more urgent danger takes over from a less urgent reflex; when a
 * reflex ends it may cool down before it can start again (a failed meal, an unstuck attempt).
 */
public final class ReflexBrain {

    /** In priority order: an urgent kind earlier in the list takes over from a later one. */
    public enum Kind {
        LAVA(true, 200),
        SUFFOCATION(true, 200),
        FALLING_BLOCK(true, 30),
        DROWNING(true, 400),
        FLEE(true, 400),
        FIGHT(true, 600),
        EAT(false, 100),
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

        /** Protocol id: {@code lava}, {@code falling_block}, ... */
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
    public record Sense(boolean active, boolean inLava, boolean inFire, boolean submerged, int air, int maxAir,
                        boolean inWall, boolean blockFalling, float health, int food, boolean hasFood,
                        Threat threat, boolean busy, boolean pathing, boolean breaking,
                        double x, double y, double z, boolean dropsNearby) {}

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

    private final Config cfg;
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
        this.cfg = cfg;
    }

    public Config config() {
        return cfg;
    }

    public Kind active() {
        return active;
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
        Threat t = s.threat();
        for (Kind k : Kind.values()) {
            if (tick < cooldownUntil.getOrDefault(k, 0L)) continue;
            boolean want = switch (k) {
                case LAVA -> s.inLava() || s.inFire();
                case SUFFOCATION -> s.inWall();
                case FALLING_BLOCK -> s.blockFalling();
                case DROWNING -> s.submerged() && s.air() < s.maxAir() * 0.4;
                case FLEE -> t != null && ((t.creeper() && t.distance() <= 6)
                        || (s.health() <= cfg.fleeHealth() && t.distance() <= 10));
                case FIGHT -> cfg.fight() && t != null && !t.creeper() && t.distance() <= 4
                        && s.health() > cfg.fleeHealth();
                case EAT -> s.hasFood() && (s.food() <= cfg.eatFoodBusy() || (!s.busy() && s.food() <= cfg.eatFood()));
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
        Threat t = s.threat();
        boolean danger = switch (k) {
            case LAVA -> s.inLava() || s.inFire();
            case SUFFOCATION -> s.inWall();
            case FALLING_BLOCK -> activeTicks < 15 || s.blockFalling();
            case DROWNING -> s.submerged() && s.air() < s.maxAir() * 0.9;
            case FLEE -> t != null && t.distance() < (t.creeper() ? 10 : 14);
            case FIGHT -> t != null && !t.creeper() && t.distance() <= 6;
            case EAT, UNSTUCK -> true; // until finish()
            case PICKUP -> s.dropsNearby() && !s.busy();
        };
        calm = danger ? 0 : calm + 1;
        int need = switch (k) {
            case LAVA -> 10; // off the lava and the fire for half a second
            case FLEE -> 40;
            case FIGHT -> 20;
            case PICKUP -> 10;
            default -> 1;
        };
        return calm < need;
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
            case EAT -> ok ? 20 : 200; // a meal that did not work is not retried every tick
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
