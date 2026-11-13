package dev.miyoria.bridge.game;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.miyoria.bridge.config.BridgeConfig;
import dev.miyoria.bridge.model.Models.BlockInfo;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.util.Ids;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.screen.GenericContainerScreenHandler;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Opens a genuinely visible chest/trapped_chest/barrel via GUI, reports observed container
 * slots ({@code chest_contents}), and executes {@code inspect}, {@code store}, or {@code take}.
 */
final class ChestWorker implements WorldWorkers.Worker {

    private enum Phase {
        MOVE,
        OPEN,
        WAIT_OPEN,
        WORK
    }

    private static final int MOVE_TIMEOUT_TICKS = 200;
    private static final int OPEN_TIMEOUT_TICKS = 40;
    private static final int LOOK_SETTLE_TICKS = 3;

    private final BaritoneBridge baritone;
    private final GameActions actions;
    private final EventSink events;
    private final String taskId;

    private final String op;
    private final BlockPos stationPos;
    private final String stationBlock;
    private final Map<String, Integer> requestedItems; // null = wildcard, count <= 0 = all
    private final Set<String> keepItems;

    private Phase phase = Phase.MOVE;
    private int ticks;
    private boolean usingBaritone;
    private boolean terminated;

    private ChestWorker(
            BaritoneBridge baritone,
            GameActions actions,
            EventSink events,
            String taskId,
            String op,
            BlockPos stationPos,
            String stationBlock,
            Map<String, Integer> requestedItems,
            Set<String> keepItems) {
        this.baritone = baritone;
        this.actions = actions;
        this.events = events;
        this.taskId = taskId;
        this.op = op;
        this.stationPos = stationPos;
        this.stationBlock = stationBlock;
        this.requestedItems = requestedItems;
        this.keepItems = keepItems;
    }

    static ChestWorker create(
            MinecraftClient mc,
            BaritoneBridge baritone,
            GameActions actions,
            BridgeConfig cfg,
            EventSink events,
            String taskId,
            Request req,
            JsonObject ack) throws ProtocolException {
        String op = req.str("op").toLowerCase();
        if (!"inspect".equals(op) && !"store".equals(op) && !"take".equals(op)) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "chest op must be 'inspect', 'store', or 'take'");
        }
        int radius = Math.max(3, Math.min(24, req.optInt("radius", cfg.blockScanRadius)));
        Map<String, Integer> items = parseItems(req);
        Set<String> keep = parseKeep(req);

        BlockInfo seen = BlockSight.nearestVisible(
                mc.player, mc.world, Set.of(Blocks.CHEST, Blocks.TRAPPED_CHEST, Blocks.BARREL), radius);
        if (seen == null) {
            throw new ProtocolException(Protocol.E_NEEDS_STATION, "no chest or barrel in sight");
        }
        BlockPos pos = new BlockPos(seen.x(), seen.y(), seen.z());
        ack.addProperty("started", true);
        ack.addProperty("op", op);
        ack.addProperty("block", seen.block());
        ack.add("position", GameActions.posJson(pos));
        return new ChestWorker(baritone, actions, events, taskId, op, pos, seen.block(), items, keep);
    }

    private static Map<String, Integer> parseItems(Request req) throws ProtocolException {
        if (!req.has("items")) return null;
        JsonElement raw = req.body().get("items");
        Map<String, Integer> out = new LinkedHashMap<>();
        if (raw.isJsonArray()) {
            for (JsonElement el : raw.getAsJsonArray()) {
                if (el.isJsonPrimitive()) {
                    String id = Ids.normalize(el.getAsString());
                    if (!id.isEmpty()) out.put(id, -1);
                }
            }
            return out;
        }
        if (raw.isJsonObject()) {
            for (var en : raw.getAsJsonObject().entrySet()) {
                String id = Ids.normalize(en.getKey());
                int n = en.getValue().isJsonPrimitive() && en.getValue().getAsJsonPrimitive().isNumber()
                        ? en.getValue().getAsInt() : -1;
                if (!id.isEmpty()) out.put(id, n);
            }
            return out;
        }
        throw new ProtocolException(Protocol.E_INVALID_ARGS, "'items' must be an array or {item: count} map");
    }

    private static Set<String> parseKeep(Request req) throws ProtocolException {
        Set<String> out = new HashSet<>();
        if (!req.has("keep")) return out;
        JsonElement raw = req.body().get("keep");
        if (!raw.isJsonArray()) throw new ProtocolException(Protocol.E_INVALID_ARGS, "'keep' must be an array");
        for (JsonElement el : raw.getAsJsonArray()) {
            if (el.isJsonPrimitive()) {
                String id = Ids.normalize(el.getAsString());
                if (!id.isEmpty()) out.add(id);
            }
        }
        return out;
    }

    @Override
    public String kind() {
        return Protocol.T_CHEST;
    }

    @Override
    public String detail() {
        return op + " " + stationBlock + " " + stationPos.getX() + "," + stationPos.getY() + "," + stationPos.getZ();
    }

    @Override
    public void suspend(MinecraftClient mc) {
        stopBaritone();
        closeIfContainerOpen(mc != null ? mc.player : null);
        phase = Phase.MOVE;
        ticks = 0;
    }

    @Override
    public void cancel(MinecraftClient mc, String reason, boolean cancelled) {
        stopBaritone();
        closeIfContainerOpen(mc != null ? mc.player : null);
        emitTerminal("chest_failed", null, Map.of(), reason, cancelled);
    }

    @Override
    public boolean tick(MinecraftClient mc) {
        if (terminated) return false;
        ClientPlayerEntity p = mc.player;
        ClientWorld w = mc.world;
        ticks++;

        switch (phase) {
            case MOVE -> {
                if (p.canInteractWithBlockAt(stationPos, 0)) {
                    stopBaritone();
                    actions.releaseMovement(mc);
                    actions.lookAt(p, Vec3d.ofCenter(stationPos), true);
                    phase = Phase.OPEN;
                    ticks = 0;
                    return true;
                }
                if (ticks > MOVE_TIMEOUT_TICKS) {
                    stopBaritone();
                    emitTerminal("chest_failed", null, Map.of(), "could not reach " + stationBlock, false);
                    return false;
                }
                if (!usingBaritone && baritone != null && baritone.state().available()) {
                    usingBaritone = true;
                    baritone.reflexGoTo(stationPos);
                } else if (!usingBaritone) {
                    Vec3d dest = Vec3d.ofCenter(stationPos);
                    if (!GameActions.isStepSafe(p, w, dest)) {
                        emitTerminal("chest_failed", null, Map.of(), "unsafe path to " + stationBlock, false);
                        return false;
                    }
                    actions.steerToward(mc, p, dest, false);
                }
                return true;
            }
            case OPEN -> {
                actions.lookAt(p, Vec3d.ofCenter(stationPos), true);
                if (ticks < LOOK_SETTLE_TICKS) return true;
                if (!p.canInteractWithBlockAt(stationPos, 0)) {
                    phase = Phase.MOVE;
                    ticks = 0;
                    return true;
                }
                if (mc.interactionManager == null) {
                    emitTerminal("chest_failed", null, Map.of(), "no interaction manager", false);
                    return false;
                }
                Vec3d center = Vec3d.ofCenter(stationPos);
                Direction face = Direction.getFacing(p.getEyePos().subtract(center));
                ActionResult r = mc.interactionManager.interactBlock(
                        p, Hand.MAIN_HAND, new BlockHitResult(center, face, stationPos, false));
                if (!r.isAccepted()) {
                    emitTerminal("chest_failed", null, Map.of(), stationBlock + " refused interaction", false);
                    return false;
                }
                p.swingHand(Hand.MAIN_HAND);
                phase = Phase.WAIT_OPEN;
                ticks = 0;
                return true;
            }
            case WAIT_OPEN -> {
                if (p.currentScreenHandler instanceof GenericContainerScreenHandler) {
                    phase = Phase.WORK;
                    ticks = 0;
                    return true;
                }
                if (ticks > OPEN_TIMEOUT_TICKS) {
                    emitTerminal("chest_failed", null, Map.of(), "could not open " + stationBlock, false);
                    return false;
                }
                return true;
            }
            case WORK -> {
                if (!(p.currentScreenHandler instanceof GenericContainerScreenHandler h)) {
                    emitTerminal("chest_failed", null, Map.of(), stationBlock + " closed unexpectedly", false);
                    return false;
                }
                int containerSize = h.getRows() * 9;
                Map<String, Integer> contents = snapshotSlots(h, 0, containerSize);
                emitContents(h.getRows(), contents);

                Map<String, Integer> moved = new LinkedHashMap<>();
                if ("store".equals(op) && mc.interactionManager != null) {
                    transferStore(mc, p, h, containerSize, moved);
                } else if ("take".equals(op) && mc.interactionManager != null) {
                    transferTake(mc, p, h, containerSize, moved);
                }

                Map<String, Integer> finalContents = "inspect".equals(op) ? contents : snapshotSlots(h, 0, containerSize);
                p.closeHandledScreen();
                emitTerminal("chest_finished", finalContents, moved, null, false);
                return false;
            }
        }
        return false;
    }

    private void transferStore(
            MinecraftClient mc,
            ClientPlayerEntity p,
            GenericContainerScreenHandler h,
            int containerSize,
            Map<String, Integer> moved) {
        Map<String, Integer> remaining = requestedItems == null ? null : new HashMap<>(requestedItems);
        for (int slot = containerSize; slot < h.slots.size(); slot++) {
            ItemStack st = h.getSlot(slot).getStack();
            if (st.isEmpty()) continue;
            String id = Ids.normalize(Registries.ITEM.getId(st.getItem()).toString());
            if (keepItems.contains(id)) continue;
            if (remaining != null) {
                if (!remaining.containsKey(id)) continue;
                int want = remaining.get(id);
                if (want == 0) continue;
            }
            int before = st.getCount();
            mc.interactionManager.clickSlot(h.syncId, slot, 0, SlotActionType.QUICK_MOVE, p);
            int after = h.getSlot(slot).getStack().getCount();
            int delta = before - after;
            if (delta > 0) {
                moved.merge(id, delta, Integer::sum);
                if (remaining != null && remaining.get(id) > 0) {
                    remaining.put(id, Math.max(0, remaining.get(id) - delta));
                }
            }
        }
    }

    private void transferTake(
            MinecraftClient mc,
            ClientPlayerEntity p,
            GenericContainerScreenHandler h,
            int containerSize,
            Map<String, Integer> moved) {
        Map<String, Integer> remaining = requestedItems == null ? null : new HashMap<>(requestedItems);
        for (int slot = 0; slot < containerSize; slot++) {
            ItemStack st = h.getSlot(slot).getStack();
            if (st.isEmpty()) continue;
            String id = Ids.normalize(Registries.ITEM.getId(st.getItem()).toString());
            if (remaining != null) {
                if (!remaining.containsKey(id)) continue;
                int want = remaining.get(id);
                if (want == 0) continue;
            }
            int before = st.getCount();
            mc.interactionManager.clickSlot(h.syncId, slot, 0, SlotActionType.QUICK_MOVE, p);
            int after = h.getSlot(slot).getStack().getCount();
            int delta = before - after;
            if (delta > 0) {
                moved.merge(id, delta, Integer::sum);
                if (remaining != null && remaining.get(id) > 0) {
                    remaining.put(id, Math.max(0, remaining.get(id) - delta));
                }
            }
        }
    }

    private static Map<String, Integer> snapshotSlots(GenericContainerScreenHandler h, int from, int toExclusive) {
        Map<String, Integer> out = new LinkedHashMap<>();
        int end = Math.min(toExclusive, h.slots.size());
        for (int i = from; i < end; i++) {
            ItemStack st = h.getSlot(i).getStack();
            if (st.isEmpty()) continue;
            String id = Ids.normalize(Registries.ITEM.getId(st.getItem()).toString());
            out.merge(id, st.getCount(), Integer::sum);
        }
        return out;
    }

    private void emitContents(int rows, Map<String, Integer> contents) {
        JsonObject d = new JsonObject();
        d.add("position", GameActions.posJson(stationPos));
        d.addProperty("block", stationBlock);
        d.addProperty("rows", rows);
        d.add("items", toJsonMap(contents));
        WorldWorkers.attachTask(d, taskId);
        events.emit("chest_contents", d);
    }

    private void emitTerminal(
            String eventName,
            Map<String, Integer> contents,
            Map<String, Integer> moved,
            String error,
            boolean cancelled) {
        if (terminated) return;
        terminated = true;
        JsonObject d = new JsonObject();
        d.addProperty("op", op);
        d.addProperty("block", stationBlock);
        d.add("position", GameActions.posJson(stationPos));
        if (contents != null) d.add("items", toJsonMap(contents));
        if (!moved.isEmpty() || "store".equals(op) || "take".equals(op)) d.add("moved", toJsonMap(moved));
        if (error != null) d.addProperty("error", error);
        if (cancelled) d.addProperty("cancelled", true);
        WorldWorkers.attachTask(d, taskId);
        events.emit(eventName, d);
    }

    private static JsonObject toJsonMap(Map<String, Integer> map) {
        JsonObject o = new JsonObject();
        for (var en : map.entrySet()) o.addProperty(en.getKey(), en.getValue());
        return o;
    }

    private void stopBaritone() {
        if (usingBaritone && baritone != null) {
            baritone.reflexCancel();
            usingBaritone = false;
        }
    }

    private static void closeIfContainerOpen(ClientPlayerEntity p) {
        if (p != null && p.currentScreenHandler instanceof GenericContainerScreenHandler) {
            p.closeHandledScreen();
        }
    }
}
