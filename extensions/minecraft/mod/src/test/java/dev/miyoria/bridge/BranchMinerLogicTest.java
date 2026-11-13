package dev.miyoria.bridge;

import dev.miyoria.bridge.mine.BranchMinerLogic;
import dev.miyoria.bridge.mine.BranchMinerLogic.BlockProbe;
import dev.miyoria.bridge.mine.BranchMinerLogic.CellKind;
import dev.miyoria.bridge.mine.BranchMinerLogic.Dir;
import dev.miyoria.bridge.mine.BranchMinerLogic.Params;
import dev.miyoria.bridge.mine.BranchMinerLogic.Phase;
import dev.miyoria.bridge.mine.BranchMinerLogic.Pos;
import dev.miyoria.bridge.mine.BranchMinerLogic.StepPlan;
import dev.miyoria.bridge.util.Visibility;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class BranchMinerLogicTest {

    private static final class TestWorld implements BlockProbe, Visibility.Opaque {
        private final Map<Pos, CellKind> cells = new HashMap<>();
        private final Map<Pos, String> ids = new HashMap<>();

        void set(int x, int y, int z, CellKind kind, String id) {
            Pos p = new Pos(x, y, z);
            cells.put(p, kind);
            ids.put(p, id);
        }

        void dig(Pos p) {
            cells.put(p, CellKind.AIR);
            ids.put(p, "air");
        }

        @Override
        public CellKind cell(int x, int y, int z) {
            return cells.getOrDefault(new Pos(x, y, z), CellKind.SOLID);
        }

        @Override
        public String id(int x, int y, int z) {
            return ids.getOrDefault(new Pos(x, y, z), "stone");
        }

        @Override
        public boolean at(int x, int y, int z) {
            CellKind k = cell(x, y, z);
            return k == CellKind.SOLID || k == CellKind.FALLING;
        }
    }

    private static void carveStartingPocket(TestWorld w, Pos foot) {
        w.dig(foot);
        w.dig(foot.offset(0, 1, 0));
    }

    @Test
    void staircaseDescendsToTargetYThenRunsMainAndAlternatingBranches() {
        TestWorld w = new TestWorld();
        Pos start = new Pos(0, 14, 0);
        carveStartingPocket(w, start);
        Params params = new Params(12, 30, 3, 2, 8, 7, Set.of("diamond_ore"));
        BranchMinerLogic logic = new BranchMinerLogic(start, Dir.NORTH, params);

        assertEquals(Phase.STAIRCASE, logic.phase());

        // Step 1: 14 -> 13 (breaks y+2, y+1, y, y-1 ahead at z=-1)
        StepPlan s1 = logic.planNextStep(w);
        assertFalse(s1.blocked());
        assertEquals(new Pos(0, 13, -1), s1.nextFoot());
        assertEquals(4, s1.blocksToBreak().size());
        assertEquals(16, s1.blocksToBreak().get(0).y());
        assertEquals(13, s1.blocksToBreak().get(3).y());
        s1.blocksToBreak().forEach(w::dig);
        assertNull(logic.checkStepFloorHazard(w, s1.nextFoot()));
        logic.completeStep(s1.nextFoot());
        assertEquals(Phase.STAIRCASE, logic.phase());

        // Step 2: 13 -> 12 reaches targetY -> switches to MAIN_TUNNEL
        StepPlan s2 = logic.planNextStep(w);
        s2.blocksToBreak().forEach(w::dig);
        logic.completeStep(s2.nextFoot());
        assertEquals(new Pos(0, 12, -2), logic.foot());
        assertEquals(Phase.MAIN_TUNNEL, logic.phase());

        // Two main tunnel steps trigger LEFT side branch (WEST)
        for (int i = 0; i < 2; i++) {
            StepPlan mp = logic.planNextStep(w);
            assertEquals(2, mp.blocksToBreak().size());
            mp.blocksToBreak().forEach(w::dig);
            logic.completeStep(mp.nextFoot());
        }
        assertEquals(new Pos(0, 12, -4), logic.foot());
        assertEquals(Phase.SIDE_BRANCH, logic.phase());
        assertEquals(Dir.WEST, logic.heading());

        // Three branch steps west -> RETURN_TO_MAIN (EAST)
        for (int i = 0; i < 3; i++) {
            StepPlan bp = logic.planNextStep(w);
            bp.blocksToBreak().forEach(w::dig);
            logic.completeStep(bp.nextFoot());
        }
        assertEquals(new Pos(-3, 12, -4), logic.foot());
        assertEquals(Phase.RETURN_TO_MAIN, logic.phase());
        assertEquals(Dir.EAST, logic.heading());

        // Three return steps bring miner back to junction (0, 12, -4) and resume NORTH
        for (int i = 0; i < 3; i++) {
            StepPlan rp = logic.planNextStep(w);
            assertTrue(rp.blocksToBreak().isEmpty());
            logic.completeStep(rp.nextFoot());
        }
        assertEquals(new Pos(0, 12, -4), logic.foot());
        assertEquals(Phase.MAIN_TUNNEL, logic.phase());
        assertEquals(Dir.NORTH, logic.heading());

        // Two more main tunnel steps trigger RIGHT side branch (EAST)
        for (int i = 0; i < 2; i++) {
            StepPlan mp = logic.planNextStep(w);
            mp.blocksToBreak().forEach(w::dig);
            logic.completeStep(mp.nextFoot());
        }
        assertEquals(Phase.SIDE_BRANCH, logic.phase());
        assertEquals(Dir.EAST, logic.heading());
    }

    @Test
    void stopsBeforeBreakingIntoAdjacentLavaOrWater() {
        TestWorld w = new TestWorld();
        Pos start = new Pos(0, 12, 0);
        carveStartingPocket(w, start);
        // Lava right next to the upcoming tunnel head block (0, 13, -1) on its east face
        w.set(1, 13, -1, CellKind.LAVA, "lava");
        Params params = new Params(12, 20, 4, 2, 0, 7, Set.of());
        BranchMinerLogic logic = new BranchMinerLogic(start, Dir.NORTH, params);

        StepPlan plan = logic.planNextStep(w);
        assertTrue(plan.blocked());
        assertEquals("lava_hazard", plan.hazard());
        assertTrue(plan.blocksToBreak().isEmpty());

        // Handle hazard turns to clear side (WEST, since EAST has lava adjacent too)
        logic.handleHazard(w, plan.hazard());
        assertEquals(Dir.WEST, logic.heading());
        assertEquals(Phase.MAIN_TUNNEL, logic.phase());

        // Now box in WEST and SOUTH/NORTH with water to confirm eventual clean abort
        w.set(-2, 12, 0, CellKind.WATER, "water");
        StepPlan blockedWest = logic.planNextStep(w);
        assertTrue(blockedWest.blocked());
        assertEquals("water_hazard", blockedWest.hazard());
        logic.handleHazard(w, blockedWest.hazard());
        // Turns once more or aborts if other directions blocked; force consecutive trap:
        w.set(-1, 12, -1, CellKind.LAVA, "lava");
        w.set(1, 12, 0, CellKind.WATER, "water");
        w.set(0, 12, 1, CellKind.LAVA, "lava");
        StepPlan trapped = logic.planNextStep(w);
        if (trapped.blocked()) logic.handleHazard(w, trapped.hazard());
        // If not aborted yet, one more trapped turn exceeds maxConsecutiveTurns (2)
        if (!logic.finished()) {
            StepPlan trapped2 = logic.planNextStep(w);
            assertTrue(trapped2.blocked());
            logic.handleHazard(w, trapped2.hazard());
        }
        assertEquals(Phase.ABORTED, logic.phase());
    }

    @Test
    void detectsSteepDropOverTwoBlocksUnderOpenedStep() {
        TestWorld w = new TestWorld();
        Pos start = new Pos(0, 12, 0);
        carveStartingPocket(w, start);
        // Dig out 3 blocks below next step (0, 12, -1): y=11, 10, 9 -> drop depth 3 (> 2)
        w.dig(new Pos(0, 11, -1));
        w.dig(new Pos(0, 10, -1));
        w.dig(new Pos(0, 9, -1));
        Params params = new Params(12, 20, 4, 2, 0, 7, Set.of());
        BranchMinerLogic logic = new BranchMinerLogic(start, Dir.NORTH, params);

        StepPlan plan = logic.planNextStep(w);
        assertFalse(plan.blocked());
        plan.blocksToBreak().forEach(w::dig);

        assertEquals("steep_drop", logic.checkStepFloorHazard(w, plan.nextFoot()));

        // A 2-block drop (solid at y=9 -> only y=11, y=10 air) is NOT considered > 2 steep drop
        w.set(0, 9, -1, CellKind.SOLID, "stone");
        assertNull(logic.checkStepFloorHazard(w, plan.nextFoot()));
    }

    @Test
    void handlesFallingOverheadSandOrGravelAndAbortsOnRunawayColumn() {
        TestWorld w = new TestWorld();
        Pos start = new Pos(0, 12, 0);
        carveStartingPocket(w, start);
        w.set(0, 14, -1, CellKind.FALLING, "gravel");
        w.set(0, 13, -1, CellKind.FALLING, "gravel");
        Params params = new Params(12, 20, 4, 2, 0, 7, Set.of());
        BranchMinerLogic logic = new BranchMinerLogic(start, Dir.NORTH, params);

        StepPlan plan = logic.planNextStep(w);
        assertTrue(plan.fallingOverhead());
        assertFalse(plan.blocked());

        // Simulate 16 falling blocks collapsing into the head slot -> runaway protection triggers
        for (int i = 0; i < 16; i++) {
            logic.noteBlockBroken(CellKind.FALLING);
        }
        StepPlan cap = logic.planNextStep(w);
        assertTrue(cap.blocked());
        assertEquals("falling_overhead", cap.hazard());
    }

    @Test
    void torchPlacementRespectsIntervalAndLightThreshold() {
        TestWorld w = new TestWorld();
        Pos start = new Pos(0, 12, 0);
        carveStartingPocket(w, start);
        Params params = new Params(12, 20, 4, 5, 4, 7, Set.of());
        BranchMinerLogic logic = new BranchMinerLogic(start, Dir.NORTH, params);

        for (int i = 0; i < 3; i++) {
            StepPlan p = logic.planNextStep(w);
            p.blocksToBreak().forEach(w::dig);
            logic.completeStep(p.nextFoot());
            assertFalse(logic.shouldPlaceTorch(0));
        }

        StepPlan p4 = logic.planNextStep(w);
        p4.blocksToBreak().forEach(w::dig);
        logic.completeStep(p4.nextFoot());

        assertFalse(logic.shouldPlaceTorch(10)); // well-lit -> no torch needed
        assertTrue(logic.shouldPlaceTorch(7));   // <= maxLight -> place torch
        logic.recordTorchPlaced();
        assertEquals(1, logic.torchesPlaced());
        assertFalse(logic.shouldPlaceTorch(0));  // counter reset
    }

    @Test
    void findVisibleExposedOresNeverUsesXRay() {
        TestWorld w = new TestWorld();
        Pos start = new Pos(0, 12, 0);
        carveStartingPocket(w, start);
        w.dig(new Pos(0, 12, -1));
        w.dig(new Pos(0, 13, -1));

        // Exposed diamond ore in wall with direct line of sight from player's eye
        w.set(1, 13, -1, CellKind.SOLID, "diamond_ore");
        // Buried diamond ore completely sealed behind stone (must NEVER be found)
        w.set(2, 13, -1, CellKind.SOLID, "diamond_ore");
        // Exposed diamond ore blocked behind a 3x3 stone wall (no line of sight)
        w.dig(new Pos(0, 12, -3));
        w.set(0, 12, -4, CellKind.SOLID, "diamond_ore");

        Params params = new Params(12, 20, 4, 5, 8, 7, Set.of("diamond_ore"));
        BranchMinerLogic logic = new BranchMinerLogic(start, Dir.NORTH, params);
        logic.completeStep(new Pos(0, 12, -1));

        List<Pos> visible = logic.findVisibleExposedOres(w, w, 0.5, 13.62, -0.5, 5);
        assertEquals(List.of(new Pos(1, 13, -1)), visible);
    }
}
