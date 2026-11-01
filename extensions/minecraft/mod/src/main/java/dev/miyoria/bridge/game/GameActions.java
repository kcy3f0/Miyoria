package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.util.Ids;
import dev.miyoria.bridge.util.LookMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.Vec3d;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Low-level player actions (look / use / attack / hotbar / chat / respawn) plus the per-tick
 * state they need (smooth camera, timed key holds). Client thread only.
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

    public void releaseAll() {
        targetYaw = targetPitch = null;
        for (KeyBinding k : holds.keySet()) k.setPressed(false);
        holds.clear();
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
        if (smooth) {
            targetYaw = yaw;
            targetPitch = pitch;
        } else {
            targetYaw = targetPitch = null;
            p.setYaw(yaw);
            p.setPitch(pitch);
        }
        JsonObject out = new JsonObject();
        out.addProperty("yaw", Math.round(yaw * 10f) / 10.0);
        out.addProperty("pitch", Math.round(pitch * 10f) / 10.0);
        out.addProperty("smooth", smooth);
        return out;
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

    public JsonObject respawn(MinecraftClient mc) {
        JsonObject out = new JsonObject();
        boolean dead = mc.player.isDead();
        if (dead) mc.player.requestRespawn();
        out.addProperty("respawned", dead);
        return out;
    }
}
