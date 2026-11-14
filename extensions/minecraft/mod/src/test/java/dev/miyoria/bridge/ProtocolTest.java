package dev.miyoria.bridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.miyoria.bridge.config.BridgeConfig;
import dev.miyoria.bridge.protocol.Messages;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.util.NotableBlocks;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class ProtocolTest {

    @Test
    void parsesRequestWithStringAndNumericIds() throws Exception {
        Request a = Request.parse("{\"id\":\"abc\",\"type\":\"observe\"}");
        assertEquals("observe", a.type());
        assertEquals("abc", a.id().getAsString());

        Request b = Request.parse("{\"id\":42,\"type\":\"stop\"}");
        assertEquals(42, b.id().getAsInt());

        Request c = Request.parse("{\"type\":\"ping\"}");
        assertNull(c.id());
    }

    @Test
    void dropsIdsThatAreNotStringOrNumber() throws Exception {
        assertNull(Request.parse("{\"id\":{\"x\":1},\"type\":\"observe\"}").id());
        assertNull(Request.parse("{\"id\":[1],\"type\":\"observe\"}").id());
    }

    @Test
    void rejectsGarbage() {
        assertEquals(Protocol.E_BAD_JSON, code("not json {"));
        assertEquals(Protocol.E_BAD_REQUEST, code("[1,2,3]"));
        assertEquals(Protocol.E_BAD_REQUEST, code("\"hello\""));
        assertEquals(Protocol.E_BAD_REQUEST, code("{\"id\":1}"));
        assertEquals(Protocol.E_BAD_REQUEST, code("{\"type\":5}"));
    }

    private static String code(String text) {
        return assertThrows(ProtocolException.class, () -> Request.parse(text)).code();
    }

    @Test
    void typedAccessors() throws Exception {
        Request r = Request.parse("{\"type\":\"look\",\"yaw\":90.5,\"pitch\":-10,\"smooth\":false,"
                + "\"at\":{\"x\":1,\"y\":2,\"z\":3},\"command\":\"goto\",\"n\":\"x\"}");
        assertEquals(90.5, r.num("yaw"));
        assertEquals(-10, r.optInt("pitch", 0));
        assertFalse(r.optBool("smooth", true));
        assertEquals("goto", r.str("command"));
        assertEquals(3.0, r.optObj("at").get("z").getAsDouble());
        assertTrue(r.has("yaw"));
        assertFalse(r.has("nope"));
        assertEquals(7, r.optInt("nope", 7));

        assertEquals(Protocol.E_INVALID_ARGS, assertThrows(ProtocolException.class, () -> r.num("n")).code());
        assertEquals(Protocol.E_INVALID_ARGS, assertThrows(ProtocolException.class, () -> r.str("missing")).code());
        assertEquals(Protocol.E_INVALID_ARGS, assertThrows(ProtocolException.class, () -> r.str("yaw")).code());
        assertEquals(Protocol.E_INVALID_ARGS, assertThrows(ProtocolException.class, () -> r.optObj("yaw")).code());
    }

    @Test
    void dropRequestParsing() throws Exception {
        Request r = Request.parse("{\"type\":\"drop\",\"item\":\"dirt\",\"slot\":2,\"all\":true}");
        assertEquals(Protocol.T_DROP, r.type());
        assertEquals("dirt", r.str("item"));
        assertEquals(2, r.num("slot"));
        assertTrue(r.optBool("all", false));
    }

    @Test
    void resultShapeEchoesId() {
        JsonObject data = new JsonObject();
        data.addProperty("health", 20);
        JsonObject msg = Messages.result(JsonParser.parseString("\"r1\""), data);
        assertEquals("result", msg.get("type").getAsString());
        assertEquals("r1", msg.get("id").getAsString());
        assertTrue(msg.get("ok").getAsBoolean());
        assertEquals(20, msg.getAsJsonObject("data").get("health").getAsInt());
    }

    @Test
    void numericIdStaysNumeric() {
        JsonObject msg = Messages.result(JsonParser.parseString("7"), null);
        assertTrue(msg.get("id").getAsJsonPrimitive().isNumber());
        assertEquals(0, msg.getAsJsonObject("data").size());
    }

    @Test
    void failureShape() {
        JsonObject msg = Messages.failure(JsonParser.parseString("\"x\""), Protocol.E_NOT_IN_GAME, "nope");
        assertEquals("result", msg.get("type").getAsString());
        assertFalse(msg.get("ok").getAsBoolean());
        assertEquals("not_in_game", msg.getAsJsonObject("error").get("code").getAsString());
        assertEquals("nope", msg.getAsJsonObject("error").get("message").getAsString());
        assertFalse(msg.has("data"));
    }

    @Test
    void errorAndEventAndHelloShapes() {
        JsonObject err = Messages.error(null, Protocol.E_UNAUTHORIZED, "bad token");
        assertEquals("error", err.get("type").getAsString());
        assertFalse(err.has("id"));

        JsonObject d = new JsonObject();
        d.addProperty("amount", 3.5);
        JsonObject ev = Messages.event("damage", d, 1234L);
        assertEquals("event", ev.get("type").getAsString());
        assertEquals("damage", ev.get("name").getAsString());
        assertEquals(1234L, ev.get("time").getAsLong());
        assertEquals(3.5, ev.getAsJsonObject("data").get("amount").getAsDouble());

        JsonObject info = new JsonObject();
        info.addProperty("mod_version", "0.1.0");
        JsonObject ack = Messages.helloAck(info);
        assertEquals("hello_ack", ack.get("type").getAsString());
        assertEquals(Protocol.VERSION, ack.get("protocol").getAsInt());
        assertEquals("0.1.0", ack.get("mod_version").getAsString());
    }

    @Test
    void serializationIsCompactJsonWithoutHtmlEscaping() {
        JsonObject o = new JsonObject();
        o.addProperty("message", "a<b>&'你好");
        String json = Messages.toJson(o);
        assertEquals("{\"message\":\"a<b>&'你好\"}", json);
    }

    @Test
    void newWorldWorkerProtocolConstants() {
        assertEquals("mine_branch", Protocol.T_MINE_BRANCH);
        assertEquals("clear_leaves", Protocol.T_CLEAR_LEAVES);
        assertEquals("chest", Protocol.T_CHEST);
        assertEquals("sleep", Protocol.T_SLEEP);
        assertEquals("hunt", Protocol.T_HUNT);
        assertEquals("manage_inv", Protocol.T_MANAGE_INV);
    }

    @Test
    void bridgeConfigDefaultsAndClamping(@TempDir Path dir) throws Exception {
        BridgeConfig def = new BridgeConfig();
        assertTrue(def.reflexAutoEquip);
        assertTrue(def.reflexShieldBlock);
        assertTrue(def.reflexMlgWater);
        assertEquals(4.0f, def.mlgMinFallDistance);
        assertTrue(def.reflexAutoTorch);
        assertEquals(7, def.autoTorchMaxLight);
        assertTrue(def.reflexPillarEscape);
        assertEquals(15, def.reflexPausedResumeMaxSecs);
        assertEquals(16.0, def.reflexPausedMaxDrift);

        Path cfgPath = dir.resolve("bridge.json");
        Files.writeString(cfgPath, """
                {
                  "mlgMinFallDistance": 0.5,
                  "autoTorchMaxLight": 99,
                  "reflexPausedResumeMaxSecs": -3,
                  "reflexPausedMaxDrift": 500.0
                }
                """);
        BridgeConfig clamped = BridgeConfig.load(cfgPath);
        assertEquals(2.5f, clamped.mlgMinFallDistance);
        assertEquals(14, clamped.autoTorchMaxLight);
        assertEquals(1, clamped.reflexPausedResumeMaxSecs);
        assertEquals(64.0, clamped.reflexPausedMaxDrift);
        assertTrue(clamped.reflexAutoEquip);
    }

    @Test
    void notableBlocksIncludeNewUtilityAndResourceVariants() {
        for (String id : java.util.List.of(
                "blast_furnace", "smoker", "barrel", "water",
                "obsidian", "crying_obsidian", "sugar_cane", "hay_block", "cyan_bed")) {
            assertTrue(NotableBlocks.isNotable(id), () -> "expected notable: " + id);
        }
        assertTrue(NotableBlocks.priority("obsidian") < NotableBlocks.priority("water"));
        assertTrue(NotableBlocks.priority("cyan_bed") < NotableBlocks.priority("stone"));
    }
}
