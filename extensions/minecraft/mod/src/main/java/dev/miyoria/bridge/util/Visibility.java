package dev.miyoria.bridge.util;

/**
 * "Could a person standing here see that block?", without Minecraft types so it is unit-testable.
 *
 * <p>A block is visible when one of its faces is open (the neighbour across it is not an opaque
 * full block), is turned towards the eye, and the straight line from the eye to just outside that
 * face's centre crosses no opaque full block. Leaves, glass and water do not block the view, like
 * for a person looking around; an ore sealed inside stone is never visible. This is what keeps
 * {@code observe}, {@code goto {block}} and {@code mine} from x-raying through walls.
 */
public final class Visibility {
    private Visibility() {}

    /** Whether the block at a position is an opaque full cube (blocks the view). */
    @FunctionalInterface
    public interface Opaque {
        boolean at(int x, int y, int z);
    }

    private static final int[][] FACES = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
    /** Safety net for the voxel walk (a 32-block line crosses at most ~96 voxels). */
    private static final int MAX_STEPS = 256;

    /** True when at least one face of the block is open to a see-through neighbour. Cheap pre-filter. */
    public static boolean exposed(int bx, int by, int bz, Opaque opaque) {
        for (int[] f : FACES) {
            if (!opaque.at(bx + f[0], by + f[1], bz + f[2])) return true;
        }
        return false;
    }

    public static boolean visible(double ex, double ey, double ez, int bx, int by, int bz, Opaque opaque) {
        for (int[] f : FACES) {
            double plane = f[0] != 0 ? bx + 0.5 + f[0] * 0.5 : f[1] != 0 ? by + 0.5 + f[1] * 0.5 : bz + 0.5 + f[2] * 0.5;
            double eye = f[0] != 0 ? ex : f[1] != 0 ? ey : ez;
            int sign = f[0] + f[1] + f[2];
            if ((eye - plane) * sign <= 0) continue; // the face looks away from the eye
            int nx = bx + f[0], ny = by + f[1], nz = bz + f[2];
            if (opaque.at(nx, ny, nz)) continue; // covered
            // just outside the face centre, inside the open neighbour
            double tx = bx + 0.5 + f[0] * 0.51, ty = by + 0.5 + f[1] * 0.51, tz = bz + 0.5 + f[2] * 0.51;
            if (clear(ex, ey, ez, tx, ty, tz, opaque)) return true;
        }
        return false;
    }

    /**
     * Whether the segment crosses no opaque voxel between the eye's voxel (not checked: the camera
     * can be inside a block) and the end point's voxel (Amanatides-Woo voxel walk).
     */
    static boolean clear(double x0, double y0, double z0, double x1, double y1, double z1, Opaque opaque) {
        int x = (int) Math.floor(x0), y = (int) Math.floor(y0), z = (int) Math.floor(z0);
        int endX = (int) Math.floor(x1), endY = (int) Math.floor(y1), endZ = (int) Math.floor(z1);
        double dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
        int sx = (int) Math.signum(dx), sy = (int) Math.signum(dy), sz = (int) Math.signum(dz);
        double tMaxX = tMax(x0, x, dx), tMaxY = tMax(y0, y, dy), tMaxZ = tMax(z0, z, dz);
        double tDeltaX = dx == 0 ? Double.POSITIVE_INFINITY : 1 / Math.abs(dx);
        double tDeltaY = dy == 0 ? Double.POSITIVE_INFINITY : 1 / Math.abs(dy);
        double tDeltaZ = dz == 0 ? Double.POSITIVE_INFINITY : 1 / Math.abs(dz);
        for (int steps = 0; steps < MAX_STEPS; steps++) {
            if (x == endX && y == endY && z == endZ) return true;
            if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
                if (tMaxX > 1) return true; // past the end without leaving the voxel (rounding)
                x += sx;
                tMaxX += tDeltaX;
            } else if (tMaxY <= tMaxZ) {
                if (tMaxY > 1) return true;
                y += sy;
                tMaxY += tDeltaY;
            } else {
                if (tMaxZ > 1) return true;
                z += sz;
                tMaxZ += tDeltaZ;
            }
            if (x == endX && y == endY && z == endZ) return true;
            if (opaque.at(x, y, z)) return false;
        }
        return false;
    }

    /** Line parameter (0..1) at which the walk crosses the first voxel boundary on one axis. */
    private static double tMax(double start, int cell, double delta) {
        if (delta > 0) return (cell + 1 - start) / delta;
        if (delta < 0) return (start - cell) / -delta;
        return Double.POSITIVE_INFINITY;
    }
}
