package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.model.Models.BlockInfo;
import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.util.Ids;
import net.minecraft.block.Blocks;
import net.minecraft.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.recipe.AbstractCookingRecipe;
import net.minecraft.recipe.CraftingRecipe;
import net.minecraft.recipe.Ingredient;
import net.minecraft.recipe.RecipeEntry;
import net.minecraft.recipe.RecipeType;
import net.minecraft.recipe.ShapedRecipe;
import net.minecraft.recipe.ShapelessRecipe;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.screen.AbstractFurnaceScreenHandler;
import net.minecraft.screen.CraftingScreenHandler;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.Slot;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.Hand;
import net.minecraft.util.Identifier;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Predicate;

/**
 * Crafting (the 2x2 grid of her inventory, or a crafting table within reach) and loading /
 * emptying a furnace, done the way a player does it: open the screen, move items with slot
 * clicks, take the result, close. Nothing is conjured: the server checks every click.
 *
 * <p>A job runs over several ticks. The request only validates and starts it; the end is
 * reported with {@code craft_finished} / {@code craft_failed} or {@code smelt_finished} /
 * {@code smelt_failed}. Client thread only.
 */
public final class Workbench {
    private static final int LOOK_TICKS = 6;
    private static final int OPEN_TIMEOUT_TICKS = 40;
    private static final int RESULT_TIMEOUT_TICKS = 20;
    /** Ticks between two crafts: lets the server's slot updates arrive, and looks like a hand. */
    private static final int CRAFT_INTERVAL_TICKS = 3;
    private static final int MAX_COUNT = 64;
    private static final int COOK_TICKS = 200;
    private static final int FAST_COOK_TICKS = 100;
    /** How far a station is looked for, to say "it is over there" instead of "there is none". */
    private static final int STATION_SIGHT = 16;

    private enum Phase { LOOK, WAIT_OPEN, WORK, WAIT_RESULT, PAUSE }

    private static final class Job {
        final String kind; // craft | smelt
        final Item item; // craft: the output; smelt: the input (null = only collect)
        final BlockPos station; // null = the 2x2 inventory grid
        Phase phase;
        int wait;
        // craft
        CraftingRecipe recipe;
        int gridWidth;
        int crafts;
        int done;
        int made;
        int requested;
        // smelt
        String stationName;
        int cookTicks = COOK_TICKS;
        int inputCount;
        Item fuel;
        int fuelCount;

        Job(String kind, Item item, BlockPos station) {
            this.kind = kind;
            this.item = item;
            this.station = station;
            this.phase = station == null ? Phase.WORK : Phase.LOOK;
            this.wait = LOOK_TICKS;
        }
    }

    /** A job that cannot go on; the message ends up in the failure event. */
    private static final class Failure extends Exception {
        Failure(String message) {
            super(message);
        }
    }

    private final EventSink events;
    private final GameActions actions;
    private Job job;

    public Workbench(EventSink events, GameActions actions) {
        this.events = events;
        this.actions = actions;
    }

    /** The running job for observe, or null. */
    public RawObservation.CraftState state() {
        if (job == null) return null;
        return new RawObservation.CraftState(job.kind, job.item == null ? null : id(job.item));
    }

    // ------------------------------------------------------------------ requests

    /** {@code {"item":"wooden_pickaxe","count":1}}: count = how many result items she wants (1-64). */
    public JsonObject craft(MinecraftClient mc, Request req) throws ProtocolException {
        requireIdle(mc);
        ClientPlayerEntity p = mc.player;
        Item item = item(req.str("item"));
        int want = Math.max(1, Math.min(MAX_COUNT, req.optInt("count", 1)));
        List<CraftingRecipe> recipes = recipesFor(mc.world, item);
        if (recipes.isEmpty()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "no crafting recipe makes " + id(item));
        }
        Map<Item, Integer> have = inventory(p);
        BlockInfo tableSeen = BlockSight.nearestVisible(p, mc.world, Set.of(Blocks.CRAFTING_TABLE), STATION_SIGHT);
        BlockPos table = tableSeen != null && p.canInteractWithBlockAt(pos(tableSeen), 0) ? pos(tableSeen) : null;

        String missing = null;
        boolean missingNeedsTable = false;
        boolean blockedByTable = false;
        for (CraftingRecipe r : recipes) {
            boolean small = r.fits(2, 2);
            int per = Math.max(1, r.getResult(mc.world.getRegistryManager()).getCount());
            int crafts = (want + per - 1) / per;
            int possible = possibleCrafts(r, have, crafts);
            if (possible == 0) {
                if (missing == null) {
                    missing = missingText(r, have);
                    missingNeedsTable = !small && table == null;
                }
                continue;
            }
            if (!small && table == null) {
                blockedByTable = true;
                continue;
            }
            Job j = new Job("craft", item, small ? null : table);
            j.recipe = r;
            j.gridWidth = small ? 2 : 3;
            j.crafts = possible;
            j.requested = want;
            job = j;
            JsonObject out = new JsonObject();
            out.addProperty("item", id(item));
            out.addProperty("count", possible * per);
            out.addProperty("crafts", possible);
            out.addProperty("table", !small);
            return out;
        }
        if (blockedByTable) throw stationProblem(tableSeen, "crafting_table");
        String why = "missing " + missing + (missingNeedsTable ? "; also needs a crafting_table within reach" : "");
        throw new ProtocolException(Protocol.E_MISSING_ITEMS, why);
    }

    /**
     * {@code {"item":"raw_iron","count":3,"fuel":"coal"}} loads the furnace within reach (count and
     * fuel optional); without {@code item} it only takes out what is done. Either way the finished
     * output is collected first.
     */
    public JsonObject smelt(MinecraftClient mc, Request req) throws ProtocolException {
        requireIdle(mc);
        ClientPlayerEntity p = mc.player;
        Item input = req.has("item") ? item(req.str("item")) : null;
        if (input != null && !smeltable(mc.world, input)) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, id(input) + " cannot be smelted in a furnace");
        }
        boolean blast = input != null && hasRecipe(mc.world, RecipeType.BLASTING, input);
        boolean smoke = !blast && input != null && hasRecipe(mc.world, RecipeType.SMOKING, input);
        BlockInfo seen = pickSmeltStation(p, mc.world, input, blast, smoke);
        String expected = blast ? "blast_furnace or furnace" : smoke ? "smoker or furnace" : "furnace";
        if (seen == null || !p.canInteractWithBlockAt(pos(seen), 0)) {
            throw stationProblem(seen, seen != null ? seen.block() : expected);
        }
        Job j = new Job("smelt", input, pos(seen));
        j.stationName = seen.block();
        j.cookTicks = ("blast_furnace".equals(j.stationName) || "smoker".equals(j.stationName))
                ? FAST_COOK_TICKS : COOK_TICKS;
        JsonObject out = new JsonObject();
        out.add("furnace", posJson(j.station));
        out.addProperty("station", j.stationName);
        if (input != null) {
            Map<Item, Integer> have = inventory(p);
            int owned = have.getOrDefault(input, 0);
            if (owned == 0) throw new ProtocolException(Protocol.E_MISSING_ITEMS, "missing " + id(input) + " x1");
            j.inputCount = Math.max(1, Math.min(Math.min(MAX_COUNT, owned), req.optInt("count", owned)));
            Map<Item, Integer> burn = AbstractFurnaceBlockEntity.createFuelTimeMap();
            Item fuel = req.has("fuel") ? item(req.str("fuel")) : pickFuel(have, burn, input);
            int fuelOwned = fuel == null ? 0 : have.getOrDefault(fuel, 0) - (fuel == input ? j.inputCount : 0);
            if (fuel == null || !burn.containsKey(fuel) || fuelOwned <= 0) {
                throw new ProtocolException(Protocol.E_MISSING_ITEMS, "missing fuel x1");
            }
            int needed = (j.inputCount * COOK_TICKS + burn.get(fuel) - 1) / burn.get(fuel);
            j.fuel = fuel;
            j.fuelCount = Math.min(fuelOwned, needed);
            out.addProperty("item", id(input));
            out.addProperty("count", j.inputCount);
            out.addProperty("fuel", id(fuel));
            out.addProperty("fuel_count", j.fuelCount);
        }
        job = j;
        return out;
    }

    /** Aborts the running job (the {@code stop} request). */
    public void cancel(MinecraftClient mc) {
        if (job != null) finish(mc, false, "stopped", true);
    }

    // ------------------------------------------------------------------ per tick

    public void tick(MinecraftClient mc) {
        if (job == null) return;
        if (mc.player == null || mc.world == null) {
            job = null; // left the world: nothing to close or report
            return;
        }
        try {
            step(mc, mc.player);
        } catch (Failure f) {
            finish(mc, false, f.getMessage(), false);
        }
    }

    private void step(MinecraftClient mc, ClientPlayerEntity p) throws Failure {
        Job j = job;
        switch (j.phase) {
            case LOOK -> {
                if (j.wait == LOOK_TICKS) actions.lookAt(p, Vec3d.ofCenter(j.station), true);
                if (--j.wait > 0) return;
                Direction face = Direction.getFacing(p.getEyePos().subtract(Vec3d.ofCenter(j.station)));
                mc.interactionManager.interactBlock(p, Hand.MAIN_HAND,
                        new BlockHitResult(Vec3d.ofCenter(j.station), face, j.station, false));
                p.swingHand(Hand.MAIN_HAND);
                j.phase = Phase.WAIT_OPEN;
                j.wait = OPEN_TIMEOUT_TICKS;
            }
            case WAIT_OPEN -> {
                if (expectedScreen(p)) {
                    j.phase = Phase.WORK;
                } else if (--j.wait <= 0) {
                    String what = "craft".equals(j.kind)
                            ? "crafting_table"
                            : (j.stationName != null ? j.stationName : "furnace");
                    throw new Failure("could not open the " + what);
                }
            }
            case WORK -> {
                if ("craft".equals(j.kind)) craftOnce(mc, p, j);
                else loadFurnace(mc, p, j);
            }
            case WAIT_RESULT -> takeResult(mc, p, j);
            case PAUSE -> {
                if (--j.wait <= 0) j.phase = Phase.WORK;
            }
        }
    }

    private boolean expectedScreen(ClientPlayerEntity p) {
        ScreenHandler h = p.currentScreenHandler;
        return "craft".equals(job.kind) ? h instanceof CraftingScreenHandler : h instanceof AbstractFurnaceScreenHandler;
    }

    /** The open handler for this job, or a failure when the screen went away (closed by hand). */
    private ScreenHandler handler(MinecraftClient mc, ClientPlayerEntity p, Job j) throws Failure {
        if (j.station == null) {
            if (!(mc.currentScreen instanceof InventoryScreen)) {
                if (mc.currentScreen != null) throw new Failure("another screen was opened");
                mc.setScreen(new InventoryScreen(p)); // client-side only: viewers see her crafting
            }
            return p.playerScreenHandler;
        }
        if (!expectedScreen(p)) throw new Failure("the screen was closed");
        return p.currentScreenHandler;
    }

    private void craftOnce(MinecraftClient mc, ClientPlayerEntity p, Job j) throws Failure {
        ScreenHandler h = handler(mc, p, j);
        if (!h.getCursorStack().isEmpty()) throw new Failure("the cursor is holding something");
        clearGrid(mc, p, h, j);
        if (j.done >= j.crafts) {
            finish(mc, true, null, false);
            return;
        }
        for (Map.Entry<Integer, Ingredient> e : layout(j.recipe, j.gridWidth).entrySet()) {
            int src = inventorySlot(h, e.getValue());
            if (src < 0) {
                if (j.done > 0) { // ran out halfway: keep what was made
                    clearGrid(mc, p, h, j);
                    finish(mc, true, null, false);
                    return;
                }
                throw new Failure("ran out of " + display(e.getValue()));
            }
            click(mc, p, h, src, 0, SlotActionType.PICKUP); // whole stack on the cursor
            click(mc, p, h, 1 + e.getKey(), 1, SlotActionType.PICKUP); // right click: put one down
            if (!h.getCursorStack().isEmpty()) click(mc, p, h, src, 0, SlotActionType.PICKUP); // the rest back
        }
        j.phase = Phase.WAIT_RESULT;
        j.wait = RESULT_TIMEOUT_TICKS;
    }

    private void takeResult(MinecraftClient mc, ClientPlayerEntity p, Job j) throws Failure {
        ScreenHandler h = handler(mc, p, j);
        ItemStack result = h.getSlot(0).getStack();
        if (result.isEmpty() || !result.isOf(j.item)) {
            if (--j.wait <= 0) throw new Failure("the recipe did not produce " + id(j.item));
            return;
        }
        PlayerInventory inv = p.getInventory();
        if (inv.getOccupiedSlotWithRoomForStack(result) < 0 && inv.getEmptySlot() < 0) throw new Failure("inventory full");
        int count = result.getCount();
        click(mc, p, h, 0, 0, SlotActionType.QUICK_MOVE);
        j.made += count;
        j.done++;
        j.phase = Phase.PAUSE;
        j.wait = CRAFT_INTERVAL_TICKS;
    }

    private void loadFurnace(MinecraftClient mc, ClientPlayerEntity p, Job j) throws Failure {
        ScreenHandler h = handler(mc, p, j);
        if (!h.getCursorStack().isEmpty()) throw new Failure("the cursor is holding something");
        JsonObject data = new JsonObject();
        ItemStack done = h.getSlot(2).getStack();
        if (!done.isEmpty()) {
            JsonObject taken = new JsonObject();
            taken.addProperty(id(done.getItem()), done.getCount());
            click(mc, p, h, 2, 0, SlotActionType.QUICK_MOVE);
            data.add("collected", taken);
        }
        if (j.item != null) {
            ItemStack in = h.getSlot(0).getStack();
            if (!in.isEmpty() && !in.isOf(j.item)) {
                throw new Failure("the furnace is still smelting " + id(in.getItem()));
            }
            int loaded = moveInto(mc, p, h, 0, j.item, j.inputCount);
            int fueled = 0;
            ItemStack fuelSlot = h.getSlot(1).getStack();
            if (fuelSlot.isEmpty() || fuelSlot.isOf(j.fuel)) fueled = moveInto(mc, p, h, 1, j.fuel, j.fuelCount);
            if (loaded == 0) throw new Failure("could not put " + id(j.item) + " into the furnace");
            data.addProperty("station", j.stationName != null ? j.stationName : "furnace");
            data.addProperty("item", id(j.item));
            data.addProperty("count", loaded);
            data.addProperty("fuel", id(j.fuel));
            data.addProperty("fuel_count", fueled);
            data.addProperty("ready_in_secs", loaded * j.cookTicks / 20);
        }
        finish(mc, true, data, false);
    }

    // ------------------------------------------------------------------ helpers

    private void finish(MinecraftClient mc, boolean ok, Object detail, boolean cancelled) {
        Job j = job;
        job = null;
        ClientPlayerEntity p = mc.player;
        if (p != null) {
            if (j.station == null && "craft".equals(j.kind)) clearGrid(mc, p, p.playerScreenHandler, j);
            if (j.station != null ? p.currentScreenHandler != p.playerScreenHandler : mc.currentScreen instanceof InventoryScreen) {
                p.closeHandledScreen(); // the server puts whatever is left in the grid back
            }
        }
        JsonObject d = detail instanceof JsonObject o ? o : new JsonObject();
        if ("craft".equals(j.kind)) {
            d.addProperty("item", id(j.item));
            d.addProperty("crafted", j.made);
            d.addProperty("requested", j.requested);
        }
        if (!ok) {
            d.addProperty("error", detail instanceof String s ? s : "failed");
            if (cancelled) d.addProperty("cancelled", true);
        }
        events.emit(j.kind + (ok ? "_finished" : "_failed"), d);
    }

    private static void click(MinecraftClient mc, ClientPlayerEntity p, ScreenHandler h, int slot, int button, SlotActionType type) {
        mc.interactionManager.clickSlot(h.syncId, slot, button, type, p);
    }

    /** Shift-clicks whatever sits in the crafting grid back into the inventory. */
    private static void clearGrid(MinecraftClient mc, ClientPlayerEntity p, ScreenHandler h, Job j) {
        int cells = j.gridWidth * j.gridWidth;
        for (int i = 1; i <= cells; i++) {
            if (!h.getSlot(i).getStack().isEmpty()) click(mc, p, h, i, 0, SlotActionType.QUICK_MOVE);
        }
    }

    /** Grid cell (row * width + column) -> ingredient, for one craft. */
    private static Map<Integer, Ingredient> layout(CraftingRecipe r, int gridWidth) {
        Map<Integer, Ingredient> cells = new LinkedHashMap<>();
        List<Ingredient> ings = r.getIngredients();
        if (r instanceof ShapedRecipe s) {
            for (int row = 0; row < s.getHeight(); row++) {
                for (int col = 0; col < s.getWidth(); col++) {
                    Ingredient ing = ings.get(row * s.getWidth() + col);
                    if (!ing.isEmpty()) cells.put(row * gridWidth + col, ing);
                }
            }
        } else {
            int cell = 0;
            for (Ingredient ing : ings) {
                if (!ing.isEmpty()) cells.put(cell++, ing);
            }
        }
        return cells;
    }

    /** First player-inventory slot of the open handler holding something the ingredient accepts. */
    private static int inventorySlot(ScreenHandler h, Predicate<ItemStack> accepts) {
        for (Slot s : h.slots) {
            if (s.inventory instanceof PlayerInventory && s.getIndex() < 36 && !s.getStack().isEmpty() && accepts.test(s.getStack())) {
                return s.id;
            }
        }
        return -1;
    }

    /** Moves up to {@code n} of {@code item} into slot {@code target}; returns how many went in. */
    private static int moveInto(MinecraftClient mc, ClientPlayerEntity p, ScreenHandler h, int target, Item item, int n) {
        int moved = 0;
        for (int guard = 0; moved < n && guard < 40; guard++) {
            int src = inventorySlot(h, s -> s.isOf(item));
            if (src < 0) break;
            int before = h.getSlot(target).getStack().getCount();
            click(mc, p, h, src, 0, SlotActionType.PICKUP);
            int need = n - moved;
            if (h.getCursorStack().getCount() <= need) {
                click(mc, p, h, target, 0, SlotActionType.PICKUP);
            } else {
                for (int i = 0; i < need; i++) click(mc, p, h, target, 1, SlotActionType.PICKUP);
            }
            if (!h.getCursorStack().isEmpty()) click(mc, p, h, src, 0, SlotActionType.PICKUP);
            int gained = h.getSlot(target).getStack().getCount() - before;
            if (gained <= 0) break; // the slot is full
            moved += gained;
        }
        return moved;
    }

    private void requireIdle(MinecraftClient mc) throws ProtocolException {
        if (job != null) {
            throw new ProtocolException(Protocol.E_BUSY, "still busy with " + job.kind + "; wait for it to finish or stop");
        }
        if (mc.isPaused()) throw new ProtocolException(Protocol.E_GAME_PAUSED, "the game is paused");
        if (mc.currentScreen != null) throw new ProtocolException(Protocol.E_INVALID_ARGS, "a screen is open; close it first");
        if (mc.player.isDead()) throw new ProtocolException(Protocol.E_INVALID_ARGS, "she is dead");
    }

    private static ProtocolException stationProblem(BlockInfo seen, String station) {
        if (seen != null) {
            return new ProtocolException(Protocol.E_TOO_FAR, "nearest " + station + " in sight is "
                    + Math.round(seen.distance()) + " blocks away at " + seen.x() + "," + seen.y() + "," + seen.z());
        }
        return new ProtocolException(Protocol.E_NEEDS_STATION, "needs a " + station + " within reach; none in sight");
    }

    private static List<CraftingRecipe> recipesFor(ClientWorld w, Item item) {
        List<CraftingRecipe> out = new ArrayList<>();
        for (RecipeEntry<CraftingRecipe> e : w.getRecipeManager().listAllOfType(RecipeType.CRAFTING)) {
            CraftingRecipe r = e.value();
            if (!(r instanceof ShapedRecipe || r instanceof ShapelessRecipe)) continue; // special (fireworks, maps...)
            if (r.getResult(w.getRegistryManager()).isOf(item)) out.add(r);
        }
        return out;
    }

    private static BlockInfo pickSmeltStation(
            ClientPlayerEntity p, ClientWorld w, Item input, boolean blast, boolean smoke) {
        if (input == null) {
            BlockInfo any = BlockSight.nearestVisible(
                    p, w, Set.of(Blocks.BLAST_FURNACE, Blocks.SMOKER, Blocks.FURNACE), STATION_SIGHT);
            if (any != null) return any;
            return null;
        }
        BlockInfo preferred = null;
        if (blast) {
            preferred = BlockSight.nearestVisible(p, w, Set.of(Blocks.BLAST_FURNACE), STATION_SIGHT);
        } else if (smoke) {
            preferred = BlockSight.nearestVisible(p, w, Set.of(Blocks.SMOKER), STATION_SIGHT);
        }
        if (preferred != null && p.canInteractWithBlockAt(pos(preferred), 0)) return preferred;
        BlockInfo furnace = BlockSight.nearestVisible(p, w, Set.of(Blocks.FURNACE), STATION_SIGHT);
        if (furnace != null && p.canInteractWithBlockAt(pos(furnace), 0)) return furnace;
        return preferred != null ? preferred : furnace;
    }

    private static boolean smeltable(ClientWorld w, Item item) {
        return hasRecipe(w, RecipeType.SMELTING, item)
                || hasRecipe(w, RecipeType.BLASTING, item)
                || hasRecipe(w, RecipeType.SMOKING, item);
    }

    private static <T extends AbstractCookingRecipe> boolean hasRecipe(
            ClientWorld w, RecipeType<T> type, Item item) {
        ItemStack stack = item.getDefaultStack();
        return w.getRecipeManager().listAllOfType(type).stream()
                .anyMatch(e -> !e.value().getIngredients().isEmpty()
                        && e.value().getIngredients().get(0).test(stack));
    }

    /** Coal first, then wood (planks, logs), then sticks; never the thing being smelted. */
    private static Item pickFuel(Map<Item, Integer> have, Map<Item, Integer> burn, Item input) {
        List<Predicate<Item>> preference = List.of(
                i -> i == Items.COAL || i == Items.CHARCOAL,
                i -> i == Items.COAL_BLOCK,
                i -> i.getDefaultStack().isIn(ItemTags.PLANKS),
                i -> i.getDefaultStack().isIn(ItemTags.LOGS_THAT_BURN),
                i -> i == Items.STICK);
        for (Predicate<Item> kind : preference) {
            for (Map.Entry<Item, Integer> e : have.entrySet()) {
                if (e.getKey() != input && e.getValue() > 0 && burn.containsKey(e.getKey()) && kind.test(e.getKey())) return e.getKey();
            }
        }
        return null;
    }

    /** How many times (up to {@code max}) the inventory covers the recipe's ingredients. */
    private static int possibleCrafts(CraftingRecipe r, Map<Item, Integer> have, int max) {
        Map<Item, Integer> left = new HashMap<>(have);
        for (int k = 0; k < max; k++) {
            for (Ingredient ing : r.getIngredients()) {
                if (ing.isEmpty()) continue;
                Item pick = pick(ing, left);
                if (pick == null) return k;
                left.merge(pick, -1, Integer::sum);
            }
        }
        return max;
    }

    /** "stick x2, oak_planks+ x3": what one craft still lacks ({@code +} = or a similar item). */
    private static String missingText(CraftingRecipe r, Map<Item, Integer> have) {
        Map<Item, Integer> left = new HashMap<>(have);
        Map<String, Integer> missing = new TreeMap<>();
        for (Ingredient ing : r.getIngredients()) {
            if (ing.isEmpty()) continue;
            Item pick = pick(ing, left);
            if (pick == null) missing.merge(display(ing), 1, Integer::sum);
            else left.merge(pick, -1, Integer::sum);
        }
        List<String> parts = new ArrayList<>();
        missing.forEach((k, v) -> parts.add(k + " x" + v));
        return String.join(", ", parts);
    }

    /** The accepted item she has most of, or null. */
    private static Item pick(Ingredient ing, Map<Item, Integer> left) {
        Item best = null;
        int most = 0;
        for (Map.Entry<Item, Integer> e : left.entrySet()) {
            if (e.getValue() > most && ing.test(e.getKey().getDefaultStack())) {
                best = e.getKey();
                most = e.getValue();
            }
        }
        return best;
    }

    private static String display(Ingredient ing) {
        ItemStack[] stacks = ing.getMatchingStacks();
        if (stacks.length == 0) return "?";
        return id(stacks[0].getItem()) + (stacks.length > 1 ? "+" : "");
    }

    private static Map<Item, Integer> inventory(ClientPlayerEntity p) {
        Map<Item, Integer> have = new HashMap<>();
        for (ItemStack s : p.getInventory().main) {
            if (!s.isEmpty()) have.merge(s.getItem(), s.getCount(), Integer::sum);
        }
        return have;
    }

    static Item item(String raw) throws ProtocolException {
        Identifier id = Identifier.tryParse(Ids.qualify(raw.trim().toLowerCase()));
        if (id == null || !Registries.ITEM.containsId(id)) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "unknown item \"" + raw + "\"");
        }
        return Registries.ITEM.get(id);
    }

    static String id(Item item) {
        return Ids.normalize(Registries.ITEM.getId(item).toString());
    }

    private static BlockPos pos(BlockInfo b) {
        return new BlockPos(b.x(), b.y(), b.z());
    }

    private static JsonObject posJson(BlockPos p) {
        JsonObject o = new JsonObject();
        o.addProperty("x", p.getX());
        o.addProperty("y", p.getY());
        o.addProperty("z", p.getZ());
        return o;
    }
}
