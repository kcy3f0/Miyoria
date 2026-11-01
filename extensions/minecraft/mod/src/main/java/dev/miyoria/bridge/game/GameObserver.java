package dev.miyoria.bridge.game;

import dev.miyoria.bridge.config.BridgeConfig;
import dev.miyoria.bridge.model.Models.BlockInfo;
import dev.miyoria.bridge.model.Models.EntityInfo;
import dev.miyoria.bridge.model.Models.StackInfo;
import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.model.RawObservation.LookTarget;
import dev.miyoria.bridge.model.RawObservation.StackSlot;
import dev.miyoria.bridge.util.Ids;
import dev.miyoria.bridge.util.NotableBlocks;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.decoration.ArmorStandEntity;
import net.minecraft.entity.mob.Monster;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/** Samples live game state into the Minecraft-free {@link RawObservation}. Client thread only. */
public final class GameObserver {
    private static final int MAX_SCANNED_BLOCKS = 6000;

    private final BridgeConfig cfg;
    /** Block -> normalized id when notable, "" when not (cache). */
    private final Map<Block, String> notableCache = new IdentityHashMap<>();

    public GameObserver(BridgeConfig cfg) {
        this.cfg = cfg;
    }

    /** Full snapshot input (includes a notable-block scan: ~30k block lookups). */
    public RawObservation observe(BaritoneBridge baritone, AltoClefBridge alto) {
        MinecraftClient mc = MinecraftClient.getInstance();
        ClientPlayerEntity p = mc.player;
        ClientWorld w = mc.world;
        RawObservation r = new RawObservation();

        r.health = p.getHealth();
        r.maxHealth = p.getMaxHealth();
        r.absorption = p.getAbsorptionAmount();
        r.food = p.getHungerManager().getFoodLevel();
        r.saturation = p.getHungerManager().getSaturationLevel();
        r.air = p.getAir();

        r.x = p.getX();
        r.y = p.getY();
        r.z = p.getZ();
        r.yaw = p.getYaw();
        r.pitch = p.getPitch();

        r.dimension = Ids.normalize(w.getRegistryKey().getValue().toString());
        r.biome = w.getBiome(p.getBlockPos()).getKey().map(k -> Ids.normalize(k.getValue().toString())).orElse("unknown");
        r.timeOfDay = w.getTimeOfDay();
        r.worldTime = w.getTime();
        r.raining = w.isRaining();
        r.thundering = w.isThundering();

        fillInventory(p, r);
        r.lookingAt = lookingAt(mc, p);
        r.entities = nearbyEntities(p, w, cfg.entityRadius);
        r.notableBlocks = scanNotableBlocks(p, w);

        if (baritone != null) {
            try {
                r.baritone = baritone.state();
            } catch (Throwable t) {
                r.baritone = RawObservation.BaritoneState.UNAVAILABLE;
            }
        }
        if (alto != null) r.altoclef = alto.state();
        return r;
    }

    public void fillInventory(ClientPlayerEntity p, RawObservation r) {
        PlayerInventory inv = p.getInventory();
        r.heldSlot = inv.selectedSlot;
        r.mainSlotCount = inv.main.size();
        List<StackSlot> slots = new ArrayList<>();
        for (int i = 0; i < inv.main.size(); i++) {
            StackInfo s = stack(inv.main.get(i));
            if (s != null) slots.add(new StackSlot(i, s));
        }
        r.mainSlots = slots;
        r.head = stack(inv.getArmorStack(3));
        r.chest = stack(inv.getArmorStack(2));
        r.legs = stack(inv.getArmorStack(1));
        r.feet = stack(inv.getArmorStack(0));
        r.offhand = stack(inv.offHand.isEmpty() ? ItemStack.EMPTY : inv.offHand.get(0));
    }

    private static StackInfo stack(ItemStack s) {
        if (s == null || s.isEmpty()) return null;
        String id = Ids.normalize(Registries.ITEM.getId(s.getItem()).toString());
        Integer dur = null;
        if (s.isDamageable() && s.getMaxDamage() > 0) {
            dur = (int) Math.round(100.0 * (s.getMaxDamage() - s.getDamage()) / s.getMaxDamage());
        }
        return new StackInfo(id, s.getCount(), dur);
    }

    private LookTarget lookingAt(MinecraftClient mc, ClientPlayerEntity p) {
        HitResult hit = mc.crosshairTarget;
        if (hit == null) return null;
        Vec3d eye = p.getEyePos();
        if (hit instanceof BlockHitResult bhr && hit.getType() == HitResult.Type.BLOCK) {
            BlockPos pos = bhr.getBlockPos();
            String id = Ids.normalize(Registries.BLOCK.getId(mc.world.getBlockState(pos).getBlock()).toString());
            return new LookTarget("block", id, null, pos.getX(), pos.getY(), pos.getZ(),
                    bhr.getSide().asString(), eye.distanceTo(hit.getPos()));
        }
        if (hit instanceof EntityHitResult ehr && hit.getType() == HitResult.Type.ENTITY) {
            Entity e = ehr.getEntity();
            BlockPos bp = e.getBlockPos();
            return new LookTarget("entity", entityTypeId(e), entityName(e), bp.getX(), bp.getY(), bp.getZ(),
                    null, eye.distanceTo(hit.getPos()));
        }
        return null;
    }

    /** Living entities within {@code radius}, excluding the player and armor stands. */
    public List<EntityInfo> nearbyEntities(ClientPlayerEntity p, ClientWorld w, double radius) {
        Box box = p.getBoundingBox().expand(radius);
        List<Entity> found = w.getOtherEntities(p, box, e -> e instanceof LivingEntity && !(e instanceof ArmorStandEntity));
        List<EntityInfo> out = new ArrayList<>(found.size());
        for (Entity e : found) {
            double d = e.distanceTo(p);
            if (d > radius) continue;
            out.add(new EntityInfo(entityTypeId(e), entityName(e), d, e instanceof Monster));
        }
        return out;
    }

    private static String entityTypeId(Entity e) {
        return Ids.normalize(Registries.ENTITY_TYPE.getId(e.getType()).toString());
    }

    /** Only players and custom-named entities get a name (the type id is already descriptive). */
    private static String entityName(Entity e) {
        if (e instanceof PlayerEntity pl) return pl.getName().getString();
        if (e.hasCustomName()) return e.getCustomName().getString();
        return null;
    }

    private List<BlockInfo> scanNotableBlocks(ClientPlayerEntity p, ClientWorld w) {
        int r = cfg.blockScanRadius;
        int ry = Math.min(r, 12);
        BlockPos c = p.getBlockPos();
        List<BlockInfo> out = new ArrayList<>();
        BlockPos.Mutable m = new BlockPos.Mutable();
        for (int dx = -r; dx <= r; dx++) {
            for (int dz = -r; dz <= r; dz++) {
                for (int dy = -ry; dy <= ry; dy++) {
                    m.set(c.getX() + dx, c.getY() + dy, c.getZ() + dz);
                    BlockState st = w.getBlockState(m);
                    if (st.isAir()) continue;
                    String id = notableId(st.getBlock());
                    if (id.isEmpty()) continue;
                    double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    out.add(new BlockInfo(id, m.getX(), m.getY(), m.getZ(), dist));
                    if (out.size() >= MAX_SCANNED_BLOCKS) return out;
                }
            }
        }
        return out;
    }

    private String notableId(Block b) {
        String cached = notableCache.get(b);
        if (cached != null) return cached;
        String id = Ids.normalize(Registries.BLOCK.getId(b).toString());
        String value = NotableBlocks.isNotable(id) ? id : "";
        notableCache.put(b, value);
        return value;
    }
}
