package dev.miyoria.bridge.game;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.util.Ids;
import dev.miyoria.bridge.util.LookMath;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.EquipmentSlot;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ArmorItem;
import net.minecraft.item.AxeItem;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.item.SwordItem;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

/**
 * Low-level player actions (look / use / attack / hotbar / place / chat / respawn) plus the
 * per-tick state they need (smooth camera, timed key holds). Client thread only.
 */
public final class GameActions {
    /** Max camera speed in degrees per tick when smoothing (20 ticks/s => ~600 deg/s is a quick flick). */
    private static final float SMOOTH_DEG_PER_TICK = 24f;
    private static final int MAX_HOLD_TICKS = 20 * 60;
    private static final int MAX_CHAT_LENGTH = 256;

    private Float targetYaw;
    private Float targetPitch;
    private final Map<KeyBinding, Integer> holds = new LinkedHashMap<>();

    // ------------------------------------------------------------------ per tick

    public void tick(MinecraftClient mc) {
        ClientPlayerEntity p = mc.player;
        if (p == null) {
            targetYaw = targetPitch = null;
            holds.clear();
            return;
        }
        if (targetYaw != null && targetPitch != null) {
            float yaw = LookMath.approachAngle(p.getYaw(), targetYaw, SMOOTH_DEG_PER_TICK);
            float pitch = LookMath.approachAngle(p.getPitch(), targetPitch, SMOOTH_DEG_PER_TICK);
            p.setYaw(yaw);
            p.setPitch(LookMath.clampPitch(pitch));
            if (yaw == targetYaw && pitch == targetPitch) {
                targetYaw = targetPitch = null;
            }
        }
        var it = holds.entrySet().iterator();
        while (it.hasNext()) {
            var en = it.next();
            int left = en.getValue() - 1;
            if (left <= 0) {
                en.getKey().setPressed(false);
                it.remove();
            } else {
                en.getKey().setPressed(true); // re-assert: focus changes can reset pressed states
                en.setValue(left);
            }
        }
    }

    /** A timed key hold ({@code use} / {@code attack} with {@code hold_ticks}) is running. */
    public boolean holding() {
        return !holds.isEmpty();
    }

    public void releaseAll() {
        targetYaw = targetPitch = null;
        for (KeyBinding k : holds.keySet()) k.setPressed(false);
        holds.clear();
    }

    /** Releases all movement, sneak, sprint, jump, attack, and use keybindings held by workers. */
    public void releaseMovement(MinecraftClient mc) {
        releaseAll();
        if (mc == null || mc.options == null) return;
        mc.options.forwardKey.setPressed(false);
        mc.options.backKey.setPressed(false);
        mc.options.leftKey.setPressed(false);
        mc.options.rightKey.setPressed(false);
        mc.options.jumpKey.setPressed(false);
        mc.options.sneakKey.setPressed(false);
        mc.options.sprintKey.setPressed(false);
        mc.options.attackKey.setPressed(false);
        mc.options.useKey.setPressed(false);
    }

    /** Checks the step column 1 block ahead toward {@code to} for lava, fire, magma, or >3-block drop. */
    public static boolean isStepSafe(ClientPlayerEntity p, ClientWorld w, Vec3d to) {
        double dx = to.x - p.getX();
        double dz = to.z - p.getZ();
        double len = Math.hypot(dx, dz);
        if (len < 1e-4) return true;
        int sx = (int) Math.round(dx / len);
        int sz = (int) Math.round(dz / len);
        BlockPos ahead = p.getBlockPos().add(sx, 0, sz);
        for (int dy = 1; dy >= -2; dy--) {
            BlockState st = w.getBlockState(ahead.up(dy));
            if (st.getFluidState().isIn(FluidTags.LAVA) || st.isOf(Blocks.LAVA)
                    || st.isIn(BlockTags.FIRE) || st.isOf(Blocks.MAGMA_BLOCK)) {
                return false;
            }
        }
        for (int d = 1; d <= 3; d++) {
            BlockPos below = ahead.down(d);
            BlockState st = w.getBlockState(below);
            if (st.isSideSolidFullSquare(w, below, Direction.UP) && !st.isOf(Blocks.MAGMA_BLOCK)) {
                return true;
            }
        }
        return !w.getBlockState(ahead).getCollisionShape(w, ahead).isEmpty(); // 1-block step up is solid
    }

    /** Turns toward {@code to} and holds forward (+ jump when blocked or ascending). */
    public void steerToward(MinecraftClient mc, ClientPlayerEntity p, Vec3d to, boolean sprint) {
        Vec3d eye = p.getEyePos();
        LookMath.Rotation r = LookMath.toward(to.x - eye.x, 0, to.z - eye.z);
        p.setYaw(LookMath.approachAngle(p.getYaw(), r.yaw(), SMOOTH_DEG_PER_TICK));
        mc.options.forwardKey.setPressed(true);
        mc.options.sprintKey.setPressed(sprint);
        mc.options.jumpKey.setPressed(p.horizontalCollision || to.y > p.getY() + 0.5);
    }

    public static JsonObject posJson(BlockPos pos) {
        JsonObject o = new JsonObject();
        o.addProperty("x", pos.getX());
        o.addProperty("y", pos.getY());
        o.addProperty("z", pos.getZ());
        return o;
    }

    /** Aims at {@code target} and drives one block-breaking tick; returns true once broken. */
    public boolean breakBlockTick(MinecraftClient mc, ClientPlayerEntity p, BlockPos target, boolean firstTick) {
        if (mc.world == null || mc.interactionManager == null) return false;
        BlockState st = mc.world.getBlockState(target);
        if (st.isAir() || st.getCollisionShape(mc.world, target).isEmpty() && !st.getFluidState().isEmpty()) {
            return true;
        }
        Vec3d center = Vec3d.ofCenter(target);
        lookAt(p, center, true);
        Direction face = Direction.getFacing(p.getEyePos().subtract(center));
        if (firstTick) {
            mc.interactionManager.attackBlock(target, face);
        } else {
            mc.interactionManager.updateBlockBreakingProgress(target, face);
        }
        p.swingHand(Hand.MAIN_HAND);
        return mc.world.getBlockState(target).isAir();
    }

    public void stopBreaking(MinecraftClient mc) {
        if (mc != null && mc.interactionManager != null) {
            mc.interactionManager.cancelBlockBreaking();
        }
    }

    /** Selects a matching stack into the player's held hotbar slot, swapping from storage if needed. */
    public boolean selectOrSwapItem(MinecraftClient mc, Predicate<ItemStack> pred) {
        ClientPlayerEntity p = mc.player;
        if (p == null) return false;
        PlayerInventory inv = p.getInventory();
        for (int i = 0; i < 9; i++) {
            if (pred.test(inv.main.get(i))) {
                inv.selectedSlot = i;
                return true;
            }
        }
        if (mc.currentScreen != null || mc.interactionManager == null) return false;
        for (int i = 9; i < inv.main.size(); i++) {
            if (pred.test(inv.main.get(i))) {
                int targetHotbar = inv.selectedSlot;
                for (int h = 0; h < 9; h++) {
                    if (inv.main.get(h).isEmpty()) {
                        targetHotbar = h;
                        break;
                    }
                }
                inv.selectedSlot = targetHotbar;
                mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, i, targetHotbar, SlotActionType.SWAP, p);
                return true;
            }
        }
        return false;
    }

    /** Selects the best mining tool for {@code state} across hotbar and storage. Returns false if none helps. */
    public boolean selectBestToolFor(MinecraftClient mc, BlockState state) {
        ClientPlayerEntity p = mc.player;
        if (p == null || state == null) return false;
        PlayerInventory inv = p.getInventory();
        int bestSlot = -1;
        boolean bestSuitable = false;
        float bestSpeed = 1.0f;
        for (int i = 0; i < inv.main.size(); i++) {
            ItemStack st = inv.main.get(i);
            if (st.isEmpty()) continue;
            if (st.isDamageable() && st.getDamage() >= st.getMaxDamage()) continue;
            boolean suitable = !state.isToolRequired() || st.isSuitableFor(state);
            float speed = st.getMiningSpeedMultiplier(state);
            if (!suitable && state.isToolRequired()) continue;
            if (speed <= 1.0f && !st.isSuitableFor(state)) continue;
            if (bestSlot < 0
                    || (suitable && !bestSuitable)
                    || (suitable == bestSuitable && speed > bestSpeed)) {
                bestSlot = i;
                bestSuitable = suitable;
                bestSpeed = speed;
            }
        }
        if (bestSlot < 0) return false;
        if (bestSlot < 9) {
            inv.selectedSlot = bestSlot;
            return true;
        }
        if (mc.currentScreen != null || mc.interactionManager == null) return false;
        int targetHotbar = inv.selectedSlot;
        for (int h = 0; h < 9; h++) {
            if (inv.main.get(h).isEmpty()) {
                targetHotbar = h;
                break;
            }
        }
        inv.selectedSlot = targetHotbar;
        mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, bestSlot, targetHotbar, SlotActionType.SWAP, p);
        return true;
    }

    /** Selects the strongest sword or axe in the player's inventory into her hand. */
    public boolean selectBestMelee(MinecraftClient mc) {
        ClientPlayerEntity p = mc.player;
        if (p == null) return false;
        PlayerInventory inv = p.getInventory();
        int bestSlot = -1;
        float bestScore = 0f;
        for (int i = 0; i < inv.main.size(); i++) {
            ItemStack st = inv.main.get(i);
            Item it = st.getItem();
            float score = it instanceof SwordItem s ? 10f + s.getMaterial().getAttackDamage()
                    : it instanceof AxeItem a ? a.getMaterial().getAttackDamage()
                    : 0f;
            if (score > bestScore) {
                bestScore = score;
                bestSlot = i;
            }
        }
        if (bestSlot < 0) return false;
        if (bestSlot < 9) {
            inv.selectedSlot = bestSlot;
            return true;
        }
        if (mc.currentScreen != null || mc.interactionManager == null) return false;
        int targetHotbar = inv.selectedSlot;
        for (int h = 0; h < 9; h++) {
            if (inv.main.get(h).isEmpty()) {
                targetHotbar = h;
                break;
            }
        }
        inv.selectedSlot = targetHotbar;
        mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, bestSlot, targetHotbar, SlotActionType.SWAP, p);
        return true;
    }

    // ------------------------------------------------------------------ actions

    public JsonObject look(MinecraftClient mc, Request req) throws ProtocolException {
        ClientPlayerEntity p = mc.player;
        float yaw;
        float pitch;
        var at = req.optObj("at");
        if (at != null) {
            double x = numOf(at, "x"), y = numOf(at, "y"), z = numOf(at, "z");
            Vec3d eye = p.getEyePos();
            LookMath.Rotation r = LookMath.toward(x - eye.x, y - eye.y, z - eye.z);
            yaw = r.yaw();
            pitch = r.pitch();
        } else if (req.has("yaw") || req.has("pitch")) {
            yaw = req.has("yaw") ? LookMath.wrapDegrees((float) req.num("yaw")) : p.getYaw();
            pitch = req.has("pitch") ? LookMath.clampPitch((float) req.num("pitch")) : p.getPitch();
        } else {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "look needs {yaw,pitch} or {at:{x,y,z}}");
        }
        boolean smooth = req.optBool("smooth", true);
        turn(p, yaw, pitch, smooth);
        JsonObject out = new JsonObject();
        out.addProperty("yaw", Math.round(yaw * 10f) / 10.0);
        out.addProperty("pitch", Math.round(pitch * 10f) / 10.0);
        out.addProperty("smooth", smooth);
        return out;
    }

    /** Turns the camera toward a world point (used by crafting and placing, which face what they touch). */
    public void lookAt(ClientPlayerEntity p, Vec3d at, boolean smooth) {
        Vec3d eye = p.getEyePos();
        LookMath.Rotation r = LookMath.toward(at.x - eye.x, at.y - eye.y, at.z - eye.z);
        turn(p, r.yaw(), r.pitch(), smooth);
    }

    private void turn(ClientPlayerEntity p, float yaw, float pitch, boolean smooth) {
        if (smooth) {
            targetYaw = yaw;
            targetPitch = pitch;
        } else {
            targetYaw = targetPitch = null;
            p.setYaw(yaw);
            p.setPitch(pitch);
        }
    }

    private static double numOf(com.google.gson.JsonObject o, String key) throws ProtocolException {
        var e = o.get(key);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "\"at." + key + "\" must be a number");
        }
        return e.getAsDouble();
    }

    /** Right click (use item / place block / interact). {@code hold_ticks} > 0 holds the button (eating, bows). */
    public JsonObject use(MinecraftClient mc, Request req) throws ProtocolException {
        return press(mc.options.useKey, req, "use");
    }

    /** Left click (attack / start breaking). {@code hold_ticks} > 0 holds it (mining a block). */
    public JsonObject attack(MinecraftClient mc, Request req) throws ProtocolException {
        return press(mc.options.attackKey, req, "attack");
    }

    private JsonObject press(KeyBinding key, Request req, String what) throws ProtocolException {
        int hold = Math.max(0, Math.min(MAX_HOLD_TICKS, req.optInt("hold_ticks", 0)));
        if (hold > 0) {
            key.setPressed(true);
            holds.put(key, hold);
        } else {
            // a single click, exactly like a physical key press this tick
            KeyBinding.onKeyPressed(InputUtil.fromTranslationKey(key.getBoundKeyTranslationKey()));
        }
        JsonObject out = new JsonObject();
        out.addProperty("action", what);
        out.addProperty("hold_ticks", hold);
        return out;
    }

    /** {@code {"slot":0-8}} or {@code {"item":"diamond_pickaxe"}} (first hotbar slot holding it). */
    public JsonObject selectSlot(MinecraftClient mc, Request req) throws ProtocolException {
        PlayerInventory inv = mc.player.getInventory();
        int slot;
        if (req.has("slot")) {
            slot = req.optInt("slot", -1);
            if (slot < 0 || slot > 8) throw new ProtocolException(Protocol.E_INVALID_ARGS, "slot must be 0-8");
        } else if (req.has("item")) {
            String want = Ids.qualify(req.str("item").toLowerCase());
            slot = -1;
            for (int i = 0; i < 9; i++) {
                ItemStack s = inv.main.get(i);
                if (!s.isEmpty() && Registries.ITEM.getId(s.getItem()).toString().equals(want)) {
                    slot = i;
                    break;
                }
            }
            if (slot < 0) throw new ProtocolException(Protocol.E_INVALID_ARGS, "no \"" + req.str("item") + "\" in the hotbar");
        } else {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "select_slot needs \"slot\" (0-8) or \"item\"");
        }
        inv.selectedSlot = slot;
        JsonObject out = new JsonObject();
        out.addProperty("slot", slot);
        ItemStack held = inv.getStack(slot);
        out.addProperty("item", held.isEmpty() ? null : Ids.normalize(Registries.ITEM.getId(held.getItem()).toString()));
        return out;
    }

    /**
     * {@code {"item":"crafting_table"}}: puts that block down on the ground next to her, the
     * direction she faces first. From the storage part of the inventory it is first swapped into
     * the selected hotbar slot (a hotbar-swap click, as a player would do).
     */
    public JsonObject place(MinecraftClient mc, Request req) throws ProtocolException {
        ClientPlayerEntity p = mc.player;
        Item item = Workbench.item(req.str("item"));
        if (!(item instanceof BlockItem)) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, Workbench.id(item) + " is not a block that can be placed");
        }
        if (mc.currentScreen != null) throw new ProtocolException(Protocol.E_INVALID_ARGS, "a screen is open; close it first");
        PlayerInventory inv = p.getInventory();
        int slot = -1;
        for (int i = 0; i < inv.main.size(); i++) {
            if (inv.main.get(i).isOf(item)) {
                slot = i;
                break;
            }
        }
        if (slot < 0) throw new ProtocolException(Protocol.E_MISSING_ITEMS, "missing " + Workbench.id(item) + " x1");
        BlockPos spot = placeSpot(p, mc.world);
        if (spot == null) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "no free spot with solid ground right next to her");
        }
        if (slot < 9) {
            inv.selectedSlot = slot;
        } else {
            // player screen handler slots 9-35 are inventory slots 9-35; SWAP's button is the hotbar slot
            mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, slot, inv.selectedSlot, SlotActionType.SWAP, p);
        }
        Vec3d top = new Vec3d(spot.getX() + 0.5, spot.getY(), spot.getZ() + 0.5);
        lookAt(p, top, true);
        ActionResult r = mc.interactionManager.interactBlock(p, Hand.MAIN_HAND, new BlockHitResult(top, Direction.UP, spot.down(), false));
        if (!r.isAccepted()) throw new ProtocolException(Protocol.E_INVALID_ARGS, "the game refused to place it there");
        p.swingHand(Hand.MAIN_HAND);
        JsonObject out = new JsonObject();
        out.addProperty("item", Workbench.id(item));
        JsonObject at = new JsonObject();
        at.addProperty("x", spot.getX());
        at.addProperty("y", spot.getY());
        at.addProperty("z", spot.getZ());
        out.add("position", at);
        return out;
    }

    /**
     * An empty space beside her feet with a plain solid block under it (not one that opens a
     * screen when clicked, or the click would open it instead of placing).
     */
    private static BlockPos placeSpot(ClientPlayerEntity p, ClientWorld w) {
        Direction facing = p.getHorizontalFacing();
        Direction[] order = {facing, facing.rotateYClockwise(), facing.rotateYCounterclockwise(), facing.getOpposite()};
        BlockPos feet = p.getBlockPos();
        for (int reach = 1; reach <= 2; reach++) {
            for (Direction d : order) {
                BlockPos spot = feet.offset(d, reach);
                BlockPos below = spot.down();
                BlockState under = w.getBlockState(below);
                if (!w.getBlockState(spot).isReplaceable()) continue;
                if (!under.isSolidBlock(w, below) || under.createScreenHandlerFactory(w, below) != null) continue;
                if (p.getBoundingBox().intersects(new Box(spot))) continue;
                return spot;
            }
        }
        return null;
    }

    /** Chat message, or a slash command when it starts with "/". */
    public JsonObject chat(MinecraftClient mc, Request req) throws ProtocolException {
        String msg = req.str("message").strip();
        if (msg.isEmpty() || msg.length() > MAX_CHAT_LENGTH) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "message must be 1-" + MAX_CHAT_LENGTH + " chars");
        }
        ClientPlayNetworkHandler net = mc.getNetworkHandler();
        if (net == null) throw new ProtocolException(Protocol.E_NOT_IN_GAME, "not connected");
        if (msg.startsWith("/")) {
            net.sendChatCommand(msg.substring(1));
        } else {
            net.sendChatMessage(msg);
        }
        JsonObject out = new JsonObject();
        out.addProperty("sent", msg);
        return out;
    }

    /** Manages armor/shield/hotbar upgrades ({@code equip_best}) or drops trash / stacks duplicates ({@code tidy}). */
    public JsonObject manageInv(MinecraftClient mc, Request req) throws ProtocolException {
        ClientPlayerEntity p = mc.player;
        if (p == null || p.isDead()) throw new ProtocolException(Protocol.E_INVALID_ARGS, "she is dead");
        if (mc.currentScreen != null) throw new ProtocolException(Protocol.E_INVALID_ARGS, "a screen is open; close it first");
        if (mc.interactionManager == null) throw new ProtocolException(Protocol.E_NOT_IN_GAME, "not connected");
        String op = req.str("op");
        JsonObject out = new JsonObject();
        out.addProperty("op", op);
        if ("equip_best".equals(op)) {
            JsonArray equipped = new JsonArray();
            EquipmentSlot[] armorOrder = {EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET};
            for (EquipmentSlot eq : armorOrder) {
                ItemStack current = p.getInventory().getArmorStack(eq.getEntitySlotId());
                int curScore = armorScore(current);
                int bestInv = -1;
                int bestScore = curScore;
                for (int i = 0; i < p.getInventory().main.size(); i++) {
                    ItemStack st = p.getInventory().main.get(i);
                    if (st.getItem() instanceof ArmorItem a && a.getSlotType() == eq) {
                        int s = armorScore(st);
                        if (s > bestScore) {
                            bestScore = s;
                            bestInv = i;
                        }
                    }
                }
                if (bestInv >= 0) {
                    int handlerSrc = bestInv < 9 ? 36 + bestInv : bestInv;
                    int armorSlot = 8 - eq.getEntitySlotId();
                    boolean wasOccupied = !current.isEmpty();
                    mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, handlerSrc, 0, SlotActionType.PICKUP, p);
                    mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, armorSlot, 0, SlotActionType.PICKUP, p);
                    if (wasOccupied) {
                        mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, handlerSrc, 0, SlotActionType.PICKUP, p);
                    }
                    equipped.add(Ids.normalize(Registries.ITEM.getId(p.getInventory().getArmorStack(eq.getEntitySlotId()).getItem()).toString()));
                }
            }
            if (p.getOffHandStack().isEmpty()) {
                for (int i = 0; i < p.getInventory().main.size(); i++) {
                    if (p.getInventory().main.get(i).isOf(Items.SHIELD)) {
                        int handlerSrc = i < 9 ? 36 + i : i;
                        mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, handlerSrc, 0, SlotActionType.PICKUP, p);
                        mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, 45, 0, SlotActionType.PICKUP, p);
                        equipped.add("shield");
                        break;
                    }
                }
            }
            selectBestMelee(mc);
            out.add("equipped", equipped);
            return out;
        }
        if ("tidy".equals(op)) {
            Set<String> trash = new HashSet<>();
            if (req.has("trash")) {
                if (!req.body().get("trash").isJsonArray()) {
                    throw new ProtocolException(Protocol.E_INVALID_ARGS, "'trash' must be an array of item ids");
                }
                for (JsonElement el : req.body().getAsJsonArray("trash")) {
                    if (el.isJsonPrimitive()) trash.add(Ids.normalize(el.getAsString()));
                }
            }
            JsonArray dropped = new JsonArray();
            if (!trash.isEmpty()) {
                for (int i = 0; i < p.getInventory().main.size(); i++) {
                    ItemStack st = p.getInventory().main.get(i);
                    if (st.isEmpty()) continue;
                    String id = Ids.normalize(Registries.ITEM.getId(st.getItem()).toString());
                    if (trash.contains(id)) {
                        int handlerSlot = i < 9 ? 36 + i : i;
                        mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, handlerSlot, 1, SlotActionType.THROW, p);
                        dropped.add(id);
                    }
                }
            }
            int merged = consolidateStacks(mc, p);
            out.add("dropped", dropped);
            out.addProperty("merged_stacks", merged);
            return out;
        }
        throw new ProtocolException(Protocol.E_INVALID_ARGS, "manage_inv op must be 'equip_best' or 'tidy'");
    }

    private static int armorScore(ItemStack st) {
        if (st.isEmpty() || !(st.getItem() instanceof ArmorItem a)) return 0;
        return a.getProtection() * 10 + Math.round(a.getToughness() * 4f);
    }

    private static int consolidateStacks(MinecraftClient mc, ClientPlayerEntity p) {
        int merged = 0;
        for (int src = 9; src <= 44; src++) {
            ItemStack s = p.playerScreenHandler.getSlot(src).getStack();
            if (s.isEmpty() || !s.isStackable() || s.getCount() >= s.getMaxCount()) continue;
            for (int dst = 9; dst < src; dst++) {
                ItemStack d = p.playerScreenHandler.getSlot(dst).getStack();
                if (!ItemStack.areItemsAndComponentsEqual(s, d) || d.getCount() >= d.getMaxCount()) continue;
                mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, src, 0, SlotActionType.PICKUP, p);
                mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, dst, 0, SlotActionType.PICKUP, p);
                if (!p.playerScreenHandler.getCursorStack().isEmpty()) {
                    mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, src, 0, SlotActionType.PICKUP, p);
                }
                merged++;
                if (p.playerScreenHandler.getSlot(src).getStack().isEmpty()) break;
            }
        }
        return merged;
    }

    public JsonObject respawn(MinecraftClient mc) {
        JsonObject out = new JsonObject();
        boolean dead = mc.player.isDead();
        if (dead) mc.player.requestRespawn();
        out.addProperty("respawned", dead);
        return out;
    }
}
