package dev.miyoria.bridge.protocol;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/** Builders for every server -> client message. */
public final class Messages {
    private Messages() {}

    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    public static String toJson(JsonElement e) {
        return GSON.toJson(e);
    }

    /** {@code {"type":"hello_ack","protocol":1, ...info}} */
    public static JsonObject helloAck(JsonObject info) {
        JsonObject o = new JsonObject();
        o.addProperty("type", Protocol.T_HELLO_ACK);
        o.addProperty("protocol", Protocol.VERSION);
        if (info != null) {
            for (var en : info.entrySet()) o.add(en.getKey(), en.getValue());
        }
        return o;
    }

    /** {@code {"type":"result","id":..,"ok":true,"data":{..}}} */
    public static JsonObject result(JsonElement id, JsonObject data) {
        JsonObject o = new JsonObject();
        o.addProperty("type", Protocol.T_RESULT);
        if (id != null) o.add("id", id);
        o.addProperty("ok", true);
        o.add("data", data == null ? new JsonObject() : data);
        return o;
    }

    /** Failed request: {@code {"type":"result","id":..,"ok":false,"error":{"code":..,"message":..}}} */
    public static JsonObject failure(JsonElement id, String code, String message) {
        JsonObject o = new JsonObject();
        o.addProperty("type", Protocol.T_RESULT);
        if (id != null) o.add("id", id);
        o.addProperty("ok", false);
        o.add("error", errorBody(code, message));
        return o;
    }

    /** Connection-level error (bad JSON / auth), not tied to a request: {@code {"type":"error",...}} */
    public static JsonObject error(JsonElement id, String code, String message) {
        JsonObject o = new JsonObject();
        o.addProperty("type", Protocol.T_ERROR);
        if (id != null) o.add("id", id);
        o.add("error", errorBody(code, message));
        return o;
    }

    private static JsonObject errorBody(String code, String message) {
        JsonObject e = new JsonObject();
        e.addProperty("code", code);
        e.addProperty("message", message);
        return e;
    }

    /** {@code {"type":"event","name":"death","time":<epoch ms>,"data":{..}}} */
    public static JsonObject event(String name, JsonObject data, long epochMillis) {
        JsonObject o = new JsonObject();
        o.addProperty("type", Protocol.T_EVENT);
        o.addProperty("name", name);
        o.addProperty("time", epochMillis);
        o.add("data", data == null ? new JsonObject() : data);
        return o;
    }
}
