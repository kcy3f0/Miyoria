package dev.miyoria.bridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.server.ActionHandler;
import dev.miyoria.bridge.server.BridgeServer;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/** Real WebSocket round trips against a BridgeServer on an ephemeral loopback port. */
class BridgeServerTest {
    private static final String TOKEN = "test-token-0123456789abcdef";

    private BridgeServer server;

    /** Fake game: echoes the request type, "slow" replies asynchronously, "boom" throws. */
    private final ActionHandler handler = new ActionHandler() {
        @Override
        public JsonObject helloInfo() {
            JsonObject o = new JsonObject();
            o.addProperty("mod_version", "test");
            return o;
        }

        @Override
        public void handle(Request req, Responder out) {
            switch (req.type()) {
                case "boom" -> throw new IllegalStateException("kaput");
                case "slow" -> new Thread(() -> {
                    try {
                        Thread.sleep(150);
                    } catch (InterruptedException ignored) {
                    }
                    JsonObject d = new JsonObject();
                    d.addProperty("which", "slow");
                    out.ok(d);
                }).start();
                case "nope" -> out.fail(Protocol.E_INVALID_ARGS, "bad things");
                default -> {
                    JsonObject d = new JsonObject();
                    d.addProperty("echo", req.type());
                    out.ok(d);
                }
            }
        }
    };

    @BeforeEach
    void start() throws Exception {
        server = new BridgeServer(0, TOKEN, handler);
        assertTrue(server.startAndWait(5000));
    }

    @AfterEach
    void stop() {
        server.shutdown();
    }

    /** Test client collecting messages and close info. */
    private static final class Client extends WebSocketClient {
        final BlockingQueue<JsonObject> in = new LinkedBlockingQueue<>();
        final CountDownLatch closed = new CountDownLatch(1);
        volatile int closeCode = -1;

        Client(int port, Map<String, String> headers) {
            super(URI.create("ws://127.0.0.1:" + port), headers);
        }

        @Override
        public void onOpen(ServerHandshake h) {
        }

        @Override
        public void onMessage(String message) {
            in.add(JsonParser.parseString(message).getAsJsonObject());
        }

        @Override
        public void onClose(int code, String reason, boolean remote) {
            closeCode = code;
            closed.countDown();
        }

        @Override
        public void onError(Exception ex) {
        }

        JsonObject next() throws InterruptedException {
            JsonObject m = in.poll(5, TimeUnit.SECONDS);
            assertNotNull(m, "timed out waiting for a message");
            return m;
        }
    }

    private Client connect(Map<String, String> headers) throws Exception {
        Client c = new Client(server.getPort(), headers);
        assertTrue(c.connectBlocking(5, TimeUnit.SECONDS));
        return c;
    }

    private Client authed() throws Exception {
        Client c = connect(Map.of());
        c.send("{\"type\":\"hello\",\"token\":\"" + TOKEN + "\"}");
        JsonObject ack = c.next();
        assertEquals("hello_ack", ack.get("type").getAsString());
        return c;
    }

    @Test
    void helloAckCarriesProtocolAndInfo() throws Exception {
        Client c = connect(Map.of());
        c.send("{\"type\":\"hello\",\"token\":\"" + TOKEN + "\",\"client\":\"unit\"}");
        JsonObject ack = c.next();
        assertEquals("hello_ack", ack.get("type").getAsString());
        assertEquals(Protocol.VERSION, ack.get("protocol").getAsInt());
        assertEquals("test", ack.get("mod_version").getAsString());
        c.close();
    }

    @Test
    void wrongTokenIsRejectedAndClosed() throws Exception {
        Client c = connect(Map.of());
        c.send("{\"type\":\"hello\",\"token\":\"nope\"}");
        JsonObject err = c.next();
        assertEquals("error", err.get("type").getAsString());
        assertEquals("unauthorized", err.getAsJsonObject("error").get("code").getAsString());
        assertTrue(c.closed.await(5, TimeUnit.SECONDS));
        assertEquals(BridgeServer.CLOSE_POLICY, c.closeCode);
    }

    @Test
    void firstMessageMustBeHello() throws Exception {
        Client c = connect(Map.of());
        c.send("{\"id\":\"1\",\"type\":\"observe\"}");
        JsonObject err = c.next();
        assertEquals("unauthorized", err.getAsJsonObject("error").get("code").getAsString());
        assertTrue(c.closed.await(5, TimeUnit.SECONDS));
    }

    @Test
    void garbageBeforeHelloClosesConnection() throws Exception {
        Client c = connect(Map.of());
        c.send("this is not json");
        JsonObject err = c.next();
        assertEquals("error", err.get("type").getAsString());
        assertTrue(c.closed.await(5, TimeUnit.SECONDS));
    }

    @Test
    void helloTimeoutClosesSilentClients() throws Exception {
        Client c = connect(Map.of());
        assertTrue(c.closed.await(BridgeServer.HELLO_TIMEOUT_MS + 3000, TimeUnit.MILLISECONDS));
        assertEquals(BridgeServer.CLOSE_POLICY, c.closeCode);
    }

    @Test
    void browserOriginsAreRefused() throws Exception {
        Client c = new Client(server.getPort(), Map.of("Origin", "https://evil.example"));
        assertFalse(c.connectBlocking(5, TimeUnit.SECONDS));
    }

    @Test
    void repliesAreCorrelatedById() throws Exception {
        Client c = authed();
        // slow request first, fast one second: replies may arrive out of order, ids must match
        c.send("{\"id\":\"A\",\"type\":\"slow\"}");
        c.send("{\"id\":7,\"type\":\"observe\"}");
        JsonObject first = c.next();
        JsonObject second = c.next();
        JsonObject fast = first.get("id").getAsString().equals("7") ? first : second;
        JsonObject slow = fast == first ? second : first;

        assertEquals("result", fast.get("type").getAsString());
        assertTrue(fast.get("id").getAsJsonPrimitive().isNumber());
        assertEquals(7, fast.get("id").getAsInt());
        assertTrue(fast.get("ok").getAsBoolean());
        assertEquals("observe", fast.getAsJsonObject("data").get("echo").getAsString());

        assertEquals("A", slow.get("id").getAsString());
        assertEquals("slow", slow.getAsJsonObject("data").get("which").getAsString());
        c.close();
    }

    @Test
    void handlerFailuresBecomeErrorResults() throws Exception {
        Client c = authed();
        c.send("{\"id\":\"x\",\"type\":\"nope\"}");
        JsonObject r = c.next();
        assertFalse(r.get("ok").getAsBoolean());
        assertEquals("invalid_args", r.getAsJsonObject("error").get("code").getAsString());
        assertEquals("x", r.get("id").getAsString());

        c.send("{\"id\":\"y\",\"type\":\"boom\"}");
        JsonObject b = c.next();
        assertFalse(b.get("ok").getAsBoolean());
        assertEquals("internal", b.getAsJsonObject("error").get("code").getAsString());
        assertEquals("y", b.get("id").getAsString());

        // connection survives and still works
        c.send("{\"id\":\"z\",\"type\":\"ping\"}");
        assertTrue(c.next().get("ok").getAsBoolean());
        c.close();
    }

    @Test
    void badJsonAfterAuthKeepsConnectionOpen() throws Exception {
        Client c = authed();
        c.send("{{{");
        JsonObject err = c.next();
        assertEquals("error", err.get("type").getAsString());
        assertEquals("bad_json", err.getAsJsonObject("error").get("code").getAsString());
        assertFalse(c.closed.await(300, TimeUnit.MILLISECONDS));
        c.send("{\"id\":\"1\",\"type\":\"observe\"}");
        assertTrue(c.next().get("ok").getAsBoolean());
        c.close();
    }

    @Test
    void eventsReachOnlyAuthenticatedClients() throws Exception {
        Client good = authed();
        Client lurker = connect(Map.of()); // connected but never said hello

        JsonObject data = new JsonObject();
        data.addProperty("amount", 4);
        server.emitEvent("damage", data);

        JsonObject ev = good.next();
        assertEquals("event", ev.get("type").getAsString());
        assertEquals("damage", ev.get("name").getAsString());
        assertEquals(4, ev.getAsJsonObject("data").get("amount").getAsInt());
        assertTrue(ev.get("time").getAsLong() > 0);

        assertNull(lurker.in.poll(300, TimeUnit.MILLISECONDS));
        assertEquals(1, server.authenticatedClients());
        good.close();
        lurker.close();
    }
}
