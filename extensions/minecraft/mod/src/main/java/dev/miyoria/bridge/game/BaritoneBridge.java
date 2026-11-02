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
     * Block ids a request will make Baritone look up ({@code mine}, {@code goto {block}}); empty when
     * none. Any thread.
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

    RawObservation.BaritoneState state();

    /** Called every client tick: lazily registers listeners and detects the busy -> idle edge. */
    void tick();
}
