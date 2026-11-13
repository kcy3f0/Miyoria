package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;

/**
 * What the rest of the mod needs from Baritone. The implementation (the only class that touches
 * {@code baritone.api.*}) is loaded only when the Baritone mod is present.
 * All methods run on the client thread.
 */
public interface BaritoneBridge {
    double DEFAULT_MAX_PAUSE_DRIFT = 16.0;
    long DEFAULT_MAX_PAUSE_MS = 15_000L;

    /** Execute a {@code baritone} request (goto/mine/follow/explore/farm/build/stop/raw). */
    JsonObject execute(Request request) throws ProtocolException;

    /**
     * Block ids a request will make Baritone look up ({@code mine}); empty when none. Any thread.
     * ({@code goto {block}} no longer goes through Baritone's block lookup: it paths to a block
     * she can see, found by {@link BlockSight}.)
     */
    java.util.List<String> lookupTargets(Request request);

    /**
     * Resolves {@code blocks} so Baritone caches what they drop. Baritone computes that through a
     * future the client thread has to run; called on the client thread it waits on itself and the
     * game hangs. Must NOT run on the client thread.
     */
    void prewarm(java.util.List<String> blocks);

    /** Cancel whatever Baritone is doing. */
    void cancel();

    /** Cancel her task because a reflex takes over; its {@code baritone_idle} says {@code reason:"reflex"}. */
    void interrupt();

    /**
     * Suspend the active Baritone task because a recoverable reflex is taking over, recording
     * the player's position and timestamp so it can be replayed when the reflex finishes.
     *
     * @return {@code true} if a suspendable Baritone task was paused; {@code false} otherwise
     */
    boolean pauseForReflex(double playerX, double playerY, double playerZ, long nowMs);

    /** Convenience overload reading the current client player's coordinates and wall clock. */
    default boolean pauseForReflex() {
        net.minecraft.client.MinecraftClient mc = net.minecraft.client.MinecraftClient.getInstance();
        if (mc == null || mc.player == null) return false;
        return pauseForReflex(mc.player.getX(), mc.player.getY(), mc.player.getZ(), System.currentTimeMillis());
    }

    /** Whether a suspended Baritone request is currently held for potential resume. */
    boolean hasSuspended();

    /**
     * Replay the previously suspended Baritone request if drift <= {@code maxDrift} blocks and
     * elapsed time <= {@code maxPauseMs}. Always clears the suspended state.
     *
     * @return {@code true} if replayed, {@code false} if missing, expired, drifted, or rejected
     */
    boolean replaySuspended(double playerX, double playerY, double playerZ, long nowMs,
                            double maxDrift, long maxPauseMs);

    /** Convenience overload using the client player's current position and default limits (16 blocks, 15s). */
    default boolean replaySuspended() {
        return replaySuspended(DEFAULT_MAX_PAUSE_DRIFT, DEFAULT_MAX_PAUSE_MS);
    }

    /** Convenience overload using the client player's current position with explicit limits. */
    default boolean replaySuspended(double maxDrift, long maxPauseMs) {
        net.minecraft.client.MinecraftClient mc = net.minecraft.client.MinecraftClient.getInstance();
        if (mc == null || mc.player == null) {
            clearSuspended();
            return false;
        }
        return replaySuspended(mc.player.getX(), mc.player.getY(), mc.player.getZ(),
                System.currentTimeMillis(), maxDrift, maxPauseMs);
    }

    /** Discard any suspended Baritone request without replaying it. */
    void clearSuspended();

    /** Pure bounds check for whether a paused task stayed within drift and timeout limits. */
    static boolean withinResumeBounds(double startX, double startY, double startZ, long pausedAtMs,
                                      double nowX, double nowY, double nowZ, long nowMs,
                                      double maxDrift, long maxPauseMs) {
        if (maxDrift < 0 || maxPauseMs <= 0) {
            return false;
        }
        long elapsed = nowMs - pausedAtMs;
        if (elapsed < 0 || elapsed > maxPauseMs) {
            return false;
        }
        double dx = nowX - startX;
        double dy = nowY - startY;
        double dz = nowZ - startZ;
        return (dx * dx + dy * dy + dz * dz) <= maxDrift * maxDrift;
    }

    /**
     * Reflex movement: path next to {@code pos} (a drop to pick up). While a reflex drives
     * Baritone its path / idle events are not reported: they are not her task's.
     */
    void reflexGoTo(net.minecraft.util.math.BlockPos pos);

    /** Reflex movement: get at least {@code distance} blocks away from {@code from}. */
    void reflexRunAway(double distance, java.util.List<net.minecraft.util.math.BlockPos> from);

    /** Stop the reflex's movement (nothing happens when a request has taken Baritone over since). */
    void reflexCancel();

    /** A reflex drives Baritone right now. */
    boolean reflexDriving();

    /** Baritone is walking a path (standing next to a followed target or waiting for crops is not). */
    boolean pathing();

    RawObservation.BaritoneState state();

    /** Called every client tick: lazily registers listeners and detects the busy -> idle edge. */
    void tick();
}
