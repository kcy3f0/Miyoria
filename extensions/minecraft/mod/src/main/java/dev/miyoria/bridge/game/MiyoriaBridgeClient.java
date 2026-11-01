package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.config.BridgeConfig;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.text.Text;
import net.minecraft.text.TextContent;
import net.minecraft.text.TranslatableTextContent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Path;

/** Fabric client entrypoint: loads the config, starts the local server, wires game events. */
public final class MiyoriaBridgeClient implements ClientModInitializer {
    private static final Logger LOG = LoggerFactory.getLogger("miyoria-bridge");

    private BridgeRuntime runtime;

    @Override
    public void onInitializeClient() {
        Path file = FabricLoader.getInstance().getConfigDir().resolve(BridgeConfig.FILE_NAME);
        BridgeConfig cfg;
        try {
            cfg = BridgeConfig.load(file);
        } catch (IOException e) {
            LOG.error("cannot read/write {}; using in-memory defaults with a fresh token", file, e);
            cfg = new BridgeConfig();
            cfg.token = BridgeConfig.generateToken();
        }

        if (cfg.disablePauseOnLostFocus) {
            // she plays in a window the streamer is not necessarily focused on
            applyNoPause();
            ClientLifecycleEvents.CLIENT_STARTED.register(c -> applyNoPause());
        }

        runtime = new BridgeRuntime(cfg);
        try {
            if (runtime.start()) {
                LOG.info("Miyoria bridge listening on ws://127.0.0.1:{} (token in {})", cfg.port, file);
            } else {
                LOG.error("Miyoria bridge could not bind 127.0.0.1:{} (port in use?). Change \"port\" in {}", cfg.port, file);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
        }

        ClientTickEvents.END_CLIENT_TICK.register(runtime::onEndTick);
        ClientLifecycleEvents.CLIENT_STOPPING.register(c -> runtime.shutdown());
        registerMessageEvents();
    }

    private static void applyNoPause() {
        MinecraftClient mc = MinecraftClient.getInstance();
        if (mc != null && mc.options != null) {
            mc.options.pauseOnLostFocus = false;
        }
    }

    private void registerMessageEvents() {
        // Signed player chat
        ClientReceiveMessageEvents.CHAT.register((message, signed, sender, params, ts) -> {
            String name = sender != null ? sender.getName() : null;
            String text = signed != null ? signed.getSignedContent() : message.getString();
            chatEvent(name, text, false);
        });
        // System / game messages: unsigned chat on some servers, advancements, deaths, joins...
        ClientReceiveMessageEvents.GAME.register((message, overlay) -> {
            if (overlay) return; // action bar
            TextContent content = message.getContent();
            if (content instanceof TranslatableTextContent t) {
                String key = t.getKey();
                Object[] args = t.getArgs();
                if (key.startsWith("chat.type.advancement.") && args.length >= 2) {
                    advancementEvent(key.substring("chat.type.advancement.".length()), str(args[0]), str(args[1]));
                    return;
                }
                if (key.equals("chat.type.text") && args.length >= 2) {
                    chatEvent(str(args[0]), str(args[1]), false);
                    return;
                }
            }
            chatEvent(null, message.getString(), true);
        });
    }

    private void chatEvent(String sender, String message, boolean system) {
        if (runtime == null || message == null || message.isBlank()) return;
        MinecraftClient mc = MinecraftClient.getInstance();
        String me = mc.player != null ? mc.player.getName().getString() : null;
        JsonObject d = new JsonObject();
        d.addProperty("sender", sender);
        d.addProperty("message", message);
        d.addProperty("system", system);
        d.addProperty("self", sender != null && sender.equals(me));
        runtime.emit("chat", d);
    }

    private void advancementEvent(String kind, String player, String advancement) {
        MinecraftClient mc = MinecraftClient.getInstance();
        if (mc.player == null || !mc.player.getName().getString().equals(player)) return; // someone else's
        JsonObject d = new JsonObject();
        d.addProperty("kind", kind); // task | goal | challenge
        // vanilla renders the title as "[Stone Age]"
        d.addProperty("title", advancement.replaceAll("^\\[|\\]$", ""));
        runtime.emit("advancement", d);
    }

    private static String str(Object arg) {
        if (arg instanceof Text t) return t.getString();
        return String.valueOf(arg);
    }
}
