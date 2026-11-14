package dev.miyoria.bridge.game;

import dev.miyoria.bridge.model.Models.BlockInfo;
import dev.miyoria.bridge.util.Ids;
import dev.miyoria.bridge.util.Visibility;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
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

    /** Treats leaves as opaque too so chests, ores, and mid-crown logs cannot hide behind foliage. */
    public static Visibility.Opaque opaqueSolid(ClientWorld w) {
        BlockPos.Mutable m = new BlockPos.Mutable();
        return (x, y, z) -> {
            m.set(x, y, z);
            BlockState st = w.getBlockState(m);
            return st.isOpaqueFullCube(w, m) || st.isIn(BlockTags.LEAVES);
        };
    }

    public static boolean visible(ClientWorld w, Vec3d eye, BlockPos pos) {
        return Visibility.visible(eye.x, eye.y, eye.z, pos.getX(), pos.getY(), pos.getZ(), opaque(w));
    }

    public static boolean visibleSolid(ClientWorld w, Vec3d eye, BlockPos pos) {
        return Visibility.visible(eye.x, eye.y, eye.z, pos.getX(), pos.getY(), pos.getZ(), opaqueSolid(w));
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
     * can see, or null. Non-leaf targets require clear sight through leaves as well as solid blocks.
     */
    public static BlockInfo nearestVisible(ClientPlayerEntity p, ClientWorld w, Set<Block> kinds, int radius) {
        boolean leafTarget = kinds.stream().anyMatch(b -> b.getDefaultState().isIn(BlockTags.LEAVES));
        return nearestVisible(p, w, kinds, radius, !leafTarget);
    }

    public static BlockInfo nearestVisible(ClientPlayerEntity p, ClientWorld w, Set<Block> kinds, int radius, boolean solidLeaves) {
        if (kinds.isEmpty()) return null;
        int ry = Math.min(radius, 12);
        BlockPos c = p.getBlockPos();
        Vec3d eye = p.getEyePos();
        Visibility.Opaque opaque = solidLeaves ? opaqueSolid(w) : opaque(w);
        BlockPos.Mutable m = new BlockPos.Mutable();
        List<BlockInfo> found = new ArrayList<>();
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

    /**
     * Finds the nearest visible log in {@code logKinds} (not occluded by leaves); if every nearby tree
     * is obscured by foliage, returns the nearest visible {@code BlockTags.LEAVES} block instead so
     * callers can clear leaves rather than stalling on a hidden mid-crown log.
     */
    public static BlockInfo nearestVisibleTreeOrLeaves(ClientPlayerEntity p, ClientWorld w, Set<Block> logKinds, int radius) {
        BlockInfo log = nearestVisible(p, w, logKinds, radius, true);
        if (log != null) return log;
        return nearestVisibleTag(p, w, BlockTags.LEAVES, radius, false);
    }

    /** Returns up to {@code limit} nearest genuinely visible leaf blocks within {@code radius}. */
    public static List<BlockInfo> visibleLeaves(ClientPlayerEntity p, ClientWorld w, int radius, int limit) {
        int ry = Math.min(radius, 6);
        BlockPos c = p.getBlockPos();
        Vec3d eye = p.getEyePos();
        Visibility.Opaque opaque = opaque(w);
        BlockPos.Mutable m = new BlockPos.Mutable();
        List<BlockInfo> candidates = new ArrayList<>();
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                for (int dy = -1; dy <= ry; dy++) {
                    m.set(c.getX() + dx, c.getY() + dy, c.getZ() + dz);
                    BlockState st = w.getBlockState(m);
                    if (!st.isIn(BlockTags.LEAVES)) continue;
                    if (!Visibility.exposed(m.getX(), m.getY(), m.getZ(), opaque)) continue;
                    double dist = eye.distanceTo(Vec3d.ofCenter(m));
                    String id = Ids.normalize(Registries.BLOCK.getId(st.getBlock()).toString());
                    candidates.add(new BlockInfo(id, m.getX(), m.getY(), m.getZ(), dist));
                }
            }
        }
        candidates.sort(Comparator.comparingDouble(BlockInfo::distance));
        List<BlockInfo> out = new ArrayList<>();
        int maxChecks = Math.min(MAX_CHECKS, candidates.size());
        for (int i = 0; i < maxChecks && out.size() < limit; i++) {
            BlockInfo b = candidates.get(i);
            if (Visibility.visible(eye.x, eye.y, eye.z, b.x(), b.y(), b.z(), opaque)) out.add(b);
        }
        return out;
    }

    private static BlockInfo nearestVisibleTag(
            ClientPlayerEntity p, ClientWorld w, net.minecraft.registry.tag.TagKey<Block> tag, int radius, boolean solidLeaves) {
        int ry = Math.min(radius, 12);
        BlockPos c = p.getBlockPos();
        Vec3d eye = p.getEyePos();
        Visibility.Opaque opaque = solidLeaves ? opaqueSolid(w) : opaque(w);
        BlockPos.Mutable m = new BlockPos.Mutable();
        List<BlockInfo> found = new ArrayList<>();
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                for (int dy = -ry; dy <= ry; dy++) {
                    m.set(c.getX() + dx, c.getY() + dy, c.getZ() + dz);
                    BlockState st = w.getBlockState(m);
                    if (!st.isIn(tag)) continue;
                    if (!Visibility.exposed(m.getX(), m.getY(), m.getZ(), opaque)) continue;
                    double dist = eye.distanceTo(Vec3d.ofCenter(m));
                    String id = Ids.normalize(Registries.BLOCK.getId(st.getBlock()).toString());
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
