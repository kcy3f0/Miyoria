package dev.miyoria.bridge.game;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.miyoria.bridge.config.BridgeConfig;
import dev.miyoria.bridge.mine.BranchMinerLogic;
import dev.miyoria.bridge.mine.BranchMinerLogic.BlockProbe;
import dev.miyoria.bridge.mine.BranchMinerLogic.CellKind;
import dev.miyoria.bridge.mine.BranchMinerLogic.Dir;
import dev.miyoria.bridge.mine.BranchMinerLogic.Params;
import dev.miyoria.bridge.mine.BranchMinerLogic.Phase;
import dev.miyoria.bridge.mine.BranchMinerLogic.Pos;
import dev.miyoria.bridge.mine.BranchMinerLogic.StepPlan;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.util.Ids;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.block.TorchBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Items;
import net.minecraft.item.PickaxeItem;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Tick-by-tick client driver for legitimate branch mining ({@link BranchMinerLogic}).
 * Never inspects unexposed ores through solid walls. Client thread only.
 */
final class BranchMiner implements WorldWorkers.Worker {

    private static final Set<String> DEFAULT_ORES = Set.of(
            "diamond_ore", "deepslate_diamond_ore",
            "iron_ore", "deepslate_iron_ore",
            "gold_ore", "deepslate_gold_ore",
            "emerald_ore", "deepslate_emerald_ore",
            "lapis_ore", "deepslate_lapis_ore",
            "redstone_ore", "deepslate_redstone_ore",
            "copper_ore", "deepslate_copper_ore",
            "coal_ore", "deepslate_coal_ore",
            "ancient_debris");

    private static final int PROGRESS_STEP_INTERVAL = 8;
    private static final int WALK_TIMEOUT_TICKS = 70;
    private static final int BREAK_TIMEOUT_TICKS = 240;

    private final GameActions actions;
    private final EventSink events;
    private final String taskId;
    private final BranchMinerLogic logic;

    private BlockPos activeBreakPos;
    private CellKind activeBreakKind;
    private boolean breakStarted;
    private int breakTicks;
    private boolean activeBreakIsOre;

    private Pos walkingTarget;
    private int walkTicks;
    private int fallWaitTicks;
    private int pickupWaitTicks;
    private int oresMined;
    private int lastProgressStep = -1;
    private Phase lastProgressPhase;
    private boolean terminated;
    private final Deque<Pos> pendingOres = new ArrayDeque<>();
    private final Set<Pos> skippedOres = new HashSet<>();

    private BranchMiner(
            GameActions actions,
            EventSink events,
            String taskId,
            BranchMinerLogic logic) {
        this.actions = actions;
        this.events = events;
        this.taskId = taskId;
        this.logic = logic;
        this.lastProgressPhase = logic.phase();
    }

    static BranchMiner create(
            MinecraftClient mc,
            GameActions actions,
            BridgeConfig cfg,
            EventSink events,
            String taskId,
            Request req,
            JsonObject ack) throws ProtocolException {
        ClientPlayerEntity p = mc.player;
        if (!hasPickaxe(p.getInventory())) {
            throw new ProtocolException(Protocol.E_MISSING_ITEMS, "missing a pickaxe for branch mining");
        }

        int targetY = req.optInt("target_y", -58);
        int maxSteps = req.optInt("max_steps", 64);
        int branchLen = req.optInt("branch_length", 12);
        int branchSpacing = req.optInt("branch_spacing", 3);
        int torchInterval = req.optInt("torch_interval", 8);
        Set<String> ores = parseOres(req);
        Params params = new Params(targetY, maxSteps, branchLen, branchSpacing, torchInterval, cfg.autoTorchMaxLight, ores);

        Pos start = new Pos(p.getBlockX(), p.getBlockY(), p.getBlockZ());
        Dir dir = Dir.fromYaw(p.getYaw());
        BranchMinerLogic logic = new BranchMinerLogic(start, dir, params);

        ack.addProperty("started", true);
        ack.addProperty("target_y", params.targetY());
        ack.addProperty("max_steps", params.maxSteps());
        ack.addProperty("phase", logic.phase().name().toLowerCase());
        ack.addProperty("direction", dir.name().toLowerCase());
        return new BranchMiner(actions, events, taskId, logic);
    }

    private static Set<String> parseOres(Request req) throws ProtocolException {
        if (!req.has("ores")) return DEFAULT_ORES;
        if (!req.body().get("ores").isJsonArray()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "'ores' must be an array of block ids");
        }
        Set<String> out = new HashSet<>();
        for (JsonElement el : req.body().getAsJsonArray("ores")) {
            if (el.isJsonPrimitive()) {
                String id = Ids.normalize(el.getAsString());
                if (!id.isEmpty()) out.add(id);
            }
        }
        return out.isEmpty() ? DEFAULT_ORES : out;
    }

    private static boolean hasPickaxe(PlayerInventory inv) {
        for (int i = 0; i < inv.main.size(); i++) {
            if (inv.main.get(i).getItem() instanceof PickaxeItem) return true;
        }
        return false;
    }

    @Override
    public String kind() {
        return Protocol.T_MINE_BRANCH;
    }

    @Override
    public String detail() {
        return logic.phase().name().toLowerCase() + " y=" + logic.foot().y() + " step=" + logic.stepsTaken();
    }

    @Override
    public void suspend(MinecraftClient mc) {
        resetTransientBreak();
        walkingTarget = null;
        walkTicks = 0;
    }

    @Override
    public void cancel(MinecraftClient mc, String reason, boolean cancelled) {
        resetTransientBreak();
        emitTerminal("branch_failed", reason, cancelled);
    }

    @Override
    public boolean tick(MinecraftClient mc) {
        ClientPlayerEntity p = mc.player;
        ClientWorld w = mc.world;
        BlockProbe probe = new WorldProbe(w);

        if (pickupWaitTicks > 0) {
            pickupWaitTicks--;
            return true;
        }
        if (fallWaitTicks > 0) {
            fallWaitTicks--;
            return true;
        }

        if (activeBreakPos != null) {
            tickBreaking(mc, p, w, probe);
            return !finishCheck(p);
        }

        if (!pendingOres.isEmpty()) {
            if (startNextOre(mc, p, w, probe)) return !terminated;
        }

        if (walkingTarget != null) {
            tickWalking(mc, p, w, probe);
            return !finishCheck(p);
        }

        if (logic.finished()) {
            return !finishCheck(p);
        }

        StepPlan plan = logic.planNextStep(probe);
        if (plan.blocked()) {
            logic.handleHazard(probe, plan.hazard());
            emitProgressIfNeeded(p, false);
            return !finishCheck(p);
        }

        if (!plan.blocksToBreak().isEmpty()) {
            Pos next = plan.blocksToBreak().get(0);
            BlockPos bPos = new BlockPos(next.x(), next.y(), next.z());
            if (!p.canInteractWithBlockAt(bPos, 0)) {
                actions.steerToward(mc, p, Vec3d.ofCenter(bPos), false);
                return true;
            }
            actions.releaseMovement(mc);
            activeBreakPos = bPos;
            activeBreakKind = probe.cell(next.x(), next.y(), next.z());
            activeBreakIsOre = false;
            breakStarted = false;
            breakTicks = 0;
            return true;
        }

        String floorHazard = logic.checkStepFloorHazard(probe, plan.nextFoot());
        if (floorHazard != null) {
            logic.handleHazard(probe, floorHazard);
            emitProgressIfNeeded(p, false);
            return !finishCheck(p);
        }

        walkingTarget = plan.nextFoot();
        walkTicks = 0;
        return true;
    }

    private void tickBreaking(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w, BlockProbe probe) {
        BlockState st = w.getBlockState(activeBreakPos);
        if (st.isAir() || (st.getCollisionShape(w, activeBreakPos).isEmpty() && st.getFluidState().isEmpty())) {
            finishCurrentBreak(w, probe, true);
            return;
        }
        Pos bp = new Pos(activeBreakPos.getX(), activeBreakPos.getY(), activeBreakPos.getZ());
        if (!BranchMinerLogic.isSafeToBreak(probe, bp)) {
            actions.stopBreaking(mc);
            if (activeBreakIsOre) {
                skippedOres.add(bp);
                resetTransientBreak();
            } else {
                logic.handleHazard(probe, "lava_hazard");
                resetTransientBreak();
            }
            return;
        }
        if (st.getHardness(w, activeBreakPos) < 0f) {
            actions.stopBreaking(mc);
            if (activeBreakIsOre) {
                skippedOres.add(bp);
                resetTransientBreak();
            } else {
                logic.handleHazard(probe, "unbreakable_block");
                resetTransientBreak();
            }
            return;
        }
        actions.selectBestToolFor(mc, st);
        if (st.isToolRequired() && !p.getMainHandStack().isSuitableFor(st)) {
            actions.stopBreaking(mc);
            resetTransientBreak();
            emitTerminal("branch_failed", "missing suitable tool for " + Ids.normalize(Registries.BLOCK.getId(st.getBlock()).toString()), false);
            return;
        }
        if (!p.canInteractWithBlockAt(activeBreakPos, 0)) {
            actions.stopBreaking(mc);
            if (activeBreakIsOre) {
                skippedOres.add(bp);
                resetTransientBreak();
                return;
            }
            actions.steerToward(mc, p, Vec3d.ofCenter(activeBreakPos), false);
            return;
        }
        actions.releaseMovement(mc);
        boolean done = actions.breakBlockTick(mc, p, activeBreakPos, !breakStarted);
        breakStarted = true;
        if (++breakTicks > BREAK_TIMEOUT_TICKS) {
            actions.stopBreaking(mc);
            if (activeBreakIsOre) {
                skippedOres.add(bp);
                resetTransientBreak();
                return;
            }
            emitTerminal("branch_failed", "block breaking timed out", false);
            return;
        }
        if (done) {
            finishCurrentBreak(w, probe, false);
        }
    }

    private void finishCurrentBreak(ClientWorld w, BlockProbe probe, boolean alreadyAir) {
        if (!alreadyAir || activeBreakKind != null) {
            logic.noteBlockBroken(activeBreakKind == null ? CellKind.SOLID : activeBreakKind);
        }
        if (activeBreakIsOre) {
            oresMined++;
            pickupWaitTicks = 4;
        } else if (probe.cell(activeBreakPos.getX(), activeBreakPos.getY() + 1, activeBreakPos.getZ()) == CellKind.FALLING) {
            fallWaitTicks = 4;
        }
        resetTransientBreak();
    }

    private boolean startNextOre(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w, BlockProbe probe) {
        while (!pendingOres.isEmpty()) {
            Pos ore = pendingOres.pollFirst();
            if (skippedOres.contains(ore)) continue;
            BlockPos bp = new BlockPos(ore.x(), ore.y(), ore.z());
            String id = probe.id(ore.x(), ore.y(), ore.z());
            if (!logic.params().targetOres().contains(id)) continue;
            if (!BranchMinerLogic.isSafeToBreak(probe, ore)) continue;
            if (!p.canInteractWithBlockAt(bp, 0)) {
                double distSq = p.getEyePos().squaredDistanceTo(Vec3d.ofCenter(bp));
                if (distSq > 20.0) continue;
                actions.steerToward(mc, p, Vec3d.ofCenter(bp), false);
                pendingOres.addFirst(ore);
                return true;
            }
            actions.releaseMovement(mc);
            activeBreakPos = bp;
            activeBreakKind = probe.cell(ore.x(), ore.y(), ore.z());
            activeBreakIsOre = true;
            breakStarted = false;
            breakTicks = 0;
            return true;
        }
        return false;
    }

    private void tickWalking(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w, BlockProbe probe) {
        String hazard = logic.checkStepFloorHazard(probe, walkingTarget);
        if (hazard != null) {
            actions.releaseMovement(mc);
            walkingTarget = null;
            logic.handleHazard(probe, hazard);
            return;
        }
        Vec3d targetCenter = new Vec3d(walkingTarget.x() + 0.5, walkingTarget.y(), walkingTarget.z() + 0.5);
        double distXZ = Math.hypot(p.getX() - targetCenter.x, p.getZ() - targetCenter.z);
        if (distXZ < 0.35 && p.getBlockY() <= walkingTarget.y()) {
            actions.releaseMovement(mc);
            Pos arrived = walkingTarget;
            walkingTarget = null;
            logic.completeStep(arrived);
            maybePlaceTorch(mc, p, w);
            queueVisibleOres(p, w, probe);
            emitProgressIfNeeded(p, logic.phase() != lastProgressPhase);
            return;
        }
        if (++walkTicks > WALK_TIMEOUT_TICKS) {
            actions.releaseMovement(mc);
            walkingTarget = null;
            emitTerminal("branch_failed", "step movement stuck at " + arrivedLabel(p), false);
            return;
        }
        actions.steerToward(mc, p, targetCenter, false);
    }

    private void maybePlaceTorch(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w) {
        int light = Math.max(0, Math.min(15, w.getLightLevel(p.getBlockPos())));
        if (!logic.shouldPlaceTorch(light)) return;
        if (!actions.selectOrSwapItem(mc, s -> s.isOf(Items.TORCH))) return;
        BlockPos feet = p.getBlockPos();
        BlockPos below = feet.down();
        if (!w.getBlockState(feet).isReplaceable()) return;
        if (!w.getBlockState(below).isSideSolidFullSquare(w, below, Direction.UP)) return;
        Vec3d hitPos = new Vec3d(below.getX() + 0.5, below.getY() + 1.0, below.getZ() + 0.5);
        actions.lookAt(p, hitPos, false);
        if (mc.interactionManager != null) {
            mc.interactionManager.interactBlock(p, Hand.MAIN_HAND, new BlockHitResult(hitPos, Direction.UP, below, false));
            p.swingHand(Hand.MAIN_HAND);
            logic.recordTorchPlaced();
        }
    }

    private void queueVisibleOres(ClientPlayerEntity p, ClientWorld w, BlockProbe probe) {
        Vec3d eye = p.getEyePos();
        List<Pos> visible = logic.findVisibleExposedOres(probe, BlockSight.opaqueSolid(w), eye.x, eye.y, eye.z, 4);
        for (Pos ore : visible) {
            if (!skippedOres.contains(ore) && !pendingOres.contains(ore)) {
                pendingOres.addLast(ore);
            }
        }
    }

    private boolean finishCheck(ClientPlayerEntity p) {
        if (terminated) return true;
        if (!logic.finished()) return false;
        if (logic.phase() == Phase.DONE) {
            emitTerminal("branch_finished", null, false);
        } else {
            String err = logic.abortReason() != null ? logic.abortReason() : "aborted";
            emitTerminal("branch_failed", err, false);
        }
        return true;
    }

    private void emitProgressIfNeeded(ClientPlayerEntity p, boolean phaseChanged) {
        int steps = logic.stepsTaken();
        if (!phaseChanged && lastProgressStep >= 0 && steps - lastProgressStep < PROGRESS_STEP_INTERVAL) return;
        lastProgressStep = steps;
        lastProgressPhase = logic.phase();
        JsonObject d = summaryJson(p);
        WorldWorkers.attachTask(d, taskId);
        events.emit("branch_progress", d);
    }

    private void emitTerminal(String eventName, String error, boolean cancelled) {
        if (terminated) return;
        terminated = true;
        JsonObject d = summaryJson(MinecraftClient.getInstance().player);
        if (error != null) {
            d.addProperty("error", error);
            d.addProperty("reason", error);
        }
        if (cancelled) d.addProperty("cancelled", true);
        WorldWorkers.attachTask(d, taskId);
        events.emit(eventName, d);
    }

    private JsonObject summaryJson(ClientPlayerEntity p) {
        JsonObject d = new JsonObject();
        d.addProperty("phase", logic.phase().name().toLowerCase());
        d.addProperty("steps", logic.stepsTaken());
        d.addProperty("target_y", logic.params().targetY());
        d.addProperty("ores_mined", oresMined);
        d.addProperty("torches_placed", logic.torchesPlaced());
        Pos foot = logic.foot();
        BlockPos bp = p != null ? p.getBlockPos() : new BlockPos(foot.x(), foot.y(), foot.z());
        d.add("position", GameActions.posJson(bp));
        return d;
    }

    private void resetTransientBreak() {
        activeBreakPos = null;
        activeBreakKind = null;
        activeBreakIsOre = false;
        breakStarted = false;
        breakTicks = 0;
    }

    private static String arrivedLabel(ClientPlayerEntity p) {
        return p.getBlockX() + "," + p.getBlockY() + "," + p.getBlockZ();
    }

    private static final class WorldProbe implements BlockProbe {
        private final ClientWorld w;
        private final BlockPos.Mutable m = new BlockPos.Mutable();

        WorldProbe(ClientWorld w) {
            this.w = w;
        }

        @Override
        public CellKind cell(int x, int y, int z) {
            m.set(x, y, z);
            BlockState st = w.getBlockState(m);
            if (st.getFluidState().isIn(FluidTags.LAVA) || st.isOf(Blocks.LAVA)) return CellKind.LAVA;
            if (st.getFluidState().isIn(FluidTags.WATER) || st.isOf(Blocks.WATER)) return CellKind.WATER;
            if (st.getBlock() instanceof FallingBlock) return CellKind.FALLING;
            if (st.isAir() || st.getBlock() instanceof TorchBlock
                    || (st.getCollisionShape(w, m).isEmpty() && st.getHardness(w, m) <= 0.1f)) {
                return CellKind.AIR;
            }
            return CellKind.SOLID;
        }

        @Override
        public String id(int x, int y, int z) {
            m.set(x, y, z);
            return Ids.normalize(Registries.BLOCK.getId(w.getBlockState(m).getBlock()).toString());
        }
    }
}
