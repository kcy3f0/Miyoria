package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.config.BridgeConfig;
import dev.miyoria.bridge.events.EventDetector;
import dev.miyoria.bridge.events.EventDetector.GameEvent;
import dev.miyoria.bridge.events.EventDetector.TickState;
import dev.miyoria.bridge.model.Models.EntityInfo;
import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.server.ActionHandler;
import dev.miyoria.bridge.server.BridgeServer;
import dev.miyoria.bridge.snapshot.SnapshotSummarizer;
import dev.miyoria.bridge.util.Ids;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.damage.DamageSource;
import net.minecraft.registry.Registries;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Glue: owns the server and every game-facing component. Requests are marshalled onto the client
 * thread ({@code MinecraftClient.execute}); the per-tick pump produces pushed events.
 */
public final class BridgeRuntime implements ActionHandler {
    private static final Logger LOG = LoggerFactory.getLogger("miyoria-bridge");
    private static final String MOD_VERSION = FabricLoader.getInstance()
            .getModContainer("miyoria-bridge").map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev");

    private final BridgeConfig cfg;
    private final MinecraftClient mc = MinecraftClient.getInstance();
    private final BridgeServer server;
    private final GameObserver observer;
    private final GameActions actions = new GameActions();
    private final ScreenshotService screenshots;
    private final AltoClefBridge alto = new AltoClefBridge();
    private final EventDetector detector;
    private final SnapshotSummarizer.Options snapshotOptions;
    private BaritoneBridge baritone; // null when Baritone is not installed

    private List<EntityInfo> hostileCache = List.of();
    private long tickCount;
    private int deadTicks;

    public BridgeRuntime(BridgeConfig cfg) {
        this.cfg = cfg;
        this.server = new BridgeServer(cfg.port, cfg.token, this);
        this.observer = new GameObserver(cfg);
        this.screenshots = new ScreenshotService(cfg.screenshotMaxWidth);
        this.detector = new EventDetector(new EventDetector.Config(cfg.lowHealthThreshold, cfg.hostileRadius, 100, 10));
        this.snapshotOptions = new SnapshotSummarizer.Options(cfg.maxEntities, cfg.maxBlockKinds);

        if (FabricLoader.getInstance().isModLoaded("baritone")) {
            try {
                this.baritone = new BaritoneBridgeImpl(this::emit);
            } catch (Throwable t) { // NoClassDefFoundError etc: wrong Baritone build
                LOG.error("Baritone is installed but its API could not be loaded; baritone actions disabled", t);
            }
        } else {
            LOG.warn("Baritone is not installed: movement/mining actions will answer baritone_unavailable");
        }
    }

    public boolean start() throws InterruptedException {
        return server.startAndWait(5000);
    }

    public void shutdown() {
        screenshots.shutdown();
        server.shutdown();
    }

    public void emit(String name, JsonObject data) {
        server.emitEvent(name, data);
    }

    public BridgeServer server() {
        return server;
    }

    // ------------------------------------------------------------------ ActionHandler

    @Override
    public JsonObject helloInfo() {
        JsonObject o = new JsonObject();
        o.addProperty("mod_version", MOD_VERSION);
        o.addProperty("minecraft", "1.21.1");
        JsonObject caps = new JsonObject();
        caps.addProperty("baritone", baritone != null);
        caps.addProperty("altoclef", alto.available());
        caps.addProperty("screenshot", true);
        o.add("capabilities", caps);
        return o;
    }

    @Override
    public void handle(Request req, Responder out) {
        if (Protocol.T_PING.equals(req.type())) {
            JsonObject d = new JsonObject();
            d.addProperty("time", System.currentTimeMillis());
            out.ok(d);
            return;
        }
        mc.execute(() -> {
            try {
                dispatch(req, out);
            } catch (ProtocolException e) {
                out.fail(e.code(), e.getMessage());
            } catch (Throwable t) {
                LOG.warn("request {} failed", req.type(), t);
                out.fail(Protocol.E_INTERNAL, t.toString());
            }
        });
    }

    /** Client thread. */
    private void dispatch(Request req, Responder out) throws ProtocolException {
        if (mc.player == null || mc.world == null) {
            throw new ProtocolException(Protocol.E_NOT_IN_GAME, "no world loaded (main menu / loading)");
        }
        switch (req.type()) {
            case Protocol.T_OBSERVE -> out.ok(SnapshotSummarizer.summarize(observer.observe(baritone, alto), snapshotOptions));
            case Protocol.T_BARITONE -> {
                if (baritone == null) {
                    throw new ProtocolException(Protocol.E_BARITONE_UNAVAILABLE, "Baritone is not installed");
                }
                out.ok(baritone.execute(req));
            }
            case Protocol.T_ALTOCLEF -> out.ok(alto.execute(req.str("command")));
            case Protocol.T_CHAT -> out.ok(actions.chat(mc, req));
            case Protocol.T_LOOK -> out.ok(actions.look(mc, req));
            case Protocol.T_USE -> out.ok(actions.use(mc, req));
            case Protocol.T_ATTACK -> out.ok(actions.attack(mc, req));
            case Protocol.T_SELECT_SLOT -> out.ok(actions.selectSlot(mc, req));
            case Protocol.T_RESPAWN -> out.ok(actions.respawn(mc));
            case Protocol.T_STOP -> out.ok(stopAll());
            case Protocol.T_SCREENSHOT -> screenshots.capture(mc, req, out);
            default -> throw new ProtocolException(Protocol.E_UNKNOWN_TYPE, "unknown request type \"" + req.type() + "\"");
        }
    }

    private JsonObject stopAll() {
        JsonObject o = new JsonObject();
        if (baritone != null) {
            baritone.cancel();
        }
        o.addProperty("baritone", baritone != null);
        alto.stop();
        o.addProperty("altoclef", alto.available());
        actions.releaseAll();
        return o;
    }

    // ------------------------------------------------------------------ tick pump (client thread)

    public void onEndTick(MinecraftClient client) {
        tickCount++;
        actions.tick(client);

        ClientPlayerEntity p = client.player;
        boolean inWorld = p != null && client.world != null;

        if (inWorld && baritone != null) {
            try {
                baritone.tick();
            } catch (Throwable t) {
                if (tickCount % 200 == 0) LOG.debug("baritone tick failed", t);
            }
        }

        if (server.authenticatedClients() == 0 && !inWorld) {
            detector.onTick(emptyState()); // keep the detector's baseline reset
            return;
        }

        boolean dead = inWorld && (p.isDead() || client.currentScreen instanceof DeathScreen);
        TickState state = inWorld ? sample(client, p, dead) : emptyState();
        for (GameEvent ev : detector.onTick(state)) {
            emit(ev.name(), ev.data());
        }

        if (dead && cfg.autoRespawn) {
            if (++deadTicks >= cfg.autoRespawnDelayTicks) {
                deadTicks = 0;
                p.requestRespawn();
            }
        } else {
            deadTicks = 0;
        }
    }

    private static TickState emptyState() {
        return new TickState(false, false, 0f, 0, Map.of(), "overworld", 0, 0, 0, 0, List.of(), null, null);
    }

    private TickState sample(MinecraftClient client, ClientPlayerEntity p, boolean dead) {
        RawObservation tmp = new RawObservation();
        observer.fillInventory(p, tmp);
        Map<String, Integer> inv = SnapshotSummarizer.inventoryTotals(tmp.mainSlots);

        // hostile scan only every 5 ticks (entity queries are the costly part)
        if (tickCount % 5 == 0) {
            hostileCache = observer.nearbyEntities(p, client.world, cfg.hostileRadius).stream()
                    .filter(EntityInfo::hostile).toList();
        }

        String src = null;
        String attacker = null;
        DamageSource ds = p.getRecentDamageSource();
        if (ds != null) {
            src = ds.getName();
            if (ds.getAttacker() != null) {
                attacker = ds.getAttacker() instanceof net.minecraft.entity.player.PlayerEntity pl
                        ? pl.getName().getString()
                        : Ids.normalize(Registries.ENTITY_TYPE.getId(ds.getAttacker().getType()).toString());
            }
        }

        return new TickState(true, dead, p.getHealth(), p.getHungerManager().getFoodLevel(), inv,
                Ids.normalize(client.world.getRegistryKey().getValue().toString()),
                client.world.getTimeOfDay(), p.getX(), p.getY(), p.getZ(),
                new ArrayList<>(hostileCache), src, attacker);
    }
}
