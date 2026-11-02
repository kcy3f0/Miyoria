// COMPILE-ONLY STUB -- NOT THE REAL BARITONE.
// Only used when libs/baritone-api-fabric-*.jar is missing, so that the unit tests can still compile and run.
// Never packaged into the mod. Signatures mirror Baritone 1.11.3 (Minecraft 1.21.1) for the members miyoria-bridge uses.
// Fix: ./gradlew downloadBaritone
package baritone.api.pathing.goals;

import net.minecraft.util.math.BlockPos;

public class GoalGetToBlock implements Goal {
    public GoalGetToBlock(BlockPos pos) {}

    @Override
    public boolean isInGoal(int x, int y, int z) {
        return false;
    }

    @Override
    public double heuristic(int x, int y, int z) {
        return 0;
    }
}
