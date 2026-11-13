package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.reflex.CombatLogic;
import dev.miyoria.bridge.reflex.InventoryLogic;
import dev.miyoria.bridge.reflex.InventoryLogic.ArmorUpgrade;
import dev.miyoria.bridge.reflex.InventoryLogic.Equipped;
import dev.miyoria.bridge.reflex.InventoryLogic.ScanResult;
import dev.miyoria.bridge.reflex.InventoryLogic.SlotItem;
import dev.miyoria.bridge.reflex.ReflexBrain;
import dev.miyoria.bridge.reflex.ReflexBrain.Kind;
import dev.miyoria.bridge.reflex.ReflexBrain.Sense;
import dev.miyoria.bridge.reflex.ReflexBrain.Step;
import dev.miyoria.bridge.reflex.ReflexBrain.Threat;
import dev.miyoria.bridge.util.Ids;
import dev.miyoria.bridge.util.LookMath;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.FoodComponent;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EquipmentSlot;
import net.minecraft.entity.FallingBlockEntity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.mob.AbstractSkeletonEntity;
import net.minecraft.entity.mob.Angerable;
import net.minecraft.entity.mob.CreeperEntity;
import net.minecraft.entity.mob.IllagerEntity;
import net.minecraft.entity.mob.MobEntity;
import net.minecraft.entity.mob.Monster;
import net.minecraft.entity.mob.PillagerEntity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.util.shape.VoxelShape;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The game side of the survival reflexes ({@link ReflexBrain} decides which one): samples what her
 * body feels every tick and carries out the active reflex the way a player would: movement keys,
 * shield raising, crit-jump melee with strafing, ballistic bow shooting, MLG water bucket,
 * self-extinguish, emergency pillar escape, auto-torch placement, auto-equip across all 36 slots,
 * food, and Baritone for longer walks. Every target is something she can see. Client thread only.
 */
public final class Reflexes {
    /** Extended behavioral knobs controlling combat, MLG water, auto-equip, auto-torch, and task pause/resume. */
    public record ExtendedConfig(
            boolean autoEquip,
            boolean shieldBlock,
            boolean mlgWater,
            double mlgMinFallDistance,
            boolean autoTorch,
            int autoTorchMaxLight,
            boolean pillarEscape,
            int pausedResumeMaxSecs,
            double pausedMaxDrift
    ) {
        public static final ExtendedConfig DEFAULT = new ExtendedConfig(
                true, true, true, 4.0, true, 7, true, 15, 16.0);

        public static ExtendedConfig fromBrain(ReflexBrain.ReflexConfig rc) {
            if (rc == null) return DEFAULT;
            return new ExtendedConfig(
                    rc.autoEquip(),
                    rc.shieldBlock(),
                    rc.mlgWater(),
                    rc.mlgMinFallDistance(),
                    rc.autoTorch(),
                    rc.autoTorchMaxLight(),
                    rc.pillarEscape(),
                    DEFAULT.pausedResumeMaxSecs(),
                    DEFAULT.pausedMaxDrift()
            );
        }
    }

    private record TorchSpot(BlockPos attachPos, Direction face, Vec3d hitPos) {}

    private static final double THREAT_RADIUS = 16.0;
    private static final double PICKUP_RADIUS = 6.0;
    /** Survival attack reach. */
    private static final double REACH = 3.0;
    private static final float TURN_DEG_PER_TICK = 40f;
    private static final int OFFHAND_SCREEN_SLOT = 45;
    private static final int AUTO_EQUIP_INTERVAL_TICKS = 10;
    private static final int TIDY_DROP_INTERVAL_TICKS = 40;
    private static final int BOW_FULL_CHARGE_TICKS = 22;
    private static final double ARROW_SPEED = 3.0;
    private static final double ARROW_GRAVITY = 0.05;
    /** Ticks between two AltoClef checks (reflection); AltoClef has its own reflexes. */
    private static final int ALTO_CHECK_TICKS = 20;
    private static final Sense INACTIVE = new Sense(false, false, false, false, 300, 300, false, false,
            20f, 20, false, null, false, false, false, 0, 0, 0, false);

    private final ReflexBrain brain;
    private final EventSink events;
    private final GameActions actions;
    private final Workbench workbench;
    private final AltoClefBridge alto;
    private final Set<KeyBinding> pressed = new HashSet<>();

    private TaskTracker tasks;
    private ExtendedConfig extConfig;

    private long tickCount;
    private long lastAutoEquipTick = -AUTO_EQUIP_INTERVAL_TICKS;
    private long lastTidyDropTick = -TIDY_DROP_INTERVAL_TICKS;
    private boolean altoBusy;

    // active reflex + task suspension state
    private String interrupted;
    private boolean pausedTask;
    private int ticks;
    private Vec3d spot;
    private Entity target;
    private int restoreSlot = -1;
    /** Storage slot swapped transiently into hotbar (-1 when already in hotbar). */
    private int swappedFrom = -1;
    private int foodBefore;
    private int countBefore;
    private Item eating;
    private ItemEntity drop;
    private int dropTicks;
    private final Set<Integer> unreachable = new HashSet<>();
    private final Map<String, Long> ignoredDropUntil = new HashMap<>();
    private int unstuckAttempts;
    private Vec3d startPos;

    // water extinguish / MLG state
    private BlockPos waterPlacedAt;
    private boolean mlgWaterPlaced;
    private int mlgLandTicks;
    private boolean extinguishPlaced;

    // pillar retreat state
    private double pillarStartY;
    private double pillarTargetY;
    private int lastPillarPlaceTick = -10;

    // combat bow/crit state
    private int bowCooldownTicks;
    private int critWaitTicks;
    private TorchSpot pendingTorchSpot;

    public Reflexes(ReflexBrain brain, EventSink events, GameActions actions, Workbench workbench, AltoClefBridge alto) {
        this(brain, events, actions, workbench, alto, null, ExtendedConfig.fromBrain(brain.reflexConfig()));
    }

    public Reflexes(ReflexBrain brain, EventSink events, GameActions actions, Workbench workbench, AltoClefBridge alto,
                    ExtendedConfig extConfig) {
        this(brain, events, actions, workbench, alto, null, extConfig);
    }

    public Reflexes(ReflexBrain brain, EventSink events, GameActions actions, Workbench workbench, AltoClefBridge alto,
                    TaskTracker tasks, ExtendedConfig extConfig) {
        this.brain = brain;
        this.events = events;
        this.actions = actions;
        this.workbench = workbench;
        this.alto = alto;
        this.tasks = tasks;
        this.extConfig = extConfig != null ? extConfig : ExtendedConfig.fromBrain(brain.reflexConfig());
    }

    public void setTaskTracker(TaskTracker tasks) {
        this.tasks = tasks;
    }

    public void setExtendedConfig(ExtendedConfig extConfig) {
        this.extConfig = extConfig != null ? extConfig : ExtendedConfig.DEFAULT;
    }

    public ExtendedConfig extendedConfig() {
        return extConfig;
    }

    /** Protocol id of the active reflex, or null. */
    public String active() {
        Kind k = brain.active();
        return k == null ? null : k.id();
    }

    /** Requests wait (are refused with {@code reflex_active}) while this is true. */
    public boolean blocksRequests() {
        return brain.blocksRequests();
    }

    /** Whether the currently active reflex is recoverable (transient interrupt that can resume Baritone). */
    public boolean isRecoverableReflex() {
        Kind k = brain.active();
        return k != null && ReflexBrain.isRecoverable(k);
    }

    /** Whether a Baritone task is currently suspended waiting for a recoverable reflex to end. */
    public boolean isPaused() {
        return pausedTask;
    }

    /** A request or {@code stop} wants her body: a pickup (or another non-urgent reflex) gives way. */
    public void yieldTo(MinecraftClient mc, BaritoneBridge baritone) {
        Kind k = brain.yieldNonUrgent();
        if (k != null) {
            stop(mc, k, baritone);
            if (pausedTask) {
                pausedTask = false;
                if (baritone != null) baritone.clearSuspended();
                if (tasks != null) tasks.abortPaused("yielded");
            }
            ended(k, false, true);
        }
    }

    public void tick(MinecraftClient mc, BaritoneBridge baritone) {
        tickCount++;
        if (mc.isPaused()) return; // single-player pause: the world stands still too
        ClientPlayerEntity p = mc.player;
        ClientWorld w = mc.world;
        boolean alive = p != null && w != null && p.isAlive() && !(mc.currentScreen instanceof DeathScreen);
        if (alto.available() && tickCount % ALTO_CHECK_TICKS == 0) {
            altoBusy = Boolean.TRUE.equals(alto.state().busy());
        }
        if (pausedTask && tasks != null && !tasks.isPaused()) {
            // Task ended externally (e.g. client issued stop/new task); drop suspended command.
            pausedTask = false;
            if (baritone != null) baritone.clearSuspended();
        }

        List<SlotItem> mainSlots = null;
        ScanResult scan = null;
        TorchSpot torchSpot = null;
        Sense s = INACTIVE;
        if (alive && !altoBusy) {
            mainSlots = readMainSlots(p);
            scan = InventoryLogic.scan(mainSlots, readEquipped(p), p.getHealth());
            torchSpot = findTorchSpotIfNeeded(p, w, scan);
            s = sense(mc, p, w, baritone, scan, torchSpot);
        }

        Step step = brain.tick(s);
        if (step.ended() != null) {
            stop(mc, step.ended(), baritone);
            resolvePausedTaskOnEnd(p, baritone, step.ended(), step.started(), step.endedOk());
            ended(step.ended(), step.endedOk(), false);
        }
        if (step.started() != null) {
            start(mc, p, w, step.started(), s, baritone, mainSlots, scan, torchSpot);
        }
        if (step.active() != null) {
            ticks++;
            run(mc, p, w, step.active(), baritone, mainSlots, scan);
        } else if (alive && !altoBusy && scan != null) {
            autoEquipTick(mc, p, scan, mainSlots);
        }
    }

    // ------------------------------------------------------------------ sensing + inventory

    private static List<SlotItem> readMainSlots(ClientPlayerEntity p) {
        PlayerInventory inv = p.getInventory();
        int size = Math.min(InventoryLogic.MAIN_SLOTS, inv.main.size());
        List<SlotItem> out = new ArrayList<>(size);
        for (int i = 0; i < size; i++) {
            ItemStack st = inv.main.get(i);
            if (!st.isEmpty()) {
                out.add(toSlotItem(i, st));
            }
        }
        return out;
    }

    private static Equipped readEquipped(ClientPlayerEntity p) {
        return new Equipped(
                toSlotItem(-1, p.getEquippedStack(EquipmentSlot.HEAD)),
                toSlotItem(-1, p.getEquippedStack(EquipmentSlot.CHEST)),
                toSlotItem(-1, p.getEquippedStack(EquipmentSlot.LEGS)),
                toSlotItem(-1, p.getEquippedStack(EquipmentSlot.FEET)),
                toSlotItem(-1, p.getEquippedStack(EquipmentSlot.OFFHAND))
        );
    }

    private static SlotItem toSlotItem(int slot, ItemStack st) {
        if (st == null || st.isEmpty()) return null;
        Integer durPct = null;
        if (st.isDamageable() && st.getMaxDamage() > 0) {
            durPct = Math.max(0, Math.min(100,
                    (int) Math.round(100.0 * (st.getMaxDamage() - st.getDamage()) / st.getMaxDamage())));
        }
        FoodComponent food = st.get(DataComponentTypes.FOOD);
        Integer nutrition = food != null ? food.nutrition() : null;
        return new SlotItem(slot, Workbench.id(st.getItem()), st.getCount(), durPct, nutrition);
    }

    private TorchSpot findTorchSpotIfNeeded(ClientPlayerEntity p, ClientWorld w, ScanResult scan) {
        if (!extConfig.autoTorch() || !scan.hasTorch()) return null;
        int light = w.getLightLevel(p.getBlockPos());
        if (light > extConfig.autoTorchMaxLight()) return null;
        return findTorchSpot(p, w);
    }

    private Sense sense(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w, BaritoneBridge baritone,
                        ScanResult scan, TorchSpot torchSpot) {
        boolean baritoneTask = baritone != null && baritone.state().busy() && !baritone.reflexDriving();
        boolean busy = baritoneTask || workbench.state() != null || actions.holding() || pausedTask;
        int food = p.getHungerManager().getFoodLevel();
        boolean screenFree = mc.currentScreen == null || workbench.state() != null;
        boolean starving = food <= 4;
        boolean hasFood = screenFree && food <= brain.config().eatFood() && scan.hasEdibleFood(starving);
        boolean drops = (!busy || brain.active() == Kind.PICKUP) && nearestDrop(p, w) != null;

        List<CombatLogic.Threat> combatThreats = collectCombatThreats(p, w);
        CombatLogic.Threat primary = combatThreats.isEmpty() ? null : combatThreats.get(0);
        Threat legacyThreat = primary == null ? null
                : new Threat(primary.type(), primary.distance(), primary.creeper());

        boolean inLava = p.isInLava();
        boolean inFire = w.getBlockState(p.getBlockPos()).isIn(BlockTags.FIRE);
        boolean submerged = p.isSubmergedInWater();
        boolean inWater = submerged || p.isTouchingWater();
        boolean onFire = p.isOnFire() && !inLava && !submerged;

        double fallDist = extConfig.mlgWater() && p.fallDistance >= extConfig.mlgMinFallDistance()
                ? p.fallDistance : 0.0;
        double groundDist = fallDist > 0.0 ? groundDistanceBelow(p, w, 12.0) : Double.POSITIVE_INFINITY;

        boolean shieldReady = extConfig.shieldBlock()
                && (scan.offhandHasShield() || (extConfig.autoEquip() && scan.shieldSlot() >= 0));
        boolean shieldCooling = p.getItemCooldownManager().isCoolingDown(Items.SHIELD);
        int lightLevel = w.getLightLevel(p.getBlockPos());
        int blocks = extConfig.pillarEscape() ? scan.buildingBlockCount() : 0;
        boolean safeCeiling = blocks >= CombatLogic.PILLAR_MIN_BLOCKS && hasSafePillarHeadroom(p, w);

        return new Sense(
                true, inLava, inFire, submerged, p.getAir(), p.getMaxAir(),
                p.isInsideWall(), blockFalling(p, w), p.getHealth(), food, hasFood,
                legacyThreat, busy, baritoneTask && baritone.pathing(),
                mc.interactionManager != null && mc.interactionManager.isBreakingBlock(),
                p.getX(), p.getY(), p.getZ(), drops,
                onFire, fallDist, p.getVelocity().y, groundDist,
                scan.hasWaterBucket(), shieldReady, shieldCooling, scan.bowReady(),
                lightLevel, extConfig.autoTorch() && scan.hasTorch(), torchSpot != null,
                blocks, safeCeiling, inWater, combatThreats
        );
    }

    private void autoEquipTick(MinecraftClient mc, ClientPlayerEntity p, ScanResult scan, List<SlotItem> mainSlots) {
        if (!extConfig.autoEquip() || !screenFree(mc, p)) return;
        if (tickCount - lastAutoEquipTick >= AUTO_EQUIP_INTERVAL_TICKS) {
            int syncId = p.playerScreenHandler.syncId;
            if (!scan.armorUpgrades().isEmpty()) {
                ArmorUpgrade up = scan.armorUpgrades().get(0);
                swapScreenSlots(mc, p, syncId, InventoryLogic.toPlayerScreenSlot(up.sourceSlot()), up.piece().screenSlot);
                lastAutoEquipTick = tickCount;
                return;
            }
            if (scan.shouldEquipShield() && scan.shieldSlot() >= 0) {
                swapScreenSlots(mc, p, syncId, InventoryLogic.toPlayerScreenSlot(scan.shieldSlot()), OFFHAND_SCREEN_SLOT);
                lastAutoEquipTick = tickCount;
                return;
            }
            if (scan.waterBucketSlot() >= InventoryLogic.HOTBAR_SLOTS && !hasInHotbar(mainSlots, "water_bucket")) {
                int dst = InventoryLogic.preferredHotbarSwapTarget(mainSlots);
                mc.interactionManager.clickSlot(syncId, scan.waterBucketSlot(), dst, SlotActionType.SWAP, p);
                lastAutoEquipTick = tickCount;
                return;
            }
            if (scan.bestWeaponSlot() >= InventoryLogic.HOTBAR_SLOTS) {
                int dst = InventoryLogic.preferredHotbarSwapTarget(mainSlots);
                mc.interactionManager.clickSlot(syncId, scan.bestWeaponSlot(), dst, SlotActionType.SWAP, p);
                lastAutoEquipTick = tickCount;
                return;
            }
        }
        if (scan.freeSlots() <= InventoryLogic.TIDY_FREE_SLOT_THRESHOLD
                && !scan.dropCandidates().isEmpty()
                && tickCount - lastTidyDropTick >= TIDY_DROP_INTERVAL_TICKS) {
            int slot = scan.dropCandidates().get(0);
            ItemStack st = p.getInventory().main.get(slot);
            if (!st.isEmpty()) {
                String id = Workbench.id(st.getItem());
                ignoredDropUntil.put(id, tickCount + 200);
                mc.interactionManager.clickSlot(p.playerScreenHandler.syncId,
                        InventoryLogic.toPlayerScreenSlot(slot), 1, SlotActionType.THROW, p);
                lastTidyDropTick = tickCount;
            }
        }
    }

    private static boolean hasInHotbar(List<SlotItem> mainSlots, String itemId) {
        for (SlotItem s : mainSlots) {
            if (s.slot() < InventoryLogic.HOTBAR_SLOTS && itemId.equals(s.id())) return true;
        }
        return false;
    }

    private boolean screenFree(MinecraftClient mc, ClientPlayerEntity p) {
        return mc.currentScreen == null
                && mc.interactionManager != null
                && p.currentScreenHandler == p.playerScreenHandler
                && workbench.state() == null
                && !p.isUsingItem()
                && p.currentScreenHandler.getCursorStack().isEmpty();
    }

    private static void swapScreenSlots(MinecraftClient mc, ClientPlayerEntity p, int syncId, int srcSlot, int dstSlot) {
        if (mc.interactionManager == null || srcSlot == dstSlot) return;
        mc.interactionManager.clickSlot(syncId, srcSlot, 0, SlotActionType.PICKUP, p);
        mc.interactionManager.clickSlot(syncId, dstSlot, 0, SlotActionType.PICKUP, p);
        if (!p.currentScreenHandler.getCursorStack().isEmpty()) {
            mc.interactionManager.clickSlot(syncId, srcSlot, 0, SlotActionType.PICKUP, p);
        }
    }

    /** A hostile that means her harm. Neutral mobs only once they attack. */
    private static boolean hostile(Entity e) {
        if (!(e instanceof Monster) || !e.isAlive()) return false;
        if (e instanceof Angerable) return e instanceof MobEntity m && m.isAttacking();
        return true;
    }

    private List<CombatLogic.Threat> collectCombatThreats(ClientPlayerEntity p, ClientWorld w) {
        Box box = p.getBoundingBox().expand(THREAT_RADIUS);
        List<CombatLogic.Threat> out = new ArrayList<>();
        for (Entity e : w.getOtherEntities(p, box, Reflexes::hostile)) {
            double d = e.distanceTo(p);
            if (d > THREAT_RADIUS || !p.canSee(e)) continue;
            boolean rangedAiming = isRangedAiming(e);
            if (d > 12.0 && !rangedAiming && brain.active() != Kind.FIGHT && brain.active() != Kind.SHIELD_BLOCK) {
                continue;
            }
            float fuse = 0f;
            boolean creeper = e instanceof CreeperEntity;
            if (creeper) {
                CreeperEntity c = (CreeperEntity) e;
                fuse = c.getClientFuseTime(0.5f);
                if (c.getFuseSpeed() > 0 || c.isIgnited()) {
                    fuse = Math.max(fuse, 0.25f);
                }
            }
            out.add(new CombatLogic.Threat(
                    entityId(e), d,
                    e.getX() - p.getX(),
                    (e.getY() + e.getHeight() * 0.5) - p.getEyeY(),
                    e.getZ() - p.getZ(),
                    creeper, fuse, rangedAiming, true
            ));
        }
        out.sort(Comparator.comparingDouble(CombatLogic.Threat::distance));
        return out;
    }

    private static boolean isRangedAiming(Entity e) {
        if (e instanceof LivingEntity le && le.isUsingItem()) {
            ItemStack active = le.getActiveItem();
            if (active.isOf(Items.BOW) || active.isOf(Items.CROSSBOW)) return true;
        }
        if (e instanceof AbstractSkeletonEntity sk && sk.isAttacking()) {
            return sk.getMainHandStack().isOf(Items.BOW);
        }
        if (e instanceof PillagerEntity pil) {
            IllagerEntity.State st = pil.getState();
            return pil.isCharging()
                    || st == IllagerEntity.State.CROSSBOW_CHARGE
                    || st == IllagerEntity.State.CROSSBOW_HOLD;
        }
        return false;
    }

    private static Entity nearestThreat(ClientPlayerEntity p, ClientWorld w) {
        Box box = p.getBoundingBox().expand(THREAT_RADIUS);
        Entity best = null;
        double bestD = Double.MAX_VALUE;
        for (Entity e : w.getOtherEntities(p, box, Reflexes::hostile)) {
            double d = e.distanceTo(p);
            if (d > THREAT_RADIUS || d >= bestD || !p.canSee(e)) continue;
            best = e;
            bestD = d;
        }
        return best;
    }

    private static Entity nearestRangedOrCreeper(ClientPlayerEntity p, ClientWorld w) {
        Box box = p.getBoundingBox().expand(CombatLogic.RANGED_SHIELD_RANGE);
        Entity best = null;
        double bestD = Double.MAX_VALUE;
        for (Entity e : w.getOtherEntities(p, box, Reflexes::hostile)) {
            double d = e.distanceTo(p);
            if (!p.canSee(e)) continue;
            boolean urgentShieldTarget = isRangedAiming(e)
                    || (e instanceof CreeperEntity c && (d <= CombatLogic.CREEPER_SHIELD_RANGE
                    || c.getFuseSpeed() > 0 || c.isIgnited() || c.getClientFuseTime(0.5f) > 0.2f));
            if (urgentShieldTarget && d < bestD) {
                best = e;
                bestD = d;
            }
        }
        return best != null ? best : nearestThreat(p, w);
    }

    private static List<BlockPos> threatPositions(ClientPlayerEntity p, ClientWorld w) {
        Box box = p.getBoundingBox().expand(THREAT_RADIUS);
        List<BlockPos> out = new ArrayList<>();
        for (Entity e : w.getOtherEntities(p, box, Reflexes::hostile)) out.add(e.getBlockPos());
        return out;
    }

    private static boolean blockFalling(ClientPlayerEntity p, ClientWorld w) {
        Box above = new Box(p.getX() - 0.9, p.getY(), p.getZ() - 0.9, p.getX() + 0.9, p.getY() + 10, p.getZ() + 0.9);
        return !w.getOtherEntities(p, above, e -> e instanceof FallingBlockEntity).isEmpty();
    }

    private static double groundDistanceBelow(ClientPlayerEntity p, ClientWorld w, double maxDist) {
        int topY = (int) Math.floor(p.getY() - 0.01);
        int bottomY = Math.max(w.getBottomY(), (int) Math.floor(p.getY() - maxDist));
        BlockPos feet = p.getBlockPos();
        for (int y = topY; y >= bottomY; y--) {
            BlockPos pos = new BlockPos(feet.getX(), y, feet.getZ());
            if (w.getFluidState(pos).isIn(FluidTags.WATER)) {
                return Double.POSITIVE_INFINITY;
            }
            BlockState st = w.getBlockState(pos);
            VoxelShape shape = st.getCollisionShape(w, pos);
            if (!shape.isEmpty()) {
                double maxY = pos.getY() + shape.getMax(Direction.Axis.Y);
                return Math.max(0.0, p.getY() - maxY);
            }
            if (!w.getFluidState(pos).isEmpty()) {
                return Math.max(0.0, p.getY() - (pos.getY() + 1.0));
            }
        }
        return Double.POSITIVE_INFINITY;
    }

    private static boolean hasSafePillarHeadroom(ClientPlayerEntity p, ClientWorld w) {
        BlockPos feet = p.getBlockPos();
        return free(w, feet.up(2)) && free(w, feet.up(3)) && free(w, feet.up(4)) && !blockFalling(p, w);
    }

    private static TorchSpot findTorchSpot(ClientPlayerEntity p, ClientWorld w) {
        BlockPos feet = p.getBlockPos();
        // Avoid spamming torches if one is already placed close by
        for (int dx = -4; dx <= 4; dx++) {
            for (int dy = -2; dy <= 2; dy++) {
                for (int dz = -4; dz <= 4; dz++) {
                    BlockState st = w.getBlockState(feet.add(dx, dy, dz));
                    if (st.isOf(Blocks.TORCH) || st.isOf(Blocks.WALL_TORCH)
                            || st.isOf(Blocks.SOUL_TORCH) || st.isOf(Blocks.SOUL_WALL_TORCH)) {
                        return null;
                    }
                }
            }
        }
        // Prefer placing on solid floor right at or beside feet
        BlockPos[] candidates = {feet, feet.north(), feet.south(), feet.east(), feet.west()};
        for (BlockPos airPos : candidates) {
            BlockState airState = w.getBlockState(airPos);
            if (!airState.isAir() || !w.getFluidState(airPos).isEmpty()) continue;
            BlockPos below = airPos.down();
            if (w.getBlockState(below).isSideSolidFullSquare(w, below, Direction.UP)) {
                Vec3d hit = Vec3d.ofCenter(below).add(0, 0.5, 0);
                return new TorchSpot(below, Direction.UP, hit);
            }
        }
        // Fallback: wall torch on adjacent horizontal solid wall
        Direction[] horiz = {Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST};
        for (BlockPos airPos : List.of(feet.up(), feet)) {
            if (!w.getBlockState(airPos).isAir() || !w.getFluidState(airPos).isEmpty()) continue;
            for (Direction dir : horiz) {
                BlockPos wall = airPos.offset(dir);
                Direction face = dir.getOpposite();
                if (w.getBlockState(wall).isSideSolidFullSquare(w, wall, face)) {
                    Vec3d hit = Vec3d.ofCenter(wall).add(face.getOffsetX() * 0.5, 0, face.getOffsetZ() * 0.5);
                    return new TorchSpot(wall, face, hit);
                }
            }
        }
        return null;
    }

    private ItemEntity nearestDrop(ClientPlayerEntity p, ClientWorld w) {
        Box box = p.getBoundingBox().expand(PICKUP_RADIUS, 2, PICKUP_RADIUS);
        ItemEntity best = null;
        double bestD = Double.MAX_VALUE;
        for (Entity e : w.getOtherEntities(p, box, e -> e instanceof ItemEntity)) {
            ItemEntity item = (ItemEntity) e;
            if (item.cannotPickup() || unreachable.contains(item.getId())) continue;
            String itemId = Workbench.id(item.getStack().getItem());
            if (tickCount < ignoredDropUntil.getOrDefault(itemId, 0L)) continue;
            double d = item.distanceTo(p);
            if (d < bestD && p.canSee(item)) {
                best = item;
                bestD = d;
            }
        }
        return best;
    }

    private static String entityId(Entity e) {
        return Ids.normalize(Registries.ENTITY_TYPE.getId(e.getType()).toString());
    }

    // ------------------------------------------------------------------ start / stop

    private void resolvePausedTaskOnEnd(ClientPlayerEntity p, BaritoneBridge baritone,
                                          Kind endedKind, Kind nextKind, boolean endedOk) {
        if (!pausedTask) return;
        if (nextKind != null) {
            if (ReflexBrain.isRecoverable(nextKind)) {
                // Escalated to another recoverable reflex: keep Baritone suspended.
                if (tasks != null) tasks.pauseForReflex(nextKind.id());
                return;
            }
            pausedTask = false;
            if (baritone != null) baritone.clearSuspended();
            if (tasks != null) tasks.abortPaused("escalated to " + nextKind.id());
            return;
        }
        pausedTask = false;
        if (!ReflexBrain.isRecoverable(endedKind, endedOk) || p == null || baritone == null) {
            if (baritone != null) baritone.clearSuspended();
            if (tasks != null) tasks.abortPaused("reflex " + endedKind.id() + " did not recover");
            return;
        }
        long maxPauseMs = Math.max(1, extConfig.pausedResumeMaxSecs()) * 1000L;
        boolean replayed = baritone.replaySuspended(p.getX(), p.getY(), p.getZ(),
                System.currentTimeMillis(), extConfig.pausedMaxDrift(), maxPauseMs);
        if (replayed) {
            if (tasks != null) tasks.resumeFromReflex();
        } else if (tasks != null) {
            tasks.abortPaused("could not resume after " + endedKind.id());
        }
    }

    private void start(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w, Kind k, Sense s,
                       BaritoneBridge baritone, List<SlotItem> mainSlots, ScanResult scan, TorchSpot torchSpot) {
        ticks = 0;
        spot = null;
        target = null;
        drop = null;
        eating = null;
        waterPlacedAt = null;
        mlgWaterPlaced = false;
        mlgLandTicks = 0;
        extinguishPlaced = false;
        pendingTorchSpot = torchSpot;
        bowCooldownTicks = 0;
        critWaitTicks = 0;
        startPos = p.getPos();

        boolean stops = k.urgent || k == Kind.UNSTUCK || (k == Kind.EAT && s.busy());
        boolean baritoneTaskBusy = baritone != null && baritone.state().busy() && !baritone.reflexDriving();
        boolean workbenchBusy = workbench.state() != null;
        boolean holdingAction = actions.holding();

        if (!pausedTask) {
            interrupted = stops ? currentTask(baritone) : null;
        }
        if (k == Kind.FIGHT || k == Kind.FLEE || k == Kind.SHIELD_BLOCK || k == Kind.RETREAT_PILLAR) {
            target = k == Kind.SHIELD_BLOCK ? nearestRangedOrCreeper(p, w) : nearestThreat(p, w);
        }

        boolean recoverableEvent;
        boolean needHardInterrupt = false;
        if (stops && pausedTask && ReflexBrain.isRecoverable(k)) {
            recoverableEvent = true;
            actions.releaseAll();
        } else if (stops && ReflexBrain.isRecoverable(k) && baritoneTaskBusy && !workbenchBusy && !holdingAction
                && baritone.pauseForReflex(p.getX(), p.getY(), p.getZ(), System.currentTimeMillis())) {
            pausedTask = true;
            recoverableEvent = true;
            if (tasks != null) tasks.pauseForReflex(k.id());
            actions.releaseAll();
        } else {
            recoverableEvent = !stops && ReflexBrain.isRecoverable(k);
            needHardInterrupt = stops;
        }

        int foodSlot = k == Kind.EAT && scan != null ? scan.bestFoodSlot(p.getHungerManager().getFoodLevel() <= 4) : -1;
        JsonObject d = new JsonObject();
        d.addProperty("kind", k.id());
        d.addProperty("recoverable", recoverableEvent);
        d.addProperty("paused_task", pausedTask);
        d.addProperty("interrupted", interrupted);
        d.addProperty("health", Math.round(p.getHealth() * 10f) / 10.0);
        if (target != null) d.addProperty("target", entityId(target));
        if (foodSlot >= 0) d.addProperty("food", Workbench.id(p.getInventory().main.get(foodSlot).getItem()));
        events.emit("reflex", d);
        if (needHardInterrupt) interrupt(mc, baritone);

        switch (k) {
            case EXTINGUISH, MLG_WATER -> {
                if (scan == null || scan.waterBucketSlot() < 0) {
                    brain.finish(false);
                } else {
                    holdWithRestore(mc, p, scan.waterBucketSlot(), mainSlots);
                }
            }
            case SHIELD_BLOCK -> {
                if (!p.getOffHandStack().isOf(Items.SHIELD)
                        && !p.getOffHandStack().isOf(Items.TOTEM_OF_UNDYING)
                        && scan != null && scan.shieldSlot() >= 0 && screenFree(mc, p)) {
                    swapScreenSlots(mc, p, p.playerScreenHandler.syncId,
                            InventoryLogic.toPlayerScreenSlot(scan.shieldSlot()), OFFHAND_SCREEN_SLOT);
                }
            }
            case RETREAT_PILLAR -> {
                if (scan == null || scan.buildingBlockSlot() < 0) {
                    brain.finish(false);
                } else {
                    pillarStartY = p.getY();
                    pillarTargetY = Math.floor(pillarStartY) + 3.0;
                    lastPillarPlaceTick = -10;
                    holdWithRestore(mc, p, scan.buildingBlockSlot(), mainSlots);
                }
            }
            case FIGHT -> {
                if (scan != null && scan.bestWeaponSlot() >= 0) {
                    hold(mc, p, scan.bestWeaponSlot(), mainSlots);
                }
            }
            case EAT -> {
                if (foodSlot < 0) {
                    brain.finish(false);
                } else {
                    eating = p.getInventory().main.get(foodSlot).getItem();
                    foodBefore = p.getHungerManager().getFoodLevel();
                    countBefore = p.getInventory().count(eating);
                    holdWithRestore(mc, p, foodSlot, mainSlots);
                }
            }
            case AUTO_TORCH -> {
                if (scan == null || scan.torchSlot() < 0 || pendingTorchSpot == null) {
                    brain.finish(false);
                } else {
                    holdWithRestore(mc, p, scan.torchSlot(), mainSlots);
                }
            }
            case UNSTUCK -> unstuckAttempts++;
            default -> {
            }
        }
    }

    /** What she is doing that a reflex would stop: a craft / smelt job, a Baritone process, a held key. */
    private String currentTask(BaritoneBridge baritone) {
        if (workbench.state() != null) return workbench.state().kind();
        if (baritone != null && baritone.state().busy() && !baritone.reflexDriving()) return baritone.state().process();
        return actions.holding() ? "hold" : null;
    }

    /** Stops her task: Baritone (reported as interrupted by a reflex), a craft / smelt job, held keys. */
    private void interrupt(MinecraftClient mc, BaritoneBridge baritone) {
        if (workbench.state() != null) workbench.cancel(mc);
        if (baritone != null && baritone.state().busy() && !baritone.reflexDriving()) baritone.interrupt();
        actions.releaseAll();
    }

    private void stop(MinecraftClient mc, Kind k, BaritoneBridge baritone) {
        release();
        ClientPlayerEntity p = mc.player;
        switch (k) {
            case FLEE, PICKUP -> {
                if (baritone != null) baritone.reflexCancel();
            }
            case SUFFOCATION -> {
                if (mc.interactionManager != null) mc.interactionManager.cancelBlockBreaking();
            }
            case SHIELD_BLOCK, FIGHT -> {
                if (p != null && mc.interactionManager != null && p.isUsingItem()) {
                    mc.interactionManager.stopUsingItem(p);
                }
            }
            case EAT, EXTINGUISH, MLG_WATER, RETREAT_PILLAR, AUTO_TORCH -> {
                if (p != null && mc.interactionManager != null && p.isUsingItem()) {
                    mc.interactionManager.stopUsingItem(p);
                }
                restoreHeldSlot(mc, p);
            }
            default -> {
            }
        }
        if (k != Kind.UNSTUCK) unstuckAttempts = 0;
        if (k == Kind.PICKUP) unreachable.clear();
    }

    /** {@code yielded}: it gave way to a request (not a failure). */
    private void ended(Kind k, boolean ok, boolean yielded) {
        JsonObject d = new JsonObject();
        d.addProperty("kind", k.id());
        d.addProperty("ok", ok);
        d.addProperty("recoverable", ReflexBrain.isRecoverable(k, ok));
        if (yielded) d.addProperty("yielded", true);
        d.addProperty("interrupted", interrupted);
        d.addProperty("secs", Math.round(ticks / 2.0) / 10.0);
        events.emit("reflex_end", d);
        if (!pausedTask) interrupted = null;
    }

    // ------------------------------------------------------------------ doing

    private void run(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w, Kind k,
                     BaritoneBridge baritone, List<SlotItem> mainSlots, ScanResult scan) {
        if (p == null || w == null) return;
        switch (k) {
            case EXTINGUISH -> extinguish(mc, p, w, scan, mainSlots);
            case MLG_WATER -> mlgWater(mc, p, w, scan, mainSlots);
            case LAVA -> {
                if (spot == null || ticks % 20 == 0) spot = safeSpot(p, w, 5, 0, null);
                moveToward(mc, p, spot, true);
            }
            case FALLING_BLOCK -> {
                if (spot == null) {
                    BlockPos column = p.getBlockPos();
                    spot = safeSpot(p, w, 2, 1, pos -> pos.getX() != column.getX() || pos.getZ() != column.getZ());
                }
                moveToward(mc, p, spot, false);
            }
            case SUFFOCATION -> {
                BlockPos head = BlockPos.ofFloored(p.getEyePos());
                BlockPos at = w.getBlockState(head).getCollisionShape(w, head).isEmpty() ? p.getBlockPos() : head;
                if (mc.interactionManager != null) mc.interactionManager.updateBlockBreakingProgress(at, Direction.UP);
                p.swingHand(Hand.MAIN_HAND);
            }
            case DROWNING -> press(mc.options.jumpKey);
            case RETREAT_PILLAR -> pillarRetreat(mc, p, w, scan, mainSlots);
            case SHIELD_BLOCK -> shieldBlock(mc, p, w);
            case FLEE -> {
                if (baritone != null) {
                    if (ticks % 40 == 1) {
                        List<BlockPos> from = threatPositions(p, w);
                        if (!from.isEmpty()) baritone.reflexRunAway(16, from);
                    }
                } else if (target != null) {
                    Vec3d away = p.getPos().multiply(2).subtract(target.getPos());
                    moveToward(mc, p, away, true);
                }
            }
            case FIGHT -> fight(mc, p, w, scan, mainSlots);
            case EAT -> eat(mc, p);
            case AUTO_TORCH -> autoTorch(mc, p);
            case UNSTUCK -> {
                if (spot == null) spot = safeSpot(p, w, 3, 2 + unstuckAttempts % 2, null);
                moveToward(mc, p, spot, true);
                if (ticks >= 20) brain.finish(p.getPos().distanceTo(startPos) > 1.0);
            }
            case PICKUP -> pickup(mc, p, w, baritone);
        }
    }

    private void extinguish(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w,
                            ScanResult scan, List<SlotItem> mainSlots) {
        if (mc.interactionManager == null) {
            brain.finish(false);
            return;
        }
        if (!extinguishPlaced) {
            p.setPitch(89f);
            if (p.getMainHandStack().isOf(Items.WATER_BUCKET)) {
                mc.interactionManager.interactItem(p, Hand.MAIN_HAND);
                extinguishPlaced = true;
                waterPlacedAt = p.getBlockPos();
            } else if (scan != null && scan.waterBucketSlot() >= 0) {
                hold(mc, p, scan.waterBucketSlot(), mainSlots);
            } else {
                brain.finish(false);
            }
            return;
        }
        if (!p.isOnFire() || ticks >= 8) {
            scoopWater(mc, p, w, scan, mainSlots);
            brain.finish(!p.isOnFire());
        }
    }

    private void mlgWater(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w,
                          ScanResult scan, List<SlotItem> mainSlots) {
        if (mc.interactionManager == null) {
            brain.finish(false);
            return;
        }
        if (!mlgWaterPlaced) {
            if (!p.getMainHandStack().isOf(Items.WATER_BUCKET) && scan != null && scan.waterBucketSlot() >= 0) {
                hold(mc, p, scan.waterBucketSlot(), mainSlots);
            }
            p.setPitch(89f);
            double dist = groundDistanceBelow(p, w, 8.0);
            if (dist <= 3.6 && p.getMainHandStack().isOf(Items.WATER_BUCKET)) {
                mc.interactionManager.interactItem(p, Hand.MAIN_HAND);
                mlgWaterPlaced = true;
                waterPlacedAt = p.getBlockPos();
                mlgLandTicks = 0;
            } else if (p.isOnGround()) {
                brain.finish(true);
            }
            return;
        }
        if (p.isOnGround() || p.isTouchingWater()) {
            mlgLandTicks++;
        }
        if (mlgLandTicks >= 3) {
            scoopWater(mc, p, w, scan, mainSlots);
            brain.finish(true);
        }
    }

    private void scoopWater(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w,
                            ScanResult scan, List<SlotItem> mainSlots) {
        if (mc.interactionManager == null) return;
        int emptySlot = scan != null ? scan.emptyBucketSlot() : -1;
        if (!p.getMainHandStack().isOf(Items.BUCKET) && emptySlot >= 0) {
            hold(mc, p, emptySlot, mainSlots);
        }
        if (!p.getMainHandStack().isOf(Items.BUCKET)) return;
        if (waterPlacedAt != null && w.getFluidState(waterPlacedAt).isIn(FluidTags.WATER)) {
            faceInstant(p, Vec3d.ofCenter(waterPlacedAt));
        } else {
            p.setPitch(89f);
        }
        mc.interactionManager.interactItem(p, Hand.MAIN_HAND);
    }

    private void shieldBlock(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w) {
        Entity threat = nearestRangedOrCreeper(p, w);
        if (threat != null) {
            target = threat;
            face(p, threat.getPos().add(0, threat.getHeight() * 0.65, 0));
            if (threat instanceof CreeperEntity && threat.distanceTo(p) <= 4.5) {
                press(mc.options.backKey);
            } else {
                releaseKey(mc.options.backKey);
            }
        }
        if (p.getOffHandStack().isOf(Items.SHIELD) || p.getMainHandStack().isOf(Items.SHIELD)) {
            press(mc.options.useKey);
            if (!p.isUsingItem() && mc.interactionManager != null) {
                Hand hand = p.getOffHandStack().isOf(Items.SHIELD) ? Hand.OFF_HAND : Hand.MAIN_HAND;
                mc.interactionManager.interactItem(p, hand);
            }
        } else {
            brain.finish(false);
        }
    }

    private void pillarRetreat(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w,
                               ScanResult scan, List<SlotItem> mainSlots) {
        if (mc.interactionManager == null) {
            brain.finish(false);
            return;
        }
        if (p.isOnGround() && p.getY() >= pillarTargetY - 0.1) {
            brain.finish(true);
            return;
        }
        if (scan != null && !InventoryLogic.isPillarBlock(Workbench.id(p.getMainHandStack().getItem()))) {
            if (scan.buildingBlockSlot() < 0) {
                brain.finish(p.getY() >= pillarStartY + 1.5);
                return;
            }
            hold(mc, p, scan.buildingBlockSlot(), mainSlots);
        }
        p.setPitch(89f);
        releaseKey(mc.options.forwardKey);
        releaseKey(mc.options.backKey);
        releaseKey(mc.options.leftKey);
        releaseKey(mc.options.rightKey);
        press(mc.options.jumpKey);

        BlockPos belowFeet = BlockPos.ofFloored(p.getX(), Math.floor(p.getY()) - 1, p.getZ());
        if (p.getY() >= belowFeet.getY() + 1.0 && ticks - lastPillarPlaceTick >= 2) {
            if (w.getBlockState(belowFeet).isReplaceable()) {
                BlockPos base = belowFeet.down();
                if (!w.getBlockState(base).getCollisionShape(w, base).isEmpty()) {
                    Vec3d hit = Vec3d.ofCenter(base).add(0, 0.5, 0);
                    mc.interactionManager.interactBlock(p, Hand.MAIN_HAND,
                            new BlockHitResult(hit, Direction.UP, base, false));
                    p.swingHand(Hand.MAIN_HAND);
                    lastPillarPlaceTick = ticks;
                }
            }
        }
    }

    private void autoTorch(MinecraftClient mc, ClientPlayerEntity p) {
        if (mc.interactionManager == null || pendingTorchSpot == null) {
            brain.finish(false);
            return;
        }
        faceInstant(p, pendingTorchSpot.hitPos());
        boolean placed = mc.interactionManager.interactBlock(p, Hand.MAIN_HAND,
                new BlockHitResult(pendingTorchSpot.hitPos(), pendingTorchSpot.face(),
                        pendingTorchSpot.attachPos(), false)).isAccepted();
        if (placed) p.swingHand(Hand.MAIN_HAND);
        brain.finish(placed);
    }

    private void fight(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w,
                       ScanResult scan, List<SlotItem> mainSlots) {
        List<CombatLogic.Threat> threats = collectCombatThreats(p, w);
        if (threats.isEmpty()) {
            release();
            return;
        }
        CombatLogic.State cs = new CombatLogic.State(
                p.getHealth(),
                brain.config().fleeHealth(),
                p.getAttackCooldownProgress(0.5f),
                p.isOnGround(),
                p.isTouchingWater(),
                extConfig.shieldBlock() && (p.getOffHandStack().isOf(Items.SHIELD) || (scan != null && scan.shieldSlot() >= 0)),
                p.getItemCooldownManager().isCoolingDown(Items.SHIELD),
                scan != null && scan.bowReady(),
                scan != null ? scan.buildingBlockCount() : 0,
                hasSafePillarHeadroom(p, w),
                brain.config().fight(),
                extConfig.shieldBlock(),
                extConfig.pillarEscape(),
                ticks,
                threats
        );
        CombatLogic.Decision dec = CombatLogic.decide(cs);
        if (dec.mode() == CombatLogic.Mode.NONE) {
            release();
            return;
        }

        if (dec.mode() == CombatLogic.Mode.BOW_SHOT) {
            runBowCombat(mc, p, w, scan, mainSlots, dec);
            return;
        }

        // Switching back to melee: cancel bow draw if active
        if (p.isUsingItem() && p.getActiveItem().isOf(Items.BOW)) {
            releaseKey(mc.options.useKey);
            if (mc.interactionManager != null) mc.interactionManager.stopUsingItem(p);
        }
        if (scan != null && scan.bestWeaponSlot() >= 0
                && p.getInventory().selectedSlot != scan.bestWeaponSlot()) {
            hold(mc, p, scan.bestWeaponSlot(), mainSlots);
        }

        Entity meleeTarget = findLiveEntity(p, w, dec.target());
        if (meleeTarget == null) meleeTarget = nearestThreat(p, w);
        if (meleeTarget == null) {
            release();
            return;
        }
        target = meleeTarget;

        Vec3d aim = meleeTarget.getPos().add(0, meleeTarget.getHeight() * 0.6, 0);
        face(p, aim);
        double d = meleeTarget.distanceTo(p);

        if (d > REACH - 0.3) press(mc.options.forwardKey);
        else releaseKey(mc.options.forwardKey);
        if (d > REACH + 0.8) press(mc.options.sprintKey);
        else releaseKey(mc.options.sprintKey);

        applyStrafe(mc, dec.strafe(), dec.strafeSign());

        float cooldown = p.getAttackCooldownProgress(0.5f);
        if (dec.jumpCrit() && p.isOnGround() && !p.isTouchingWater()) {
            press(mc.options.jumpKey);
            critWaitTicks = 8;
        } else {
            releaseKey(mc.options.jumpKey);
            if (critWaitTicks > 0) critWaitTicks--;
        }

        boolean fallingCritWindow = !p.isOnGround() && p.getVelocity().y < -0.05;
        boolean readyToStrike = d <= REACH && cooldown >= CombatLogic.CRIT_COOLDOWN_THRESHOLD
                && p.canSee(meleeTarget) && mc.interactionManager != null
                && (fallingCritWindow || p.isTouchingWater() || critWaitTicks == 0);
        if (readyToStrike) {
            mc.interactionManager.attackEntity(p, meleeTarget);
            p.swingHand(Hand.MAIN_HAND);
            critWaitTicks = 0;
        }
    }

    private void runBowCombat(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w,
                              ScanResult scan, List<SlotItem> mainSlots, CombatLogic.Decision dec) {
        releaseKey(mc.options.forwardKey);
        releaseKey(mc.options.sprintKey);
        releaseKey(mc.options.jumpKey);
        applyStrafe(mc, dec.strafe(), dec.strafeSign());

        Entity bowTarget = findLiveEntity(p, w, dec.target());
        if (bowTarget == null) {
            release();
            return;
        }
        target = bowTarget;

        Hand bowHand = scan != null && scan.bowInOffhand() ? Hand.OFF_HAND : Hand.MAIN_HAND;
        if (bowHand == Hand.MAIN_HAND && scan != null && scan.bowSlot() >= 0
                && !p.getMainHandStack().isOf(Items.BOW)) {
            hold(mc, p, scan.bowSlot(), mainSlots);
        }

        Vec3d eye = p.getEyePos();
        Vec3d center = bowTarget.getPos().add(0, bowTarget.getHeight() * 0.55, 0);
        Vec3d vel = bowTarget.getVelocity();
        LookMath.Rotation aimRot = LookMath.ballisticAimWithLead(
                center.x - eye.x, center.y - eye.y, center.z - eye.z,
                vel.x, vel.y, vel.z,
                ARROW_SPEED, ARROW_GRAVITY);
        p.setYaw(LookMath.approachAngle(p.getYaw(), aimRot.yaw(), TURN_DEG_PER_TICK));
        p.setPitch(LookMath.clampPitch(LookMath.approachAngle(p.getPitch(), aimRot.pitch(), TURN_DEG_PER_TICK)));

        if (bowCooldownTicks > 0) {
            bowCooldownTicks--;
            releaseKey(mc.options.useKey);
            return;
        }

        if (!p.isUsingItem() && mc.interactionManager != null) {
            mc.interactionManager.interactItem(p, bowHand);
        }
        press(mc.options.useKey);
        if (p.isUsingItem() && p.getActiveItem().isOf(Items.BOW)) {
            int charge = p.getItemUseTime();
            boolean aimed = Math.abs(LookMath.angleDiff(p.getYaw(), aimRot.yaw())) < 10f
                    && Math.abs(p.getPitch() - aimRot.pitch()) < 10f;
            if (charge >= BOW_FULL_CHARGE_TICKS && (aimed || charge >= BOW_FULL_CHARGE_TICKS + 10)
                    && p.canSee(bowTarget) && mc.interactionManager != null) {
                releaseKey(mc.options.useKey);
                mc.interactionManager.stopUsingItem(p);
                bowCooldownTicks = 4;
            }
        }
    }

    private void applyStrafe(MinecraftClient mc, boolean strafe, int sign) {
        if (!strafe || sign == 0) {
            releaseKey(mc.options.leftKey);
            releaseKey(mc.options.rightKey);
            return;
        }
        if (sign > 0) {
            press(mc.options.rightKey);
            releaseKey(mc.options.leftKey);
        } else {
            press(mc.options.leftKey);
            releaseKey(mc.options.rightKey);
        }
    }

    private static Entity findLiveEntity(ClientPlayerEntity p, ClientWorld w, CombatLogic.Threat t) {
        if (t == null) return null;
        Box box = p.getBoundingBox().expand(CombatLogic.RANGED_SHIELD_RANGE);
        Entity best = null;
        double bestDiff = Double.MAX_VALUE;
        for (Entity e : w.getOtherEntities(p, box, Reflexes::hostile)) {
            if (!p.canSee(e) || !t.type().equals(entityId(e))) continue;
            double diff = Math.abs(e.distanceTo(p) - t.distance());
            if (diff < bestDiff && diff <= 2.5) {
                best = e;
                bestDiff = diff;
            }
        }
        return best;
    }

    private void eat(MinecraftClient mc, ClientPlayerEntity p) {
        if (eating == null || mc.interactionManager == null) {
            brain.finish(false);
            return;
        }
        if (ticks == 1) {
            if (!p.getMainHandStack().isOf(eating) || !mc.interactionManager.interactItem(p, Hand.MAIN_HAND).isAccepted()) {
                brain.finish(false);
                return;
            }
        }
        press(mc.options.useKey);
        boolean ate = p.getHungerManager().getFoodLevel() > foodBefore || p.getInventory().count(eating) < countBefore;
        if (ticks > 5 && !p.isUsingItem()) brain.finish(ate);
        else if (ticks > 60) brain.finish(ate);
    }

    private void pickup(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w, BaritoneBridge baritone) {
        if (drop == null || !drop.isAlive()) {
            drop = nearestDrop(p, w);
            dropTicks = 0;
            if (drop == null) {
                brain.finish(true);
                return;
            }
            if (baritone != null) baritone.reflexGoTo(drop.getBlockPos());
        }
        if (++dropTicks > 100) {
            unreachable.add(drop.getId());
            drop = null;
            if (baritone != null) baritone.reflexCancel();
            return;
        }
        if (baritone == null) moveToward(mc, p, drop.getPos(), false);
    }

    // ------------------------------------------------------------------ body

    private void holdWithRestore(MinecraftClient mc, ClientPlayerEntity p, int slot, List<SlotItem> mainSlots) {
        restoreSlot = p.getInventory().selectedSlot;
        swappedFrom = hold(mc, p, slot, mainSlots);
    }

    private void restoreHeldSlot(MinecraftClient mc, ClientPlayerEntity p) {
        if (p != null && mc.interactionManager != null && swappedFrom >= 0) {
            mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, swappedFrom,
                    p.getInventory().selectedSlot, SlotActionType.SWAP, p);
        }
        if (p != null && restoreSlot >= 0) p.getInventory().selectedSlot = restoreSlot;
        restoreSlot = -1;
        swappedFrom = -1;
    }

    /**
     * Puts {@code slot} of the main inventory in her hand. From storage ({@code 9..35}) it is
     * swapped into an empty or non-essential hotbar slot; returns the storage slot (-1 when in hotbar).
     */
    private static int hold(MinecraftClient mc, ClientPlayerEntity p, int slot, List<SlotItem> mainSlots) {
        PlayerInventory inv = p.getInventory();
        if (slot < 0) return -1;
        if (slot < InventoryLogic.HOTBAR_SLOTS) {
            inv.selectedSlot = slot;
            return -1;
        }
        if (mc.interactionManager == null) return -1;
        int hotbar = mainSlots != null ? InventoryLogic.preferredHotbarSwapTarget(mainSlots) : 8;
        mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, slot, hotbar, SlotActionType.SWAP, p);
        inv.selectedSlot = hotbar;
        return slot;
    }

    private void face(ClientPlayerEntity p, Vec3d at) {
        Vec3d eye = p.getEyePos();
        LookMath.Rotation r = LookMath.toward(at.x - eye.x, at.y - eye.y, at.z - eye.z);
        p.setYaw(LookMath.approachAngle(p.getYaw(), r.yaw(), TURN_DEG_PER_TICK));
        p.setPitch(LookMath.clampPitch(LookMath.approachAngle(p.getPitch(), r.pitch(), TURN_DEG_PER_TICK)));
    }

    private static void faceInstant(ClientPlayerEntity p, Vec3d at) {
        Vec3d eye = p.getEyePos();
        LookMath.Rotation r = LookMath.toward(at.x - eye.x, at.y - eye.y, at.z - eye.z);
        p.setYaw(r.yaw());
        p.setPitch(r.pitch());
    }

    /** Walks (sprints) toward {@code to}, jumping when something is in the way or {@code jump}. */
    private void moveToward(MinecraftClient mc, ClientPlayerEntity p, Vec3d to, boolean jump) {
        if (to == null) {
            press(mc.options.forwardKey);
            if (jump) press(mc.options.jumpKey);
            return;
        }
        Vec3d eye = p.getEyePos();
        LookMath.Rotation r = LookMath.toward(to.x - eye.x, 0, to.z - eye.z);
        p.setYaw(LookMath.approachAngle(p.getYaw(), r.yaw(), TURN_DEG_PER_TICK));
        double dx = to.x - p.getX(), dz = to.z - p.getZ();
        if (dx * dx + dz * dz < 0.09) {
            release();
            return;
        }
        press(mc.options.forwardKey);
        press(mc.options.sprintKey);
        if (jump || p.horizontalCollision || to.y > p.getY() + 0.5) press(mc.options.jumpKey);
        else releaseKey(mc.options.jumpKey);
    }

    private static Vec3d safeSpot(ClientPlayerEntity p, ClientWorld w, int radius, int minDistance,
                                  java.util.function.Predicate<BlockPos> extra) {
        BlockPos feet = p.getBlockPos();
        List<BlockPos> found = new ArrayList<>();
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) < minDistance) continue;
                for (int dy = -1; dy <= 2; dy++) {
                    BlockPos pos = feet.add(dx, dy, dz);
                    if (standable(w, pos) && (extra == null || extra.test(pos))) found.add(pos);
                }
            }
        }
        return found.stream()
                .min(Comparator.comparingDouble(pos -> pos.getSquaredDistance(p.getPos())))
                .map(pos -> new Vec3d(pos.getX() + 0.5, pos.getY(), pos.getZ() + 0.5))
                .orElse(null);
    }

    private static boolean standable(ClientWorld w, BlockPos pos) {
        BlockPos below = pos.down();
        BlockState under = w.getBlockState(below);
        if (!under.isSideSolidFullSquare(w, below, Direction.UP) || under.isOf(Blocks.MAGMA_BLOCK)) return false;
        return free(w, pos) && free(w, pos.up());
    }

    private static boolean free(ClientWorld w, BlockPos pos) {
        BlockState st = w.getBlockState(pos);
        return st.getCollisionShape(w, pos).isEmpty() && !st.isIn(BlockTags.FIRE)
                && !w.getFluidState(pos).isIn(FluidTags.LAVA);
    }

    private void press(KeyBinding key) {
        key.setPressed(true);
        pressed.add(key);
    }

    private void releaseKey(KeyBinding key) {
        if (pressed.remove(key)) key.setPressed(false);
    }

    private void release() {
        for (KeyBinding k : pressed) k.setPressed(false);
        pressed.clear();
    }
}
