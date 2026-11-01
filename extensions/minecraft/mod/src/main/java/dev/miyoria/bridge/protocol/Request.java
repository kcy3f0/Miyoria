package dev.miyoria.bridge.protocol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;

/**
 * One client request: {@code {"id": <string|number>, "type": "...", ...}}.
 * {@code id} is optional on the wire but echoed back verbatim when present.
 */
public record Request(JsonElement id, String type, JsonObject body) {

    public static Request parse(String text) throws ProtocolException {
        JsonElement root;
        try {
            root = JsonParser.parseString(text);
        } catch (JsonParseException | IllegalStateException e) {
            throw new ProtocolException(Protocol.E_BAD_JSON, "not valid JSON");
        }
        if (root == null || !root.isJsonObject()) {
            throw new ProtocolException(Protocol.E_BAD_REQUEST, "message must be a JSON object");
        }
        JsonObject obj = root.getAsJsonObject();
        JsonElement id = obj.get("id");
        if (id != null && !(id.isJsonPrimitive() && (id.getAsJsonPrimitive().isString() || id.getAsJsonPrimitive().isNumber()))) {
            id = null; // ids must be string/number; anything else is ignored rather than echoed
        }
        JsonElement type = obj.get("type");
        if (type == null || !type.isJsonPrimitive() || !type.getAsJsonPrimitive().isString()) {
            throw new ProtocolException(Protocol.E_BAD_REQUEST, "missing string field \"type\"");
        }
        return new Request(id, type.getAsString(), obj);
    }

    // --- typed accessors (throw invalid_args) ---

    public String str(String key) throws ProtocolException {
        String v = optStr(key, null);
        if (v == null) throw new ProtocolException(Protocol.E_INVALID_ARGS, "missing string field \"" + key + "\"");
        return v;
    }

    public String optStr(String key, String def) throws ProtocolException {
        JsonElement e = body.get(key);
        if (e == null || e.isJsonNull()) return def;
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "\"" + key + "\" must be a string");
        }
        return e.getAsString();
    }

    public Double optNum(String key) throws ProtocolException {
        JsonElement e = body.get(key);
        if (e == null || e.isJsonNull()) return null;
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "\"" + key + "\" must be a number");
        }
        return e.getAsDouble();
    }

    public double num(String key) throws ProtocolException {
        Double v = optNum(key);
        if (v == null) throw new ProtocolException(Protocol.E_INVALID_ARGS, "missing number field \"" + key + "\"");
        return v;
    }

    public int optInt(String key, int def) throws ProtocolException {
        Double v = optNum(key);
        return v == null ? def : (int) Math.round(v);
    }

    public boolean optBool(String key, boolean def) throws ProtocolException {
        JsonElement e = body.get(key);
        if (e == null || e.isJsonNull()) return def;
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isBoolean()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "\"" + key + "\" must be a boolean");
        }
        return e.getAsBoolean();
    }

    public JsonObject optObj(String key) throws ProtocolException {
        JsonElement e = body.get(key);
        if (e == null || e.isJsonNull()) return null;
        if (!e.isJsonObject()) throw new ProtocolException(Protocol.E_INVALID_ARGS, "\"" + key + "\" must be an object");
        return e.getAsJsonObject();
    }

    public boolean has(String key) {
        JsonElement e = body.get(key);
        return e != null && !e.isJsonNull();
    }
}
