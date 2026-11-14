package dev.miyoria.bridge.mine;

import dev.miyoria.bridge.util.Visibility;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Pure-Java state machine and local-only safety logic for legitimate branch mining.
 * Inspects only blocks directly adjacent to broken faces, downward into already-opened steps,
 * and exposed faces along genuine line of sight ({@link Visibility}).
 */
public final class BranchMinerLogic {

    public enum CellKind {
        AIR,
        SOLID,
        LAVA,
        WATER,
        FALLING
    }

    public enum Phase {
        STAIRCASE,
        MAIN_TUNNEL,
        SIDE_BRANCH,
        RETURN_TO_MAIN,
        DONE,
        ABORTED
    }

    public enum Dir {
        NORTH(0, -1),
        EAST(1, 0),
        SOUTH(0, 1),
        WEST(-1, 0);

        public final int dx;
        public final int dz;

        Dir(int dx, int dz) {
            this.dx = dx;
            this.dz = dz;
        }

        public Dir left() {
            return switch (this) {
                case NORTH -> WEST;
                case WEST -> SOUTH;
                case SOUTH -> EAST;
                case EAST -> NORTH;
            };
        }

        public Dir right() {
            return switch (this) {
                case NORTH -> EAST;
                case EAST -> SOUTH;
                case SOUTH -> WEST;
                case WEST -> NORTH;
            };
        }

        public Dir opposite() {
            return switch (this) {
                case NORTH -> SOUTH;
                case SOUTH -> NORTH;
                case EAST -> WEST;
                case WEST -> EAST;
            };
        }

        public static Dir fromYaw(float yaw) {
            float norm = ((yaw % 360f) + 360f) % 360f;
            if (norm >= 315f || norm < 45f) return SOUTH;
            if (norm < 135f) return WEST;
            if (norm < 225f) return NORTH;
            return EAST;
        }
    }

    public record Pos(int x, int y, int z) {
        public Pos offset(int dx, int dy, int dz) {
            return new Pos(x + dx, y + dy, z + dz);
        }

        public Pos step(Dir dir) {
            return new Pos(x + dir.dx, y, z + dir.dz);
        }
    }

    public record Params(
            int targetY,
            int maxSteps,
            int branchLength,
            int branchSpacing,
            int torchInterval,
            int torchMaxLight,
            Set<String> targetOres) {

        public Params {
            targetY = Math.max(-63, Math.min(319, targetY));
            maxSteps = Math.max(1, Math.min(512, maxSteps));
            branchLength = Math.max(2, Math.min(32, branchLength));
            branchSpacing = Math.max(2, Math.min(16, branchSpacing));
            torchInterval = Math.max(0, Math.min(32, torchInterval));
            torchMaxLight = Math.max(0, Math.min(15, torchMaxLight));
            targetOres = targetOres == null ? Set.of() : Set.copyOf(targetOres);
        }
    }

    public interface BlockProbe {
        CellKind cell(int x, int y, int z);
        String id(int x, int y, int z);
    }

    public record StepPlan(
            Pos nextFoot,
            List<Pos> blocksToBreak,
            boolean fallingOverhead,
            String hazard) {
        public boolean blocked() {
            return hazard != null;
        }
    }

    private static final int MAX_FALLING_CLEARS_PER_STEP = 16;

    private final Params params;
    private Phase phase;
    private Pos foot;
    private Dir mainDir;
    private Dir heading;
    private Pos junctionPos;
    private boolean nextSideLeft = true;
    private int stepsTaken;
    private int mainStepsSinceBranch;
    private int branchSteps;
    private int stepsSinceTorch;
    private int torchesPlaced;
    private int consecutiveTurns;
    private int fallingClearedThisStep;
    private String abortReason;

    public BranchMinerLogic(Pos startFoot, Dir initialDir, Params params) {
        this.foot = Objects.requireNonNull(startFoot, "startFoot");
        this.mainDir = Objects.requireNonNull(initialDir, "initialDir");
        this.heading = initialDir;
        this.params = Objects.requireNonNull(params, "params");
        this.phase = startFoot.y() > params.targetY() ? Phase.STAIRCASE : Phase.MAIN_TUNNEL;
    }

    public Phase phase() { return phase; }
    public Pos foot() { return foot; }
    public Dir mainDir() { return mainDir; }
    public Dir heading() { return heading; }
    public Params params() { return params; }
    public int stepsTaken() { return stepsTaken; }
    public int torchesPlaced() { return torchesPlaced; }
    public String abortReason() { return abortReason; }

    public boolean finished() {
        return phase == Phase.DONE || phase == Phase.ABORTED;
    }

    /** Computes the next foot target and ordered top-down blocks to break before stepping. */
    public StepPlan planNextStep(BlockProbe probe) {
        if (finished()) return new StepPlan(foot, List.of(), false, abortReason);

        Pos nextFoot = targetNextFoot();
        List<Pos> column = orderedBreakColumn(nextFoot);

        for (Pos b : column) {
            CellKind kind = probe.cell(b.x(), b.y(), b.z());
            if (kind == CellKind.LAVA) return new StepPlan(nextFoot, List.of(), false, "lava_hazard");
            if (kind == CellKind.WATER) return new StepPlan(nextFoot, List.of(), false, "water_hazard");
            String adjFluid = adjacentFluid(probe, b.x(), b.y(), b.z());
            if (adjFluid != null) return new StepPlan(nextFoot, List.of(), false, adjFluid);
        }

        List<Pos> toBreak = new ArrayList<>();
        for (Pos b : column) {
            if (probe.cell(b.x(), b.y(), b.z()) != CellKind.AIR) {
                toBreak.add(b);
            }
        }

        Pos top = column.get(0);
        boolean fallingOverhead = probe.cell(top.x(), top.y() + 1, top.z()) == CellKind.FALLING;
        if (!toBreak.isEmpty()) {
            Pos first = toBreak.get(0);
            if (probe.cell(first.x(), first.y(), first.z()) == CellKind.FALLING) {
                if (fallingClearedThisStep >= MAX_FALLING_CLEARS_PER_STEP) {
                    return new StepPlan(nextFoot, List.of(), true, "falling_overhead");
                }
            }
        }
        return new StepPlan(nextFoot, toBreak, fallingOverhead, null);
    }

    /** Records a broken block that turned out to be falling sand/gravel. */
    public void noteBlockBroken(CellKind brokenKind) {
        if (brokenKind == CellKind.FALLING) fallingClearedThisStep++;
    }

    /**
     * Verifies floor safety under {@code nextFoot} AFTER breaking the step column, before moving
     * onto {@code nextFoot}. Inspects downward only through the already-opened step column.
     */
    public String checkStepFloorHazard(BlockProbe probe, Pos nextFoot) {
        if (nextFoot.y() <= -64) return "void_hazard";
        CellKind floor1 = probe.cell(nextFoot.x(), nextFoot.y() - 1, nextFoot.z());
        if (floor1 == CellKind.LAVA) return "lava_hazard";
        if (floor1 == CellKind.WATER) return "water_hazard";
        if (floor1 != CellKind.AIR) return null;

        CellKind floor2 = probe.cell(nextFoot.x(), nextFoot.y() - 2, nextFoot.z());
        if (floor2 == CellKind.LAVA) return "lava_hazard";
        if (floor2 == CellKind.WATER) return "water_hazard";
        if (floor2 != CellKind.AIR) return null;

        CellKind floor3 = probe.cell(nextFoot.x(), nextFoot.y() - 3, nextFoot.z());
        if (floor3 == CellKind.LAVA) return "lava_hazard";
        if (floor3 == CellKind.WATER) return "water_hazard";
        if (floor3 == CellKind.AIR) return "steep_drop";
        return null;
    }

    /**
     * Handles a hazard detected at the current heading: skips a side branch back to the junction,
     * turns cleanly if in staircase/main tunnel and a safe perpendicular direction is available,
     * or aborts if trapped.
     */
    public void handleHazard(BlockProbe probe, String reason) {
        fallingClearedThisStep = 0;
        if (phase == Phase.SIDE_BRANCH) {
            if (branchSteps == 0 || foot.equals(junctionPos)) {
                phase = Phase.MAIN_TUNNEL;
                heading = mainDir;
                mainStepsSinceBranch = 0;
            } else {
                phase = Phase.RETURN_TO_MAIN;
                heading = heading.opposite();
            }
            consecutiveTurns = 0;
            return;
        }
        if (phase == Phase.RETURN_TO_MAIN || "falling_overhead".equals(reason)) {
            abort(reason);
            return;
        }
        if (consecutiveTurns >= 2) {
            abort(reason);
            return;
        }
        Dir[] alts = {heading.left(), heading.right()};
        for (Dir alt : alts) {
            if (isDirectionLocallyClear(probe, alt)) {
                heading = alt;
                mainDir = alt;
                consecutiveTurns++;
                return;
            }
        }
        abort(reason);
    }

    /** Advances state after cleanly stepping onto {@code arrivedFoot}. */
    public void completeStep(Pos arrivedFoot) {
        this.foot = arrivedFoot;
        this.fallingClearedThisStep = 0;
        this.consecutiveTurns = 0;
        this.stepsTaken++;
        this.stepsSinceTorch++;

        if (stepsTaken >= params.maxSteps() && phase != Phase.RETURN_TO_MAIN) {
            phase = Phase.DONE;
            return;
        }

        switch (phase) {
            case STAIRCASE -> {
                if (foot.y() <= params.targetY()) {
                    phase = Phase.MAIN_TUNNEL;
                    heading = mainDir;
                    mainStepsSinceBranch = 0;
                }
            }
            case MAIN_TUNNEL -> {
                mainStepsSinceBranch++;
                if (mainStepsSinceBranch >= params.branchSpacing() && stepsTaken < params.maxSteps()) {
                    phase = Phase.SIDE_BRANCH;
                    junctionPos = foot;
                    heading = nextSideLeft ? mainDir.left() : mainDir.right();
                    nextSideLeft = !nextSideLeft;
                    branchSteps = 0;
                }
            }
            case SIDE_BRANCH -> {
                branchSteps++;
                if (branchSteps >= params.branchLength()) {
                    phase = Phase.RETURN_TO_MAIN;
                    heading = heading.opposite();
                }
            }
            case RETURN_TO_MAIN -> {
                if (junctionPos != null && foot.x() == junctionPos.x() && foot.z() == junctionPos.z()) {
                    if (stepsTaken >= params.maxSteps()) {
                        phase = Phase.DONE;
                    } else {
                        phase = Phase.MAIN_TUNNEL;
                        heading = mainDir;
                        mainStepsSinceBranch = 0;
                    }
                }
            }
            case DONE, ABORTED -> {}
        }
    }

    public boolean shouldPlaceTorch(int currentLightLevel) {
        return !finished()
                && params.torchInterval() > 0
                && stepsSinceTorch >= params.torchInterval()
                && currentLightLevel <= params.torchMaxLight();
    }

    public void recordTorchPlaced() {
        stepsSinceTorch = 0;
        torchesPlaced++;
    }

    /**
     * Scans only exposed blocks with genuine line of sight from eye position that match
     * {@code targetOres} and have no directly adjacent lava or water.
     */
    public List<Pos> findVisibleExposedOres(
            BlockProbe probe, Visibility.Opaque opaque, double eyeX, double eyeY, double eyeZ, int radius) {
        if (params.targetOres().isEmpty()) return List.of();
        int r = Math.max(1, Math.min(8, radius));
        List<Pos> found = new ArrayList<>();
        for (int dx = -r; dx <= r; dx++) {
            for (int dz = -r; dz <= r; dz++) {
                for (int dy = -2; dy <= 3; dy++) {
                    int x = foot.x() + dx;
                    int y = foot.y() + dy;
                    int z = foot.z() + dz;
                    String id = probe.id(x, y, z);
                    if (id == null || !params.targetOres().contains(id)) continue;
                    if (!Visibility.visible(eyeX, eyeY, eyeZ, x, y, z, opaque)) continue;
                    if (adjacentFluid(probe, x, y, z) != null) continue;
                    found.add(new Pos(x, y, z));
                }
            }
        }
        found.sort(Comparator.comparingDouble(p -> {
            double gx = p.x() + 0.5 - eyeX;
            double gy = p.y() + 0.5 - eyeY;
            double gz = p.z() + 0.5 - eyeZ;
            return gx * gx + gy * gy + gz * gz;
        }));
        return found;
    }

    /** Returns true if breaking {@code pos} touches no lava or water on its 6 faces. */
    public static boolean isSafeToBreak(BlockProbe probe, Pos pos) {
        CellKind self = probe.cell(pos.x(), pos.y(), pos.z());
        if (self == CellKind.LAVA || self == CellKind.WATER) return false;
        return adjacentFluid(probe, pos.x(), pos.y(), pos.z()) == null;
    }

    private Pos targetNextFoot() {
        if (phase == Phase.STAIRCASE) {
            return foot.offset(heading.dx, -1, heading.dz);
        }
        if (phase == Phase.RETURN_TO_MAIN && junctionPos != null) {
            int dx = Integer.compare(junctionPos.x(), foot.x());
            int dz = Integer.compare(junctionPos.z(), foot.z());
            if (dx != 0) return foot.offset(dx, 0, 0);
            if (dz != 0) return foot.offset(0, 0, dz);
        }
        return foot.step(heading);
    }

    private List<Pos> orderedBreakColumn(Pos nextFoot) {
        List<Pos> cols = new ArrayList<>(4);
        if (phase == Phase.STAIRCASE) {
            // Descending 1 block forward + 1 block down requires clearing y+2, y+1, y, y-1
            // so the player's head never catches on the ceiling.
            cols.add(new Pos(nextFoot.x(), foot.y() + 2, nextFoot.z()));
            cols.add(new Pos(nextFoot.x(), foot.y() + 1, nextFoot.z()));
            cols.add(new Pos(nextFoot.x(), foot.y(), nextFoot.z()));
            cols.add(nextFoot);
        } else {
            cols.add(nextFoot.offset(0, 1, 0));
            cols.add(nextFoot);
        }
        return cols;
    }

    private boolean isDirectionLocallyClear(BlockProbe probe, Dir dir) {
        Pos candidate = phase == Phase.STAIRCASE
                ? foot.offset(dir.dx, -1, dir.dz)
                : foot.step(dir);
        for (Pos b : orderedBreakColumn(candidate)) {
            CellKind k = probe.cell(b.x(), b.y(), b.z());
            if (k == CellKind.LAVA || k == CellKind.WATER) return false;
            if (adjacentFluid(probe, b.x(), b.y(), b.z()) != null) return false;
        }
        if (probe.cell(candidate.x(), candidate.y(), candidate.z()) == CellKind.AIR
                && checkStepFloorHazard(probe, candidate) != null) {
            return false;
        }
        return true;
    }

    private static String adjacentFluid(BlockProbe probe, int x, int y, int z) {
        int[][] offsets = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
        for (int[] d : offsets) {
            CellKind k = probe.cell(x + d[0], y + d[1], z + d[2]);
            if (k == CellKind.LAVA) return "lava_hazard";
            if (k == CellKind.WATER) return "water_hazard";
        }
        return null;
    }

    private void abort(String reason) {
        this.phase = Phase.ABORTED;
        this.abortReason = reason;
    }
}
