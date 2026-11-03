package dev.miyoria.bridge.game;

import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;

import com.google.gson.JsonObject;

/**
 * What the rest of the mod needs from Baritone. The implementation (the only class that touches
 * {@code baritone.api.*}) is loaded only when the Baritone mod is present.
 * All methods run on the client thread.
 */
public interface BaritoneBridge {

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
