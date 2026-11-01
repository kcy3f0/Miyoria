package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;

/** Where in-game components push protocol events (backed by BridgeServer.emitEvent). */
@FunctionalInterface
public interface EventSink {
    void emit(String name, JsonObject data);
}
