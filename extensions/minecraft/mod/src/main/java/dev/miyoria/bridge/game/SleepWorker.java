package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.config.BridgeConfig;
import dev.miyoria.bridge.model.Models.BlockInfo;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.util.TimeOfDay;
import net.minecraft.block.Block;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.mob.Monster;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

import java.util.Set;
import java.util.stream.Collectors;

/**
 * Navigates to a visible bed, attempts sleep / spawn-point setting, and cleanly interprets
 * sleeping wake-up, daytime spawn-point behavior, and nearby monster blocks. Client thread only.
 */
final class SleepWorker implements WorldWorkers.Worker {

    private enum Phase {
        MOVE,
        INTERACT,
        WATCH
    }

    private static final int MOVE_TIMEOUT_TICKS = 200;
    private static final int INTERACT_SETTLE_TICKS = 3;
    private static final int ENTER_SLEEP_GRACE_TICKS = 25;
    private static final int SLEEP_WAKE_TIMEOUT_TICKS = 150;

    private final BaritoneBridge baritone;
    private final GameActions actions;
    private final EventSink events;
    private final String taskId;

    private final BlockPos bedPos;
    private final String bedBlock;

    private Phase phase = Phase.MOVE;
    private int ticks;
    private boolean usingBaritone;
    private boolean wasSleeping;
    private boolean terminated;

    private SleepWorker(
            BaritoneBridge baritone,
            GameActions actions,
            EventSink events,
            String taskId,
            BlockPos bedPos,
            String bedBlock) {
        this.baritone = baritone;
        this.actions = actions;
        this.events = events;
        this.taskId = taskId;
        this.bedPos = bedPos;
        this.bedBlock = bedBlock;
    }

    static SleepWorker create(
            MinecraftClient mc,
            BaritoneBridge baritone,
            GameActions actions,
            BridgeConfig cfg,
            EventSink events,
            String taskId,
            Request req,
            JsonObject ack) throws ProtocolException {
        if (!mc.world.getDimension().bedWorks()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "beds cannot be used in this dimension");
        }
        int radius = Math.max(3, Math.min(24, req.optInt("radius", cfg.blockScanRadius)));
        Set<Block> bedBlocks = Registries.BLOCK.stream()
                .filter(b -> b.getDefaultState().isIn(BlockTags.BEDS))
                .collect(Collectors.toSet());
        BlockInfo seen = BlockSight.nearestVisible(mc.player, mc.world, bedBlocks, radius);
        if (seen == null) {
            throw new ProtocolException(Protocol.E_NEEDS_STATION, "no bed in sight");
        }
        BlockPos pos = new BlockPos(seen.x(), seen.y(), seen.z());
        ack.addProperty("started", true);
        ack.addProperty("block", seen.block());
        ack.add("position", GameActions.posJson(pos));
        return new SleepWorker(baritone, actions, events, taskId, pos, seen.block());
    }

    @Override
    public String kind() {
        return Protocol.T_SLEEP;
    }

    @Override
    public String detail() {
        return bedBlock + " " + bedPos.getX() + "," + bedPos.getY() + "," + bedPos.getZ();
    }

    @Override
    public void suspend(MinecraftClient mc) {
        stopBaritone();
        phase = Phase.MOVE;
        ticks = 0;
        wasSleeping = false;
    }

    @Override
    public void cancel(MinecraftClient mc, String reason, boolean cancelled) {
        stopBaritone();
        emit("sleep_failed", false, false, null, reason, cancelled);
    }

    @Override
    public boolean tick(MinecraftClient mc) {
        if (terminated) return false;
        ClientPlayerEntity p = mc.player;
        ClientWorld w = mc.world;
        ticks++;

        switch (phase) {
            case MOVE -> {
                if (p.canInteractWithBlockAt(bedPos, 0)) {
                    stopBaritone();
                    actions.releaseMovement(mc);
                    actions.lookAt(p, Vec3d.ofCenter(bedPos), true);
                    phase = Phase.INTERACT;
                    ticks = 0;
                    return true;
                }
                if (ticks > MOVE_TIMEOUT_TICKS) {
                    stopBaritone();
                    emit("sleep_failed", false, false, null, "could not reach bed", false);
                    return false;
                }
                if (!usingBaritone && baritone != null && baritone.state().available()) {
                    usingBaritone = true;
                    baritone.reflexGoTo(bedPos);
                } else if (!usingBaritone) {
                    Vec3d dest = Vec3d.ofCenter(bedPos);
                    if (!GameActions.isStepSafe(p, w, dest)) {
                        emit("sleep_failed", false, false, null, "unsafe path to bed", false);
                        return false;
                    }
                    actions.steerToward(mc, p, dest, false);
                }
                return true;
            }
            case INTERACT -> {
                actions.lookAt(p, Vec3d.ofCenter(bedPos), true);
                if (ticks < INTERACT_SETTLE_TICKS) return true;
                if (!p.canInteractWithBlockAt(bedPos, 0)) {
                    phase = Phase.MOVE;
                    ticks = 0;
                    return true;
                }
                if (mc.interactionManager == null) {
                    emit("sleep_failed", false, false, null, "no interaction manager", false);
                    return false;
                }
                Vec3d center = Vec3d.ofCenter(bedPos);
                Direction face = Direction.getFacing(p.getEyePos().subtract(center));
                ActionResult r = mc.interactionManager.interactBlock(
                        p, Hand.MAIN_HAND, new BlockHitResult(center, face, bedPos, false));
                p.swingHand(Hand.MAIN_HAND);
                if (!r.isAccepted()) {
                    emit("sleep_failed", false, false, null, "bed refused interaction", false);
                    return false;
                }
                phase = Phase.WATCH;
                ticks = 0;
                wasSleeping = p.isSleeping();
                return true;
            }
            case WATCH -> {
                if (p.isSleeping()) {
                    wasSleeping = true;
                    if (ticks > SLEEP_WAKE_TIMEOUT_TICKS) {
                        emit("sleep_finished", true, true, "sleeping_multiplayer", null, false);
                        return false;
                    }
                    return true;
                }
                if (wasSleeping) {
                    boolean isDayNow = !TimeOfDay.isNight(w.getTimeOfDay()) && !w.isThundering();
                    if (isDayNow) {
                        emit("sleep_finished", true, true, "slept_until_morning", null, false);
                    } else {
                        emit("sleep_failed", false, true, "interrupted", "sleep was interrupted before morning", false);
                    }
                    return false;
                }
                if (ticks < ENTER_SLEEP_GRACE_TICKS) return true;

                boolean canRestTime = TimeOfDay.isNight(w.getTimeOfDay()) || w.isThundering();
                if (!canRestTime) {
                    emit("sleep_finished", false, true, "daytime_spawn_set", null, false);
                    return false;
                }
                boolean monstersNearby = !w.getEntitiesByClass(
                        LivingEntity.class, Box.of(Vec3d.ofCenter(bedPos), 16, 10, 16),
                        e -> e instanceof Monster && e.isAlive()).isEmpty();
                String err = monstersNearby ? "monsters nearby" : "could not sleep in bed";
                emit("sleep_failed", false, false, monstersNearby ? "monsters_nearby" : "blocked", err, false);
                return false;
            }
        }
        return false;
    }

    private void stopBaritone() {
        if (usingBaritone && baritone != null) {
            baritone.reflexCancel();
            usingBaritone = false;
        }
    }

    private void emit(
            String eventName,
            boolean slept,
            boolean spawnSet,
            String detail,
            String error,
            boolean cancelled) {
        if (terminated) return;
        terminated = true;
        JsonObject d = new JsonObject();
        d.addProperty("block", bedBlock);
        d.add("position", GameActions.posJson(bedPos));
        d.addProperty("slept", slept);
        d.addProperty("spawn_set", spawnSet);
        if (detail != null) d.addProperty("detail", detail);
        if (error != null) d.addProperty("error", error);
        if (cancelled) d.addProperty("cancelled", true);
        WorldWorkers.attachTask(d, taskId);
        events.emit(eventName, d);
    }
}
