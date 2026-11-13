package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.config.BridgeConfig;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.util.Ids;
import dev.miyoria.bridge.util.LookMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.Entity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.Hand;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;

import java.util.Comparator;
import java.util.HashSet;
import java.util.Set;

/**
 * Hunts genuinely visible target entities within {@code entityRadius}, navigates safely around
 * cliffs/lava, fights using sword/axe/bow, and collects drops from kills. Client thread only.
 */
final class Hunter implements WorldWorkers.Worker {

    private static final Set<String> FOOD_MOBS = Set.of("cow", "pig", "sheep", "chicken", "rabbit", "mooshroom", "hoglin");
    private static final double MELEE_REACH = 3.2;
    private static final int MAX_CHASE_TICKS = 220;
    private static final int DROP_COLLECT_TICKS = 45;
    private static final int SEARCH_GRACE_TICKS = 15;
    private static final int BOW_DRAW_TICKS = 20;

    private final GameActions actions;
    private final EventSink events;
    private final String taskId;

    private final String requestedEntity;
    private final Set<String> targetTypes;
    private final int requestedCount;
    private final int range;

    private final Set<Integer> unreachableTargets = new HashSet<>();
    private Integer activeTargetId;
    private boolean engagedTarget;
    private Vec3d lastTargetPos;
    private int chaseTicks;
    private int sightLostTicks;
    private int dropTicks;
    private int noTargetTicks;
    private int bowChargingTicks;
    private int killed;
    private boolean terminated;

    private Hunter(
            GameActions actions,
            EventSink events,
            String taskId,
            String requestedEntity,
            Set<String> targetTypes,
            int requestedCount,
            int range) {
        this.actions = actions;
        this.events = events;
        this.taskId = taskId;
        this.requestedEntity = requestedEntity;
        this.targetTypes = targetTypes;
        this.requestedCount = requestedCount;
        this.range = range;
    }

    static Hunter create(
            MinecraftClient mc,
            GameActions actions,
            BridgeConfig cfg,
            EventSink events,
            String taskId,
            Request req,
            JsonObject ack) throws ProtocolException {
        String raw = req.str("entity").strip().toLowerCase();
        String norm = Ids.normalize(raw);
        if (norm.isEmpty()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "'entity' must not be empty");
        }
        Set<String> types = ("food".equals(norm) || "any_food".equals(norm) || "passive".equals(norm))
                ? FOOD_MOBS
                : Set.of(norm);
        int count = Math.max(1, Math.min(16, req.optInt("count", 1)));
        int range = Math.max(4, Math.min(48, req.optInt("range", cfg.entityRadius)));

        ack.addProperty("started", true);
        ack.addProperty("entity", norm);
        ack.addProperty("count", count);
        ack.addProperty("range", range);
        return new Hunter(actions, events, taskId, norm, types, count, range);
    }

    @Override
    public String kind() {
        return Protocol.T_HUNT;
    }

    @Override
    public String detail() {
        return requestedEntity + " " + killed + "/" + requestedCount;
    }

    @Override
    public void suspend(MinecraftClient mc) {
        bowChargingTicks = 0;
        chaseTicks = 0;
        sightLostTicks = 0;
    }

    @Override
    public void cancel(MinecraftClient mc, String reason, boolean cancelled) {
        bowChargingTicks = 0;
        emit("hunt_failed", reason, cancelled);
    }

    @Override
    public boolean tick(MinecraftClient mc) {
        if (terminated) return false;
        ClientPlayerEntity p = mc.player;
        ClientWorld w = mc.world;

        if (dropTicks > 0) {
            dropTicks--;
            if (stepTowardVisibleDrop(mc, p, w)) return true;
            dropTicks = 0;
        }

        if (killed >= requestedCount) {
            emit("hunt_finished", null, false);
            return false;
        }

        LivingEntity target = activeTargetId == null ? null : resolveLiving(w, activeTargetId);
        if (target == null || !target.isAlive()) {
            if (activeTargetId != null) {
                releaseBow(mc, p);
                if (engagedTarget) {
                    killed++;
                    dropTicks = DROP_COLLECT_TICKS;
                }
                activeTargetId = null;
                engagedTarget = false;
                chaseTicks = 0;
                sightLostTicks = 0;
                if (dropTicks > 0) return true;
                if (killed >= requestedCount) {
                    emit("hunt_finished", null, false);
                    return false;
                }
            }
            target = findNearestVisibleTarget(p, w);
            if (target == null) {
                actions.releaseMovement(mc);
                if (++noTargetTicks >= SEARCH_GRACE_TICKS) {
                    if (killed > 0) {
                        emit("hunt_finished", null, false);
                    } else {
                        emit("hunt_failed", "no visible " + requestedEntity + " within " + range + " blocks", false);
                    }
                    return false;
                }
                return true;
            }
            activeTargetId = target.getId();
            noTargetTicks = 0;
            chaseTicks = 0;
            sightLostTicks = 0;
            engagedTarget = false;
            lastTargetPos = target.getPos();
        }

        if (!p.canSee(target)) {
            if (++sightLostTicks > 20) {
                releaseBow(mc, p);
                unreachableTargets.add(target.getId());
                activeTargetId = null;
                actions.releaseMovement(mc);
                return true;
            }
        } else {
            sightLostTicks = 0;
            lastTargetPos = target.getPos();
        }

        double dist = p.distanceTo(target);
        if (++chaseTicks > MAX_CHASE_TICKS || dist > range + 10.0) {
            releaseBow(mc, p);
            unreachableTargets.add(target.getId());
            activeTargetId = null;
            actions.releaseMovement(mc);
            return true;
        }

        if (dist > 6.5 && dist <= 24.0 && p.canSee(target) && tryRangedBow(mc, p, target, dist)) {
            engagedTarget = true;
            return true;
        }
        releaseBow(mc, p);

        Vec3d aim = target.getBoundingBox().getCenter();
        actions.lookAt(p, aim, true);
        if (dist > 2.4) {
            if (!GameActions.isStepSafe(p, w, target.getPos())) {
                actions.releaseMovement(mc);
                unreachableTargets.add(target.getId());
                activeTargetId = null;
                return true;
            }
            actions.steerToward(mc, p, target.getPos(), dist > 5.0);
        } else {
            actions.releaseMovement(mc);
        }

        if (dist <= MELEE_REACH && p.getAttackCooldownProgress(0.5f) >= 0.95f && p.canSee(target)) {
            actions.selectBestMelee(mc);
            if (mc.interactionManager != null) {
                mc.interactionManager.attackEntity(p, target);
                p.swingHand(Hand.MAIN_HAND);
                engagedTarget = true;
                lastTargetPos = target.getPos();
            }
        }
        return true;
    }

    private boolean tryRangedBow(MinecraftClient mc, ClientPlayerEntity p, LivingEntity target, double dist) {
        if (!hasArrows(p)) return false;
        if (!actions.selectOrSwapItem(mc, s -> s.isOf(Items.BOW))) return false;
        actions.releaseMovement(mc);
        Vec3d aim = target.getEyePos().add(0, dist * 0.04, 0);
        Vec3d eye = p.getEyePos();
        LookMath.Rotation r = LookMath.toward(aim.x - eye.x, aim.y - eye.y, aim.z - eye.z);
        p.setYaw(LookMath.approachAngle(p.getYaw(), r.yaw(), 24f));
        p.setPitch(LookMath.clampPitch(LookMath.approachAngle(p.getPitch(), r.pitch(), 24f)));

        if (bowChargingTicks == 0) {
            mc.options.useKey.setPressed(true);
            bowChargingTicks = 1;
            return true;
        }
        mc.options.useKey.setPressed(true);
        if (++bowChargingTicks >= BOW_DRAW_TICKS) {
            mc.options.useKey.setPressed(false);
            if (mc.interactionManager != null) {
                mc.interactionManager.stopUsingItem(p);
            }
            bowChargingTicks = 0;
        }
        return true;
    }

    private void releaseBow(MinecraftClient mc, ClientPlayerEntity p) {
        if (bowChargingTicks > 0) {
            mc.options.useKey.setPressed(false);
            if (mc.interactionManager != null && p != null && p.isUsingItem()) {
                mc.interactionManager.stopUsingItem(p);
            }
            bowChargingTicks = 0;
        }
    }

    private boolean stepTowardVisibleDrop(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w) {
        Vec3d anchor = lastTargetPos != null ? lastTargetPos : p.getPos();
        Box search = Box.of(anchor, 8, 4, 8);
        ItemEntity nearest = w.getEntitiesByClass(ItemEntity.class, search, item ->
                        item.isAlive() && !item.cannotPickup() && p.canSee(item))
                .stream()
                .min(Comparator.comparingDouble(p::squaredDistanceTo))
                .orElse(null);
        if (nearest == null || p.distanceTo(nearest) > 7.5 || !GameActions.isStepSafe(p, w, nearest.getPos())) {
            actions.releaseMovement(mc);
            return false;
        }
        actions.steerToward(mc, p, nearest.getPos(), false);
        return true;
    }

    private LivingEntity findNearestVisibleTarget(ClientPlayerEntity p, ClientWorld w) {
        Box box = p.getBoundingBox().expand(range, 12, range);
        LivingEntity best = null;
        double bestDist = Double.MAX_VALUE;
        for (Entity e : w.getOtherEntities(p, box)) {
            if (!(e instanceof LivingEntity le) || !le.isAlive()) continue;
            if (unreachableTargets.contains(le.getId())) continue;
            String id = Ids.normalize(Registries.ENTITY_TYPE.getId(le.getType()).toString());
            if (!targetTypes.contains(id)) continue;
            double d = p.distanceTo(le);
            if (d > range) continue;
            if (!p.canSee(le)) continue;
            if (d < bestDist) {
                bestDist = d;
                best = le;
            }
        }
        return best;
    }

    private static LivingEntity resolveLiving(ClientWorld w, int id) {
        Entity e = w.getEntityById(id);
        return e instanceof LivingEntity le ? le : null;
    }

    private static boolean hasArrows(ClientPlayerEntity p) {
        for (int i = 0; i < p.getInventory().main.size(); i++) {
            ItemStack st = p.getInventory().main.get(i);
            if (!st.isEmpty() && st.isIn(ItemTags.ARROWS)) return true;
        }
        return false;
    }

    private void emit(String eventName, String error, boolean cancelled) {
        if (terminated) return;
        terminated = true;
        JsonObject d = new JsonObject();
        d.addProperty("entity", requestedEntity);
        d.addProperty("killed", killed);
        d.addProperty("requested", requestedCount);
        if (error != null) d.addProperty("error", error);
        if (cancelled) d.addProperty("cancelled", true);
        WorldWorkers.attachTask(d, taskId);
        events.emit(eventName, d);
    }
}
