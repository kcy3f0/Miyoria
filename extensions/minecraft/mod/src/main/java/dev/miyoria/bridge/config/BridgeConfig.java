package dev.miyoria.bridge.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonSyntaxException;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * {@code <game config dir>/miyoria-bridge.json}. Created with a random token on first run.
 * The server always binds to 127.0.0.1; only the port is configurable.
 */
public final class BridgeConfig {
    public static final String FILE_NAME = "miyoria-bridge.json";
    public static final int DEFAULT_PORT = 7890;
    private static final int MIN_TOKEN_LENGTH = 16;

    /** TCP port of the local WebSocket server. */
    public int port = DEFAULT_PORT;
    /** Shared secret the first {@code hello} message must carry. */
    public String token = "";
    /** Radius (blocks) for the nearby-entity list. */
    public int entityRadius = 24;
    /** Horizontal radius for the notable-block scan; vertical is min(this, 12). */
    public int blockScanRadius = 16;
    public int maxEntities = 16;
    /** Max block kinds in the snapshot. */
    public int maxBlockKinds = 20;
    /** low_health event fires at or below this many health points (20 = 10 hearts). */
    public float lowHealthThreshold = 6f;
    /** hostile_near fires when a hostile enters this radius. */
    public double hostileRadius = 16.0;
    /** Press "Respawn" automatically after death (she plays unattended). */
    public boolean autoRespawn = true;
    /** Ticks to wait before auto respawn so the death event is observed first. */
    public int autoRespawnDelayTicks = 40;
    /** Keep the game running when the window loses focus (needed when she plays in the background). */
    public boolean disablePauseOnLostFocus = true;
    /** Screenshot defaults. */
    public int screenshotMaxWidth = 640;

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

    public static String generateToken() {
        byte[] b = new byte[24];
        new SecureRandom().nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    /** Load (creating or repairing the file as needed). */
    public static BridgeConfig load(Path file) throws IOException {
        BridgeConfig cfg = null;
        boolean dirty = false;
        if (Files.isRegularFile(file)) {
            try {
                cfg = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), BridgeConfig.class);
            } catch (JsonSyntaxException e) {
                // unreadable: keep a backup, start over
                Files.move(file, file.resolveSibling(FILE_NAME + ".broken"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
        }
        if (cfg == null) {
            cfg = new BridgeConfig();
            dirty = true;
        }
        if (cfg.token == null || cfg.token.length() < MIN_TOKEN_LENGTH) {
            cfg.token = generateToken();
            dirty = true;
        }
        if (cfg.port < 1024 || cfg.port > 65535) {
            cfg.port = DEFAULT_PORT;
            dirty = true;
        }
        cfg.entityRadius = clamp(cfg.entityRadius, 4, 64);
        cfg.blockScanRadius = clamp(cfg.blockScanRadius, 4, 32);
        cfg.maxEntities = clamp(cfg.maxEntities, 1, 64);
        cfg.maxBlockKinds = clamp(cfg.maxBlockKinds, 1, 64);
        cfg.screenshotMaxWidth = clamp(cfg.screenshotMaxWidth, 64, 3840);
        if (dirty || !Files.isRegularFile(file)) {
            save(file, cfg);
        }
        return cfg;
    }

    public static void save(Path file, BridgeConfig cfg) throws IOException {
        if (file.getParent() != null) Files.createDirectories(file.getParent());
        Files.writeString(file, GSON.toJson(cfg), StandardCharsets.UTF_8);
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
