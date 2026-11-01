package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.reflect.Method;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * Optional AltoClef (MiranCZ fork, Minecraft 1.21.1) integration. NEVER a compile-time dependency:
 * everything is reflective and every failure degrades to "unavailable".
 *
 * Commands are dispatched through AltoClef's own CommandExecutor (the same code path as typing
 * {@code @get iron_pickaxe} in chat), so the AltoClef command set is available verbatim.
 * All methods run on the client thread.
 */
public final class AltoClefBridge {
    private static final Logger LOG = LoggerFactory.getLogger("miyoria-bridge");
    private static final String MOD_ID = "altoclef";
    private static final String MAIN_CLASS = "adris.altoclef.AltoClef";

    private final boolean present = FabricLoader.getInstance().isModLoaded(MOD_ID);

    /** Mod is installed (does not guarantee it is initialized / in a world). */
    public boolean available() {
        return present;
    }

    public RawObservation.AltoState state() {
        if (!present) return RawObservation.AltoState.UNAVAILABLE;
        return new RawObservation.AltoState(true, busy());
    }

    /** @return TRUE/FALSE, or null when it cannot be determined. */
    private Boolean busy() {
        try {
            Class<?> main = Class.forName(MAIN_CLASS);
            Object inst = main.getMethod("getInstance").invoke(null);
            if (inst == null) return null;
            Object chain = main.getMethod("getUserTaskChain").invoke(inst);
            if (chain == null) return null;
            boolean active = (Boolean) chain.getClass().getMethod("isActive").invoke(chain);
            boolean idle = false;
            try {
                idle = (Boolean) chain.getClass().getMethod("isRunningIdleTask").invoke(chain);
            } catch (ReflectiveOperationException ignored) {
                // method missing in other builds
            }
            return active && !idle;
        } catch (Throwable t) {
            LOG.debug("altoclef busy() failed", t);
            return null;
        }
    }

    /**
     * Run an AltoClef command such as {@code "get iron_pickaxe"} (a leading prefix like "@" is accepted too).
     */
    public JsonObject execute(String command) throws ProtocolException {
        if (!present) {
            throw new ProtocolException(Protocol.E_ALTOCLEF_UNAVAILABLE, "AltoClef is not installed");
        }
        String cmd = command.trim();
        if (cmd.isEmpty() || cmd.length() > 200) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "\"command\" must be 1-200 chars");
        }
        try {
            Class<?> main = Class.forName(MAIN_CLASS);
            Object executor = main.getMethod("getCommandExecutor").invoke(null);
            if (executor == null) {
                throw new ProtocolException(Protocol.E_ALTOCLEF_UNAVAILABLE, "AltoClef is not initialized yet");
            }
            String prefix = (String) executor.getClass().getMethod("getCommandPrefix").invoke(executor);
            String line = cmd.startsWith(prefix) ? cmd : prefix + cmd;

            AtomicReference<Throwable> error = new AtomicReference<>();
            Consumer<Object> onError = o -> error.set(o instanceof Throwable t ? t : new RuntimeException(String.valueOf(o))); // erased CommandException consumer
            Method exec = executor.getClass().getMethod("execute", String.class, Consumer.class);
            exec.invoke(executor, line, onError);
            if (error.get() != null) {
                throw new ProtocolException(Protocol.E_INVALID_ARGS, "altoclef: " + error.get().getMessage());
            }
            JsonObject out = new JsonObject();
            out.addProperty("command", cmd);
            out.addProperty("dispatched", line);
            return out;
        } catch (ProtocolException e) {
            throw e;
        } catch (ClassNotFoundException | NoSuchMethodException e) {
            throw new ProtocolException(Protocol.E_ALTOCLEF_UNAVAILABLE,
                    "AltoClef API not recognised (expected adris.altoclef.AltoClef.getCommandExecutor()): " + e);
        } catch (ReflectiveOperationException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            throw new ProtocolException(Protocol.E_INTERNAL, "altoclef failed: " + cause);
        }
    }

    /** Stop the current AltoClef task (like {@code @stop}). Silent when unavailable. */
    public void stop() {
        if (!present) return;
        try {
            execute("stop");
        } catch (ProtocolException e) {
            LOG.debug("altoclef stop skipped: {}", e.getMessage());
        }
    }
}
