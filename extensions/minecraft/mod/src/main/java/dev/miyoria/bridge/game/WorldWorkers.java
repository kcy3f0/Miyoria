package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.config.BridgeConfig;
import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.server.ActionHandler;
import net.minecraft.client.MinecraftClient;

/**
 * Facade owning the five multi-tick world workers ({@code mine_branch}, {@code clear_leaves},
 * {@code chest}, {@code sleep}, {@code hunt}) plus synchronous {@code manage_inv}, with clean
 * reflex suspend/resume hooks for {@code BridgeRuntime}. Client thread only.
 */
public final class WorldWorkers {

    interface Worker {
        String kind();
        String detail();
        /** Returns true while still active; false once finished and its terminal event has fired. */
        boolean tick(MinecraftClient mc);
        void cancel(MinecraftClient mc, String reason, boolean cancelled);
        default void suspend(MinecraftClient mc) {}
        default void resume(MinecraftClient mc) {}
    }

    private final EventSink events;
    private final GameActions actions;
    private final BridgeConfig cfg;

    private Worker active;
    private String activeTaskId;
    private boolean suspended;

    public WorldWorkers(EventSink events, GameActions actions, BridgeConfig cfg) {
        this.events = events;
        this.actions = actions;
        this.cfg = cfg == null ? new BridgeConfig() : cfg;
    }

    public boolean handles(String type) {
        if (type == null) return false;
        return switch (type) {
            case Protocol.T_MINE_BRANCH,
                 Protocol.T_CLEAR_LEAVES,
                 Protocol.T_CHEST,
                 Protocol.T_SLEEP,
                 Protocol.T_HUNT,
                 Protocol.T_MANAGE_INV -> true;
            default -> false;
        };
    }

    public void dispatch(
            MinecraftClient mc,
            BaritoneBridge baritone,
            String taskId,
            Request req,
            ActionHandler.Responder out) throws ProtocolException {
        if (Protocol.T_MANAGE_INV.equals(req.type())) {
            out.ok(actions.manageInv(mc, req));
            return;
        }
        if (mc.player == null || mc.world == null || mc.player.isDead()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "she is not in a world");
        }

        JsonObject ack = new JsonObject();
        Worker next = switch (req.type()) {
            case Protocol.T_MINE_BRANCH -> BranchMiner.create(mc, actions, cfg, events, taskId, req, ack);
            case Protocol.T_CLEAR_LEAVES -> LeafClearer.create(mc, actions, events, taskId, req, ack);
            case Protocol.T_CHEST -> ChestWorker.create(mc, baritone, actions, cfg, events, taskId, req, ack);
            case Protocol.T_SLEEP -> SleepWorker.create(mc, baritone, actions, cfg, events, taskId, req, ack);
            case Protocol.T_HUNT -> Hunter.create(mc, actions, cfg, events, taskId, req, ack);
            default -> throw new ProtocolException(Protocol.E_UNKNOWN_TYPE, "unsupported world worker: " + req.type());
        };

        stopAll(mc);
        this.active = next;
        this.activeTaskId = taskId;
        this.suspended = false;
        out.ok(ack);
    }

    public void tick(MinecraftClient mc) {
        if (suspended || active == null) return;
        if (mc.player == null || mc.world == null || mc.player.isDead()) {
            cancelActive(mc, mc.player != null && mc.player.isDead() ? "died" : "left world", false);
            return;
        }
        try {
            if (!active.tick(mc)) {
                actions.releaseMovement(mc);
                actions.stopBreaking(mc);
                active = null;
                activeTaskId = null;
                suspended = false;
            }
        } catch (RuntimeException ex) {
            cancelActive(mc, ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage(), false);
        }
    }

    public void stopAll(MinecraftClient mc) {
        if (active != null) {
            cancelActive(mc, "stopped", true);
        } else {
            actions.releaseMovement(mc);
            actions.stopBreaking(mc);
        }
        suspended = false;
    }

    public void suspendForReflex() {
        if (active == null || suspended) return;
        MinecraftClient mc = MinecraftClient.getInstance();
        suspended = true;
        actions.releaseMovement(mc);
        actions.stopBreaking(mc);
        active.suspend(mc);
    }

    public void resumeIfSuspended() {
        if (active == null || !suspended) return;
        MinecraftClient mc = MinecraftClient.getInstance();
        suspended = false;
        active.resume(mc);
    }

    public RawObservation.PausedTaskState activeState() {
        if (active == null) return null;
        return new RawObservation.PausedTaskState(active.kind(), active.detail());
    }

    public boolean isBusy() {
        return active != null;
    }

    public String activeTaskId() {
        return activeTaskId;
    }

    private void cancelActive(MinecraftClient mc, String reason, boolean cancelled) {
        Worker w = active;
        active = null;
        activeTaskId = null;
        suspended = false;
        actions.releaseMovement(mc);
        actions.stopBreaking(mc);
        if (w != null) w.cancel(mc, reason, cancelled);
    }

    static void attachTask(JsonObject event, String taskId) {
        if (taskId != null && !taskId.isEmpty()) event.addProperty("task", taskId);
    }
}
