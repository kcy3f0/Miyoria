package dev.miyoria.bridge.game;

import dev.miyoria.bridge.model.Models.BlockInfo;
import dev.miyoria.bridge.util.Ids;
import dev.miyoria.bridge.util.Visibility;
import net.minecraft.block.Block;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.registry.Registries;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Which blocks she can actually see from where she stands (see {@link Visibility}). Everything that
 * picks a block target goes through here instead of Baritone's chunk cache, which knows every ore
 * behind every wall. Client thread only.
 */
public final class BlockSight {
    private BlockSight() {}

    /** Most candidates line-of-sight checked per search (nearest first). */
    private static final int MAX_CHECKS = 96;

    public static Visibility.Opaque opaque(ClientWorld w) {
        BlockPos.Mutable m = new BlockPos.Mutable();
        return (x, y, z) -> {
            m.set(x, y, z);
            return w.getBlockState(m).isOpaqueFullCube(w, m);
        };
    }

    public static boolean visible(ClientWorld w, Vec3d eye, BlockPos pos) {
        return Visibility.visible(eye.x, eye.y, eye.z, pos.getX(), pos.getY(), pos.getZ(), opaque(w));
    }

    /** Blocks for the given ids ({@code minecraft:} optional); unknown ids are skipped. */
    public static Set<Block> blocks(Collection<String> ids) {
        return ids.stream()
                .map(id -> Identifier.tryParse(Ids.qualify(id)))
                .filter(id -> id != null && Registries.BLOCK.containsId(id))
                .map(Registries.BLOCK::get)
                .collect(Collectors.toSet());
    }

    /**
     * The nearest block of one of {@code kinds} within {@code radius} (vertical at most 12) that she
     * can see, or null. Distance is from the eye to the block centre.
     */
    public static BlockInfo nearestVisible(ClientPlayerEntity p, ClientWorld w, Set<Block> kinds, int radius) {
        if (kinds.isEmpty()) return null;
        int ry = Math.min(radius, 12);
        BlockPos c = p.getBlockPos();
        Vec3d eye = p.getEyePos();
        Visibility.Opaque opaque = opaque(w);
        BlockPos.Mutable m = new BlockPos.Mutable();
        java.util.List<BlockInfo> found = new ArrayList<>();
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                for (int dy = -ry; dy <= ry; dy++) {
                    m.set(c.getX() + dx, c.getY() + dy, c.getZ() + dz);
                    Block b = w.getBlockState(m).getBlock();
                    if (!kinds.contains(b)) continue;
                    if (!Visibility.exposed(m.getX(), m.getY(), m.getZ(), opaque)) continue;
                    double dist = eye.distanceTo(Vec3d.ofCenter(m));
                    String id = Ids.normalize(Registries.BLOCK.getId(b).toString());
                    found.add(new BlockInfo(id, m.getX(), m.getY(), m.getZ(), dist));
                }
            }
        }
        found.sort(Comparator.comparingDouble(BlockInfo::distance));
        for (int i = 0; i < Math.min(MAX_CHECKS, found.size()); i++) {
            BlockInfo b = found.get(i);
            if (Visibility.visible(eye.x, eye.y, eye.z, b.x(), b.y(), b.z(), opaque)) return b;
        }
        return null;
    }
}
