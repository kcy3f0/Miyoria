package dev.miyoria.bridge.game;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import baritone.api.Settings;
import baritone.api.event.events.PathEvent;
import baritone.api.event.listener.AbstractGameEventListener;
import baritone.api.pathing.goals.Goal;
import baritone.api.pathing.goals.GoalBlock;
import baritone.api.pathing.goals.GoalGetToBlock;
import baritone.api.pathing.goals.GoalNear;
import baritone.api.pathing.goals.GoalRunAway;
import baritone.api.pathing.goals.GoalXZ;
import baritone.api.process.IBaritoneProcess;
import baritone.api.utils.BlockOptionalMetaLookup;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.miyoria.bridge.model.Models.BlockInfo;
import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.util.Ids;
import net.minecraft.block.Block;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.Entity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.BlockPos;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * Drives Baritone strictly through its Java API (no chat messages involved).
 *
 * <p>Baritone is only her legs and hands: it never picks a block she has not seen. Its chunk cache
 * knows every ore behind every wall, so {@code mine} runs in {@code legitMine} mode (only ores that
 * come into view) and {@code goto {block}} paths to a block found by {@link BlockSight}, not by
 * Baritone's own search. See {@link #applySettings()}.
 */
public final class BaritoneBridgeImpl implements BaritoneBridge {
    private static final Pattern BLOCK_ID = Pattern.compile("[a-z0-9_.:/-]+");
    private static final Pattern SCHEMATIC = Pattern.compile("[A-Za-z0-9_.-]+");
    private static final int IDLE_DEBOUNCE_TICKS = 10;
    /**
     * In legit mode Baritone only adds ores within 10 blocks of her feet that it can raytrace to
     * (its {@code addNearby}); a target farther than this would not be picked up.
     */
    private static final int MINE_SIGHT_RADIUS = 10;

    private final EventSink events;
    /** How far {@code goto {block}} looks (the observe scan radius, so it matches what she was told). */
    private final int sightRadius;
    private IBaritone baritone;
    private boolean listenerRegistered;
    private boolean settingsApplied;
    /** Why we stopped Baritone ourselves (reported with the next {@code baritone_idle}). */
    private String stopReason;

    private boolean wasBusy;
    private int idleTicks;
    private String lastProcess;
    private String lastGoal;
    private boolean cancelledByUs;
    /** A reflex (not a request) set Baritone's current goal; its events are not reported. */
    private boolean reflexOwned;
    /** Most recent request command started by {@link #execute}, for pause/resume around reflexes. */
    private SuspendableCommand activeCommand;
    private SuspendedEntry suspended;

    @FunctionalInterface
    private interface SuspendableCommand {
        boolean replay(BaritoneBridgeImpl bridge);
    }

    private record SuspendedEntry(
            SuspendableCommand command,
            String kind,
            String detail,
            double x,
            double y,
            double z,
            long pausedAtMs) {}

    public BaritoneBridgeImpl(EventSink events, int sightRadius) {
        this.events = events;
        this.sightRadius = sightRadius;
    }

    /**
     * Settings that make Baritone play like a person instead of a bot (set once, on the first tick
     * in a world, after Baritone has read its own {@code settings.txt}; {@code legitMine} is also
     * re-asserted before every {@code mine}):
     * <ul>
     *   <li>{@code legitMine true}: mining only targets ores it has actually seen (raytraced from
     *       her eyes), never the chunk cache's x-ray list. When nothing is in view it would start a
     *       blind strip mine; {@link #tick()} stops that instead.</li>
     *   <li>{@code freeLook false}: the camera turns where she walks (with free look the view stays
     *       put while the body walks sideways, which looks like a bot on stream).</li>
     *   <li>{@code smoothLook true}, {@code smoothLookTicks 10}: the camera's yaw is the average of
     *       the last 10 ticks of Baritone's rotations, so turns are gradual instead of snapping.</li>
     *   <li>{@code renderPath / renderGoal / renderSelectionBoxes false}: no path lines or goal boxes
     *       drawn into her (streamed) view.</li>
     * </ul>
     */
    private static void applySettings() {
        Settings s = BaritoneAPI.getSettings();
        s.legitMine.value = true;
        s.freeLook.value = false;
        s.smoothLook.value = true;
        s.smoothLookTicks.value = 10;
        s.renderPath.value = false;
        s.renderGoal.value = false;
        s.renderSelectionBoxes.value = false;
        org.slf4j.LoggerFactory.getLogger("miyoria-bridge").info(
                "Baritone set to play legit: legitMine true, freeLook false, smoothLook true (10 ticks), path/goal rendering off");
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
        reflexOwned = false; // a request takes Baritone over from a reflex
        activeCommand = null;
        suspended = null;
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
            // Not Baritone's GetToBlock process: that one searches the chunk cache (x-ray).
            String block = blockName(req.str("block"));
            BlockInfo target = seen(List.of(block), sightRadius);
            Goal g = new GoalGetToBlock(new BlockPos(target.x(), target.y(), target.z()));
            b().getCustomGoalProcess().setGoalAndPath(g);
            activeCommand = bridge -> {
                bridge.b().getCustomGoalProcess().setGoalAndPath(g);
                return true;
            };
            out.addProperty("goal", g.toString());
            out.add("position", position(target));
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
        final Goal capturedGoal = goal;
        activeCommand = bridge -> {
            bridge.b().getCustomGoalProcess().setGoalAndPath(capturedGoal);
            return true;
        };
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

    /**
     * The nearest block of {@code names} she can see within {@code radius}; throws
     * {@code not_visible} when there is none. Client thread.
     */
    private static BlockInfo seen(List<String> names, int radius) throws ProtocolException {
        MinecraftClient mc = MinecraftClient.getInstance();
        Set<Block> kinds = BlockSight.blocks(names);
        if (kinds.isEmpty()) throw new ProtocolException(Protocol.E_INVALID_ARGS, "unknown block " + names);
        BlockInfo b = BlockSight.nearestVisible(mc.player, mc.world, kinds, radius);
        if (b == null) {
            throw new ProtocolException(Protocol.E_NOT_VISIBLE,
                    "no " + String.join("/", names) + " in sight within " + radius + " blocks");
        }
        return b;
    }

    private static JsonObject position(BlockInfo b) {
        JsonObject p = new JsonObject();
        p.addProperty("x", b.x());
        p.addProperty("y", b.y());
        p.addProperty("z", b.z());
        return p;
    }

    @Override
    public List<String> lookupTargets(Request req) {
        try {
            String command = req.str("command").toLowerCase();
            List<String> names = new ArrayList<>();
            if ("mine".equals(command) && req.has("block")) {
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
        // Something has to be in view already: legit mining with nothing in sight is a blind dig.
        BlockInfo first;
        try {
            first = seen(names, MINE_SIGHT_RADIUS);
        } catch (ProtocolException e) {
            if (!Protocol.E_NOT_VISIBLE.equals(e.code())) throw e;
            BlockInfo far = seen(names, sightRadius); // throws not_visible when none at all
            throw new ProtocolException(Protocol.E_TOO_FAR, "nearest " + far.block() + " in sight is "
                    + Math.round(far.distance()) + " blocks away at " + far.x() + "," + far.y() + "," + far.z());
        }
        BaritoneAPI.getSettings().legitMine.value = true;
        String[] targetNames = names.toArray(new String[0]);
        b().getMineProcess().mineByName(count, targetNames);
        activeCommand = bridge -> {
            if (MinecraftClient.getInstance().isPaused()) return false;
            BaritoneAPI.getSettings().legitMine.value = true;
            bridge.b().getMineProcess().mineByName(count, targetNames);
            return true;
        };
        out.add("first", position(first));
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
        activeCommand = bridge -> {
            bridge.b().getFollowProcess().follow(filter);
            return true;
        };
    }

    private void doExplore(Request req, JsonObject out) throws ProtocolException {
        MinecraftClient mc = MinecraftClient.getInstance();
        int x = req.has("x") ? (int) Math.floor(req.num("x")) : (int) Math.floor(mc.player.getX());
        int z = req.has("z") ? (int) Math.floor(req.num("z")) : (int) Math.floor(mc.player.getZ());
        b().getExploreProcess().explore(x, z);
        activeCommand = bridge -> {
            bridge.b().getExploreProcess().explore(x, z);
            return true;
        };
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
        activeCommand = bridge -> {
            if (range > 0) {
                bridge.b().getFarmProcess().farm(range, null);
            } else {
                bridge.b().getFarmProcess().farm();
            }
            return true;
        };
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
        String commandLine = line.toString();
        boolean ok = b().getCommandManager().execute(commandLine);
        if (!ok) throw new ProtocolException(Protocol.E_INVALID_ARGS, "baritone rejected: " + commandLine);
        activeCommand = bridge -> bridge.b().getCommandManager().execute(commandLine);
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

    private void cancelBaritone(String reason) {
        cancelledByUs = true;
        stopReason = reason;
        b().getPathingBehavior().cancelEverything();
    }

    @Override
    public void cancel() {
        activeCommand = null;
        suspended = null;
        cancelBaritone(null);
    }

    @Override
    public void interrupt() {
        activeCommand = null;
        suspended = null;
        cancelBaritone("reflex");
    }

    @Override
    public boolean pauseForReflex(double playerX, double playerY, double playerZ, long nowMs) {
        RawObservation.BaritoneState st = state();
        if (activeCommand == null || reflexOwned || !st.busy()) {
            return false;
        }
        String kind = st.process() != null ? st.process() : "baritone";
        String detail = st.goal() != null ? st.goal() : kind;
        suspended = new SuspendedEntry(activeCommand, kind, detail, playerX, playerY, playerZ, nowMs);
        activeCommand = null;
        cancelBaritone("reflex");
        return true;
    }

    @Override
    public boolean hasSuspended() {
        return suspended != null;
    }

    @Override
    public RawObservation.PausedTaskState suspendedState() {
        SuspendedEntry entry = suspended;
        return entry == null ? null : new RawObservation.PausedTaskState(entry.kind(), entry.detail());
    }

    @Override
    public boolean replaySuspended(double playerX, double playerY, double playerZ, long nowMs,
                                   double maxDrift, long maxPauseMs) {
        SuspendedEntry entry = suspended;
        suspended = null;
        if (entry == null) {
            return false;
        }
        if (!BaritoneBridge.withinResumeBounds(entry.x(), entry.y(), entry.z(), entry.pausedAtMs(),
                playerX, playerY, playerZ, nowMs, maxDrift, maxPauseMs)) {
            return false;
        }
        cancelledByUs = false;
        stopReason = null;
        reflexOwned = false;
        idleTicks = 0;
        activeCommand = entry.command();
        boolean replayed = entry.command().replay(this);
        if (!replayed) {
            activeCommand = null;
        }
        return replayed;
    }

    @Override
    public void clearSuspended() {
        suspended = null;
    }

    @Override
    public void reflexGoTo(BlockPos pos) {
        reflexOwned = true;
        b().getCustomGoalProcess().setGoalAndPath(new GoalBlock(pos));
    }

    @Override
    public void reflexRunAway(double distance, List<BlockPos> from) {
        reflexOwned = true;
        b().getCustomGoalProcess().setGoalAndPath(new GoalRunAway(distance, from.toArray(new BlockPos[0])));
    }

    @Override
    public void reflexCancel() {
        if (reflexOwned) b().getPathingBehavior().cancelEverything();
    }

    @Override
    public boolean reflexDriving() {
        return reflexOwned && state().busy();
    }

    @Override
    public boolean pathing() {
        return b().getPathingBehavior().isPathing();
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
        if (!settingsApplied) {
            settingsApplied = true;
            applySettings();
        }
        if (!listenerRegistered) {
            registerListener();
        }
        IBaritone bar = b();
        // Legit mining that ran out of ores in view switches to a GoalRunAway (dig down to
        // legitMineYLevel and strip mine). She should look around instead, so stop it.
        if (stopReason == null && bar.getMineProcess().isActive() && bar.getPathingBehavior().getGoal() instanceof GoalRunAway) {
            stopReason = "nothing_visible";
            bar.getPathingBehavior().cancelEverything();
        }
        RawObservation.BaritoneState s = state();
        if (s.busy()) {
            wasBusy = true;
            idleTicks = 0;
            lastProcess = s.process();
            lastGoal = s.goal();
        } else if (wasBusy && ++idleTicks >= IDLE_DEBOUNCE_TICKS) {
            wasBusy = false;
            if (reflexOwned) {
                // a reflex's walk (a pickup, running away) ended: not a task of hers
                reflexOwned = false;
                cancelledByUs = false;
                stopReason = null;
                return;
            }
            activeCommand = null;
            JsonObject d = new JsonObject();
            d.addProperty("process", lastProcess);
            d.addProperty("goal", lastGoal);
            d.addProperty("cancelled", cancelledByUs);
            if (stopReason != null) d.addProperty("reason", stopReason);
            events.emit("baritone_idle", d);
            cancelledByUs = false;
            stopReason = null;
        }
    }

    private void registerListener() {
        b().getGameEventHandler().registerEventListener(new AbstractGameEventListener() {
            @Override
            public void onPathEvent(PathEvent event) {
                if (reflexOwned) return; // a reflex's own walk
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
