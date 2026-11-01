package dev.miyoria.bridge.server;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.protocol.Request;

/** Receives authenticated requests from {@link BridgeServer}. May be called from any thread. */
public interface ActionHandler {

    /** Extra fields for {@code hello_ack} (mod version, capabilities...). May be called on a network thread. */
    JsonObject helloInfo();

    /** Handle one request; must eventually call exactly one of the responder's methods. */
    void handle(Request request, Responder responder);

    /** Reply channel for one request; the request {@code id} is attached automatically. */
    interface Responder {
        void ok(JsonObject data);

        void fail(String code, String message);
    }
}
