package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.model.Models.BlockInfo;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.Request;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.HoeItem;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.item.ToolItem;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Breaks nearby obstructing leaves along clear line of sight so trunks and canopy paths open up
 * without wasting high-tier pickaxe/sword durability. Client thread only.
 */
final class LeafClearer implements WorldWorkers.Worker {

    private static final int MOVE_TIMEOUT_TICKS = 60;
    private static final int BREAK_TIMEOUT_TICKS = 80;

    private final GameActions actions;
    private final EventSink events;
    private final String taskId;
    private final int radius;
    private final int maxBlocks;

    private final Set<BlockPos> unreachable = new HashSet<>();
    private BlockPos target;
    private boolean breakStarted;
    private int moveTicks;
    private int breakTicks;
    private int broken;
    private boolean terminated;

    private LeafClearer(GameActions actions, EventSink events, String taskId, int radius, int maxBlocks) {
        this.actions = actions;
        this.events = events;
        this.taskId = taskId;
        this.radius = radius;
        this.maxBlocks = maxBlocks;
    }

    static LeafClearer create(
            MinecraftClient mc,
            GameActions actions,
            EventSink events,
            String taskId,
            Request req,
            JsonObject ack) throws dev.miyoria.bridge.protocol.ProtocolException {
        int radius = Math.max(2, Math.min(10, req.optInt("radius", 5)));
        int maxBlocks = Math.max(1, Math.min(128, req.optInt("max_blocks", 24)));
        ack.addProperty("started", true);
        ack.addProperty("radius", radius);
        ack.addProperty("max_blocks", maxBlocks);
        return new LeafClearer(actions, events, taskId, radius, maxBlocks);
    }

    @Override
    public String kind() {
        return Protocol.T_CLEAR_LEAVES;
    }

    @Override
    public String detail() {
        return "broken=" + broken + "/" + maxBlocks;
    }

    @Override
    public void suspend(MinecraftClient mc) {
        target = null;
        breakStarted = false;
        moveTicks = 0;
        breakTicks = 0;
    }

    @Override
    public void cancel(MinecraftClient mc, String reason, boolean cancelled) {
        emit("clear_leaves_failed", reason, cancelled);
    }

    @Override
    public boolean tick(MinecraftClient mc) {
        if (terminated) return false;
        if (broken >= maxBlocks) {
            emit("clear_leaves_finished", null, false);
            return false;
        }
        ClientPlayerEntity p = mc.player;
        ClientWorld w = mc.world;

        if (target == null || !w.getBlockState(target).isIn(BlockTags.LEAVES)) {
            if (target != null && w.getBlockState(target).isAir()) {
                broken++;
                if (broken >= maxBlocks) {
                    emit("clear_leaves_finished", null, false);
                    return false;
                }
            }
            target = pickNextLeaf(p, w);
            breakStarted = false;
            moveTicks = 0;
            breakTicks = 0;
            if (target == null) {
                emit("clear_leaves_finished", null, false);
                return false;
            }
        }

        if (!p.canInteractWithBlockAt(target, 0)) {
            actions.stopBreaking(mc);
            breakStarted = false;
            Vec3d dest = Vec3d.ofCenter(target);
            if (!GameActions.isStepSafe(p, w, dest) || ++moveTicks > MOVE_TIMEOUT_TICKS) {
                unreachable.add(target);
                target = null;
                actions.releaseMovement(mc);
                return true;
            }
            actions.steerToward(mc, p, dest, false);
            return true;
        }

        actions.releaseMovement(mc);
        selectLeafTool(mc, p);
        boolean gone = actions.breakBlockTick(mc, p, target, !breakStarted);
        breakStarted = true;
        if (gone || !w.getBlockState(target).isIn(BlockTags.LEAVES)) {
            target = null;
            broken++;
            if (broken >= maxBlocks) {
                emit("clear_leaves_finished", null, false);
                return false;
            }
            return true;
        }
        if (++breakTicks > BREAK_TIMEOUT_TICKS) {
            actions.stopBreaking(mc);
            unreachable.add(target);
            target = null;
        }
        return true;
    }

    private BlockPos pickNextLeaf(ClientPlayerEntity p, ClientWorld w) {
        List<BlockInfo> leaves = BlockSight.visibleLeaves(p, w, radius, 24);
        int eyeY = p.getBlockY() + 1;
        return leaves.stream()
                .map(b -> new BlockPos(b.x(), b.y(), b.z()))
                .filter(pos -> !unreachable.contains(pos))
                .filter(pos -> {
                    BlockState st = w.getBlockState(pos);
                    return st.isIn(BlockTags.LEAVES);
                })
                .min(Comparator.comparingDouble(pos -> {
                    double dist = p.getEyePos().distanceTo(Vec3d.ofCenter(pos));
                    double eyeBias = Math.abs(pos.getY() - eyeY) * 0.75;
                    return dist + eyeBias;
                }))
                .orElse(null);
    }

    private void selectLeafTool(MinecraftClient mc, ClientPlayerEntity p) {
        if (actions.selectOrSwapItem(mc, s -> s.isOf(Items.SHEARS))) return;
        if (actions.selectOrSwapItem(mc, s -> s.getItem() instanceof HoeItem)) return;
        PlayerInventory inv = p.getInventory();
        ItemStack held = p.getMainHandStack();
        if (held.getItem() instanceof ToolItem) {
            for (int i = 0; i < 9; i++) {
                ItemStack st = inv.main.get(i);
                if (st.isEmpty() || !(st.getItem() instanceof ToolItem)) {
                    inv.selectedSlot = i;
                    return;
                }
            }
        }
    }

    private void emit(String event, String error, boolean cancelled) {
        if (terminated) return;
        terminated = true;
        JsonObject d = new JsonObject();
        d.addProperty("broken", broken);
        d.addProperty("max_blocks", maxBlocks);
        if (error != null) d.addProperty("error", error);
        if (cancelled) d.addProperty("cancelled", true);
        WorldWorkers.attachTask(d, taskId);
        events.emit(event, d);
    }
}
