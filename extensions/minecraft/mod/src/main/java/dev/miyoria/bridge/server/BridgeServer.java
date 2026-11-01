package dev.miyoria.bridge.server;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.miyoria.bridge.protocol.Messages;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import org.java_websocket.WebSocket;
import org.java_websocket.drafts.Draft;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.extensions.IExtension;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshakeBuilder;
import org.java_websocket.protocols.IProtocol;
import org.java_websocket.server.WebSocketServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Local WebSocket endpoint. A connection is unauthenticated until its first message is
 * {@code {"type":"hello","token":"..."}} with the right token; anything else closes it (1008).
 * Browsers (requests with an Origin header) are refused so web pages cannot reach the bridge.
 */
public final class BridgeServer extends WebSocketServer {
    private static final Logger LOG = LoggerFactory.getLogger("miyoria-bridge");

    public static final int MAX_FRAME_BYTES = 1 << 20;
    public static final int HELLO_TIMEOUT_MS = 5000;
    public static final int CLOSE_POLICY = 1008;

    /** Per-connection state. */
    private static final class Session {
        volatile boolean authed;
    }

    private final byte[] token;
    private final ActionHandler handler;
    private final CountDownLatch started = new CountDownLatch(1);
    private final AtomicBoolean startFailed = new AtomicBoolean();
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "miyoria-bridge-timer");
        t.setDaemon(true);
        return t;
    });

    public BridgeServer(int port, String token, ActionHandler handler) {
        super(new InetSocketAddress(loopback(), port), drafts());
        this.token = token.getBytes(StandardCharsets.UTF_8);
        this.handler = handler;
        setReuseAddr(true);
        setTcpNoDelay(true);
        setConnectionLostTimeout(30);
    }

    /** Always IPv4 127.0.0.1 (the documented address), never an external interface. */
    private static InetAddress loopback() {
        try {
            return InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
        } catch (java.net.UnknownHostException e) {
            throw new IllegalStateException(e);
        }
    }

    private static List<Draft> drafts() {
        return Collections.singletonList(new Draft_6455(
                Collections.<IExtension>emptyList(),
                Collections.<IProtocol>singletonList(new org.java_websocket.protocols.Protocol("")), // "no subprotocol" must stay acceptable
                MAX_FRAME_BYTES));
    }

    /** Start and block until the socket is bound (or failed). @return false when binding failed. */
    public boolean startAndWait(long timeoutMs) throws InterruptedException {
        start();
        return started.await(timeoutMs, TimeUnit.MILLISECONDS) && !startFailed.get();
    }

    public void shutdown() {
        timers.shutdownNow();
        try {
            stop(500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Broadcast an event to every authenticated connection. Safe from any thread. */
    public void broadcast(JsonObject message) {
        String text = Messages.toJson(message);
        for (WebSocket c : getConnections()) {
            Session s = c.getAttachment();
            if (s != null && s.authed && c.isOpen()) {
                c.send(text);
            }
        }
    }

    public void emitEvent(String name, JsonObject data) {
        broadcast(Messages.event(name, data, System.currentTimeMillis()));
    }

    public int authenticatedClients() {
        int n = 0;
        for (WebSocket c : getConnections()) {
            Session s = c.getAttachment();
            if (s != null && s.authed) n++;
        }
        return n;
    }

    // ---------------------------------------------------------------- WebSocketServer

    @Override
    public ServerHandshakeBuilder onWebsocketHandshakeReceivedAsServer(WebSocket conn, Draft draft, ClientHandshake request)
            throws InvalidDataException {
        if (request.hasFieldValue("Origin")) {
            throw new InvalidDataException(CLOSE_POLICY, "browser origins are not allowed");
        }
        return super.onWebsocketHandshakeReceivedAsServer(conn, draft, request);
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        Session s = new Session();
        conn.setAttachment(s);
        timers.schedule(() -> {
            if (!s.authed && conn.isOpen()) {
                conn.close(CLOSE_POLICY, "hello timeout");
            }
        }, HELLO_TIMEOUT_MS, TimeUnit.MILLISECONDS);
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        // nothing to clean up: state lives in the attachment
    }

    @Override
    public void onMessage(WebSocket conn, String text) {
        Session s = conn.getAttachment();
        if (s == null) {
            conn.close(CLOSE_POLICY, "no session");
            return;
        }
        Request req;
        try {
            req = Request.parse(text);
        } catch (ProtocolException e) {
            if (!s.authed) {
                reject(conn, e.code(), e.getMessage());
            } else {
                send(conn, Messages.error(null, e.code(), e.getMessage()));
            }
            return;
        }

        if (!s.authed) {
            if (!Protocol.T_HELLO.equals(req.type())) {
                reject(conn, Protocol.E_UNAUTHORIZED, "first message must be hello");
                return;
            }
            String presented = req.body().has("token") && req.body().get("token").isJsonPrimitive()
                    ? req.body().get("token").getAsString() : "";
            if (!MessageDigest.isEqual(token, presented.getBytes(StandardCharsets.UTF_8))) {
                reject(conn, Protocol.E_UNAUTHORIZED, "bad token");
                return;
            }
            s.authed = true;
            send(conn, Messages.helloAck(handler.helloInfo()));
            return;
        }

        if (Protocol.T_HELLO.equals(req.type())) {
            send(conn, Messages.helloAck(handler.helloInfo())); // idempotent
            return;
        }

        JsonElement id = req.id();
        AtomicBoolean answered = new AtomicBoolean();
        ActionHandler.Responder responder = new ActionHandler.Responder() {
            @Override
            public void ok(JsonObject data) {
                if (answered.compareAndSet(false, true)) send(conn, Messages.result(id, data));
            }

            @Override
            public void fail(String code, String message) {
                if (answered.compareAndSet(false, true)) send(conn, Messages.failure(id, code, message));
            }
        };
        try {
            handler.handle(req, responder);
        } catch (RuntimeException e) {
            LOG.warn("handler failed for {}", req.type(), e);
            responder.fail(Protocol.E_INTERNAL, String.valueOf(e.getMessage()));
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        if (conn == null) {
            LOG.error("bridge server error", ex);
            startFailed.set(true);
            started.countDown();
        } else {
            LOG.debug("connection error", ex);
        }
    }

    @Override
    public void onStart() {
        started.countDown();
    }

    // ---------------------------------------------------------------- helpers

    private void reject(WebSocket conn, String code, String message) {
        send(conn, Messages.error(null, code, message));
        conn.close(CLOSE_POLICY, message);
    }

    private static void send(WebSocket conn, JsonObject message) {
        if (conn.isOpen()) {
            conn.send(Messages.toJson(message));
        }
    }
}
