package dev.miyoria.bridge.model;

import dev.miyoria.bridge.model.Models.BlockInfo;
import dev.miyoria.bridge.model.Models.EntityInfo;
import dev.miyoria.bridge.model.Models.StackInfo;

import java.util.ArrayList;
import java.util.List;

/**
 * Unprocessed game state, filled in on the client thread by GameObserver and turned into the
 * protocol snapshot by SnapshotSummarizer. Contains no Minecraft types so it is unit-testable.
 */
public final class RawObservation {
    public float health;
    public float maxHealth = 20f;
    public float absorption;
    public int food;
    public float saturation;
    public int air;

    public double x, y, z;
    public float yaw, pitch;
    public String dimension = "overworld";
    public String biome = "unknown";
    public long timeOfDay;
    public long worldTime;
    public boolean raining;
    public boolean thundering;

    public int heldSlot;
    /** Every non-empty slot in main inventory (hotbar + storage). */
    public List<StackSlot> mainSlots = new ArrayList<>();
    public int mainSlotCount = 36;
    public StackInfo head, chest, legs, feet, offhand;

    /** What the crosshair points at: null when nothing. */
    public LookTarget lookingAt;

    public List<EntityInfo> entities = new ArrayList<>();
    public List<BlockInfo> notableBlocks = new ArrayList<>();

    public BaritoneState baritone = BaritoneState.UNAVAILABLE;
    public AltoState altoclef = AltoState.UNAVAILABLE;
    /** The running craft / smelt job, or null. */
    public CraftState crafting;
    /** The reflex that has her body ({@code lava}, {@code fight}...), or null. */
    public String reflex;
    /** Stable world identifier ({@code sp:<levelName>} or {@code mp:<address>}), or null. */
    public String worldId;
    /** Effective light level at the player's position (0..15). */
    public int lightLevel;
    /** Suspended task awaiting reflex recovery, or null. */
    public PausedTaskState pausedTask;

    public record StackSlot(int slot, StackInfo stack) {}

    public record LookTarget(String kind, String id, String name, Integer x, Integer y, Integer z,
                             String face, Double distance) {}

    public record BaritoneState(boolean available, boolean busy, String process, String goal) {
        public static final BaritoneState UNAVAILABLE = new BaritoneState(false, false, null, null);
    }

    /** {@code kind} is craft | smelt; {@code item} the output (craft) or input (smelt, null = collecting). */
    public record CraftState(String kind, String item) {}

    /** Task paused by a recoverable reflex ({@code kind} = task name, {@code detail} = short context). */
    public record PausedTaskState(String kind, String detail) {}

    /** {@code busy} may be null when it cannot be determined. */
    public record AltoState(boolean available, Boolean busy) {
        public static final AltoState UNAVAILABLE = new AltoState(false, null);
    }
}
