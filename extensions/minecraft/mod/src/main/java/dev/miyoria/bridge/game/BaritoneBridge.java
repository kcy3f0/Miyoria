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

    /** Cancel whatever Baritone is doing. */
    void cancel();

    RawObservation.BaritoneState state();

    /** Called every client tick: lazily registers listeners and detects the busy -> idle edge. */
    void tick();
}
