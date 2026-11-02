package dev.miyoria.bridge.game;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import baritone.api.event.events.PathEvent;
import baritone.api.event.listener.AbstractGameEventListener;
import baritone.api.pathing.goals.Goal;
import baritone.api.pathing.goals.GoalBlock;
import baritone.api.pathing.goals.GoalNear;
import baritone.api.pathing.goals.GoalXZ;
import baritone.api.process.IBaritoneProcess;
import baritone.api.utils.BlockOptionalMeta;
import baritone.api.utils.BlockOptionalMetaLookup;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.util.Ids;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.Entity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.BlockPos;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/** Drives Baritone strictly through its Java API (no chat messages involved). */
public final class BaritoneBridgeImpl implements BaritoneBridge {
    private static final Pattern BLOCK_ID = Pattern.compile("[a-z0-9_.:/-]+");
    private static final Pattern SCHEMATIC = Pattern.compile("[A-Za-z0-9_.-]+");
    private static final int IDLE_DEBOUNCE_TICKS = 10;

    private final EventSink events;
    private IBaritone baritone;
    private boolean listenerRegistered;

    private boolean wasBusy;
    private int idleTicks;
    private String lastProcess;
    private String lastGoal;
    private boolean cancelledByUs;

    public BaritoneBridgeImpl(EventSink events) {
        this.events = events;
    }

    private IBaritone b() {
        if (baritone == null) {
            baritone = BaritoneAPI.getProvider().getPrimaryBaritone();
        }
        return baritone;
    }

    // ------------------------------------------------------------------ commands

    @Override
    public JsonObject execute(Request req) throws ProtocolException {
        String command = req.str("command").toLowerCase();
        JsonObject out = new JsonObject();
        out.addProperty("command", command);
        cancelledByUs = false;
        switch (command) {
            case "goto" -> doGoto(req, out);
            case "mine" -> doMine(req, out);
            case "follow" -> doFollow(req, out);
            case "explore" -> doExplore(req, out);
            case "farm" -> doFarm(req, out);
            case "build" -> doBuild(req, out);
            case "stop", "cancel" -> {
                cancel();
                out.addProperty("stopped", true);
            }
            case "raw" -> {
                String line = req.str("line").trim();
                if (line.isEmpty() || line.length() > 200) {
                    throw new ProtocolException(Protocol.E_INVALID_ARGS, "\"line\" must be 1-200 chars");
                }
                out.addProperty("accepted", b().getCommandManager().execute(line));
            }
            default -> throw new ProtocolException(Protocol.E_INVALID_ARGS,
                    "unknown baritone command \"" + command + "\" (goto, mine, follow, explore, farm, build, stop, raw)");
        }
        return out;
    }

    private void doGoto(Request req, JsonObject out) throws ProtocolException {
        Goal goal;
        if (req.has("block")) {
            String block = blockName(req.str("block"));
            requireUnpaused();
            b().getGetToBlockProcess().getToBlock(new BlockOptionalMeta(block));
            out.addProperty("goal", "GetToBlock{" + block + "}");
            return;
        }
        if (req.has("x") && req.has("z")) {
            int x = (int) Math.floor(req.num("x"));
            int z = (int) Math.floor(req.num("z"));
            if (req.has("y")) {
                int y = (int) Math.floor(req.num("y"));
                int near = req.optInt("near", 0);
                goal = near > 0 ? new GoalNear(new BlockPos(x, y, z), near) : new GoalBlock(x, y, z);
            } else {
                goal = new GoalXZ(x, z);
            }
        } else {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "goto needs {x,y,z}, {x,z} or {block}");
        }
        b().getCustomGoalProcess().setGoalAndPath(goal);
        out.addProperty("goal", goal.toString());
    }

    /**
     * Baritone resolves a block's drops through the integrated server and waits for it on the
     * render thread. While single-player is paused the server never answers, and the whole game
     * hangs (the pause menu can no longer be closed). Refuse instead.
     */
    private static void requireUnpaused() throws ProtocolException {
        if (MinecraftClient.getInstance().isPaused()) {
            throw new ProtocolException(Protocol.E_GAME_PAUSED,
                    "the game is paused (single-player pause menu); it has to be resumed first");
        }
    }

    @Override
    public List<String> lookupTargets(Request req) {
        try {
            String command = req.str("command").toLowerCase();
            List<String> names = new ArrayList<>();
            if (("mine".equals(command) || "goto".equals(command)) && req.has("block")) {
                names.add(blockName(req.str("block")));
            }
            JsonElement arr = req.body().get("blocks");
            if ("mine".equals(command) && arr != null && arr.isJsonArray()) {
                for (JsonElement e : arr.getAsJsonArray()) {
                    if (e.isJsonPrimitive() && e.getAsJsonPrimitive().isString()) names.add(blockName(e.getAsString()));
                }
            }
            return names;
        } catch (ProtocolException e) {
            return List.of(); // the request itself reports the bad argument
        }
    }

    @Override
    public void prewarm(List<String> blocks) {
        if (!blocks.isEmpty()) new BlockOptionalMetaLookup(blocks.toArray(new String[0]));
    }

    private void doMine(Request req, JsonObject out) throws ProtocolException {
        List<String> names = new ArrayList<>();
        if (req.has("block")) names.add(blockName(req.str("block")));
        JsonElement arr = req.body().get("blocks");
        if (arr != null && !arr.isJsonNull()) {
            if (!arr.isJsonArray()) throw new ProtocolException(Protocol.E_INVALID_ARGS, "\"blocks\" must be an array of strings");
            for (JsonElement e : arr.getAsJsonArray()) {
                if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) {
                    throw new ProtocolException(Protocol.E_INVALID_ARGS, "\"blocks\" must be an array of strings");
                }
                names.add(blockName(e.getAsString()));
            }
        }
        if (names.isEmpty()) throw new ProtocolException(Protocol.E_INVALID_ARGS, "mine needs \"blocks\" (or \"block\")");
        int count = Math.max(0, req.optInt("count", 0)); // 0 = until stopped
        requireUnpaused();
        b().getMineProcess().mineByName(count, names.toArray(new String[0]));
        JsonArray echo = new JsonArray();
        names.forEach(echo::add);
        out.add("blocks", echo);
        out.addProperty("count", count);
    }

    private void doFollow(Request req, JsonObject out) throws ProtocolException {
        Predicate<Entity> filter;
        if (req.has("player")) {
            String name = req.str("player");
            filter = e -> e instanceof PlayerEntity p && p.getName().getString().equalsIgnoreCase(name)
                    && p != MinecraftClient.getInstance().player;
            out.addProperty("player", name);
        } else if (req.has("entity")) {
            String type = Ids.normalize(req.str("entity").toLowerCase());
            filter = e -> Ids.normalize(Registries.ENTITY_TYPE.getId(e.getType()).toString()).equals(type);
            out.addProperty("entity", type);
        } else {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "follow needs \"player\" or \"entity\"");
        }
        b().getFollowProcess().follow(filter);
    }

    private void doExplore(Request req, JsonObject out) throws ProtocolException {
        MinecraftClient mc = MinecraftClient.getInstance();
        int x = req.has("x") ? (int) Math.floor(req.num("x")) : (int) Math.floor(mc.player.getX());
        int z = req.has("z") ? (int) Math.floor(req.num("z")) : (int) Math.floor(mc.player.getZ());
        b().getExploreProcess().explore(x, z);
        out.addProperty("x", x);
        out.addProperty("z", z);
    }

    private void doFarm(Request req, JsonObject out) throws ProtocolException {
        int range = req.optInt("range", 0);
        if (range > 0) {
            b().getFarmProcess().farm(range, null);
        } else {
            b().getFarmProcess().farm();
        }
        out.addProperty("range", range);
    }

    private void doBuild(Request req, JsonObject out) throws ProtocolException {
        String name = req.str("schematic");
        if (!SCHEMATIC.matcher(name).matches()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "schematic must be a file name inside baritone/schematics (letters, digits, _ . -)");
        }
        StringBuilder line = new StringBuilder("build ").append(name);
        if (req.has("x") && req.has("y") && req.has("z")) {
            line.append(' ').append((int) Math.floor(req.num("x")))
                    .append(' ').append((int) Math.floor(req.num("y")))
                    .append(' ').append((int) Math.floor(req.num("z")));
        }
        boolean ok = b().getCommandManager().execute(line.toString());
        if (!ok) throw new ProtocolException(Protocol.E_INVALID_ARGS, "baritone rejected: " + line);
        out.addProperty("schematic", name);
    }

    private static String blockName(String raw) throws ProtocolException {
        String n = raw.trim().toLowerCase();
        if (!BLOCK_ID.matcher(n).matches()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "bad block id \"" + raw + "\"");
        }
        return n;
    }

    // ------------------------------------------------------------------ state + events

    @Override
    public void cancel() {
        cancelledByUs = true;
        b().getPathingBehavior().cancelEverything();
    }

    @Override
    public RawObservation.BaritoneState state() {
        IBaritone bar = b();
        boolean pathing = bar.getPathingBehavior().isPathing();
        Optional<IBaritoneProcess> p = bar.getPathingControlManager().mostRecentInControl();
        boolean active = p.map(IBaritoneProcess::isActive).orElse(false);
        boolean busy = pathing || active;
        String process = busy ? p.map(IBaritoneProcess::displayName).orElse(null) : null;
        Goal goal = bar.getPathingBehavior().getGoal();
        return new RawObservation.BaritoneState(true, busy, process, busy && goal != null ? goal.toString() : null);
    }

    @Override
    public void tick() {
        if (!listenerRegistered) {
            registerListener();
        }
        RawObservation.BaritoneState s = state();
        if (s.busy()) {
            wasBusy = true;
            idleTicks = 0;
            lastProcess = s.process();
            lastGoal = s.goal();
        } else if (wasBusy && ++idleTicks >= IDLE_DEBOUNCE_TICKS) {
            wasBusy = false;
            JsonObject d = new JsonObject();
            d.addProperty("process", lastProcess);
            d.addProperty("goal", lastGoal);
            d.addProperty("cancelled", cancelledByUs);
            events.emit("baritone_idle", d);
            cancelledByUs = false;
        }
    }

    private void registerListener() {
        b().getGameEventHandler().registerEventListener(new AbstractGameEventListener() {
            @Override
            public void onPathEvent(PathEvent event) {
                switch (event) {
                    case AT_GOAL -> {
                        JsonObject d = new JsonObject();
                        d.addProperty("goal", String.valueOf(b().getPathingBehavior().getGoal()));
                        events.emit("goal_reached", d);
                    }
                    case CALC_FAILED -> {
                        JsonObject d = new JsonObject();
                        d.addProperty("reason", "no_path");
                        d.addProperty("goal", String.valueOf(b().getPathingBehavior().getGoal()));
                        events.emit("goal_failed", d);
                    }
                    default -> {
                    }
                }
            }
        });
        listenerRegistered = true;
    }
}
