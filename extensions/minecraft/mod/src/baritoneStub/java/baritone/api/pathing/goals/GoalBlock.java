// COMPILE-ONLY STUB -- NOT THE REAL BARITONE.
// Only used when libs/baritone-api-fabric-*.jar is missing, so that the unit tests can still compile and run.
// Never packaged into the mod. Signatures mirror Baritone 1.11.3 (Minecraft 1.21.1) for the members miyoria-bridge uses.
// Fix: ./gradlew downloadBaritone
package baritone.api.pathing.goals;

public class GoalBlock implements Goal {
    public final int x, y, z;

    public GoalBlock(int x, int y, int z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    public GoalBlock(net.minecraft.util.math.BlockPos pos) {
        this(pos.getX(), pos.getY(), pos.getZ());
    }

    @Override
    public boolean isInGoal(int x, int y, int z) {
        return x == this.x && y == this.y && z == this.z;
    }

    @Override
    public double heuristic(int x, int y, int z) {
        return 0;
    }

    @Override
    public String toString() {
        return "GoalBlock{x=" + x + ",y=" + y + ",z=" + z + "}";
    }
}
