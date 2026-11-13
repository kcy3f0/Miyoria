package dev.miyoria.bridge.game;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.Set;

/**
 * Task lifecycle of the work requests that carry a {@code task} id (PROTOCOL.md §6.1).
 *
 * <p>The mod knows which request started what Baritone, AltoClef, the workbench or the furnace is
 * doing, so it says when that task ended instead of leaving the client to guess from path events
 * ({@code goal_reached} fires for every path segment while mining). One task at a time: a new work
 * request supersedes the current one. Pure logic on top of the event stream: {@link #onEvent} sees
 * every event the mod emits (client thread), {@link #begin} / {@link #stopped} are called by the
 * request dispatcher, {@link #altoTick} once per tick. Requests without a task id behave exactly
 * as before; the lifecycle events are extra, so older clients just ignore them.
 */
public final class TaskTracker {
    public static final String STARTED = "task_started";
    public static final String PROGRESS = "task_progress";
    public static final String DONE = "task_done";
    public static final String FAILED = "task_failed";
    public static final String REFLEX_RESUMED = "reflex_resumed";
    public static final String REFLEX_ABORTED = "reflex_aborted";

    /** Kinds that Baritone runs (they end on its busy -> idle edge). */
    private static final Set<String> BARITONE = Set.of("goto", "mine", "follow", "explore", "farm", "build", "raw");
    /** Events of the work itself, stamped with the current task id. */
    private static final Set<String> JOB_EVENTS = Set.of("goal_reached", "goal_failed", "baritone_idle",
            "craft_finished", "craft_failed", "smelt_finished", "smelt_failed");
    /** AltoClef must be idle this many ticks in a row after having been busy. */
    private static final int ALTO_IDLE_TICKS = 10;
    /** An AltoClef task that never got busy in this many ticks had nothing to do. */
    private static final int ALTO_START_TICKS = 100;

    private final EventSink out;
    private String id;
    private String kind;
    private boolean paused;
    private String pausedReflexKind;
    private boolean altoBusySeen;
    private int altoIdle;
    private int altoTicks;

    public TaskTracker(EventSink out) {
        this.out = out;
    }

    /** The running task's id, or null. */
    public String current() {
        return id;
    }

    /** The running task's kind ({@code goto}, {@code mine}, {@code craft}, {@code altoclef}...), or null. */
    public String kind() {
        return kind;
    }

    /** Whether the running task is currently suspended for a recoverable reflex. */
    public boolean isPaused() {
        return paused;
    }

    /** Reflex kind that paused the current task, or null. */
    public String pausedReflexKind() {
        return pausedReflexKind;
    }

    /**
     * A work request was accepted. It replaces what ran before ({@code superseded}); without a
     * task id the new work is just not tracked.
     */
    public void begin(String task, String newKind) {
        if (id != null && !id.equals(task)) fail("superseded", "replaced by " + newKind);
        if (task == null || task.equals(id)) return;
        id = task;
        kind = newKind;
        paused = false;
        pausedReflexKind = null;
        altoBusySeen = false;
        altoIdle = 0;
        altoTicks = 0;
        JsonObject d = base();
        out.emit(STARTED, d);
    }

    /** Suspends the current task for a recoverable reflex while keeping its task id alive. */
    public void pauseForReflex(String reflexKind) {
        if (id == null) return;
        paused = true;
        pausedReflexKind = reflexKind;
        JsonObject d = base();
        d.addProperty("detail", reflexKind == null || reflexKind.isEmpty()
                ? "paused for reflex"
                : "paused for reflex: " + reflexKind);
        d.addProperty("paused", true);
        if (reflexKind != null) d.addProperty("reflex", reflexKind);
        out.emit(PROGRESS, d);
    }

    /** Resumes a task previously suspended by {@link #pauseForReflex(String)}. */
    public void resumeFromReflex() {
        if (id == null || !paused) return;
        JsonObject d = base();
        if (pausedReflexKind != null) d.addProperty("reflex", pausedReflexKind);
        paused = false;
        pausedReflexKind = null;
        altoIdle = 0;
        out.emit(REFLEX_RESUMED, d);
    }

    /** Aborts a suspended task that could not be resumed (timeout, drift, escalation, or replay rejection). */
    public void abortPaused(String reason) {
        if (id == null || !paused) return;
        JsonObject aborted = base();
        if (pausedReflexKind != null) aborted.addProperty("reflex", pausedReflexKind);
        if (reason != null && !reason.isEmpty()) aborted.addProperty("reason", reason);
        paused = false;
        pausedReflexKind = null;
        String msg = reason != null && !reason.isEmpty() ? reason : "interrupted by a reflex";
        fail("interrupted", msg);
        out.emit(REFLEX_ABORTED, aborted);
    }

    /** A {@code stop} (or Baritone {@code stop}, AltoClef {@code @stop}) ended the work. */
    public void stopped() {
        fail("cancelled", "stopped");
    }

    /** The client went away: nobody is waiting for the task any more. */
    public void forget() {
        id = null;
        kind = null;
        paused = false;
        pausedReflexKind = null;
    }

    /** Adds {@code task} to a job event of the running task (before it is sent). */
    public void stamp(String name, JsonObject data) {
        if (id != null && data != null && JOB_EVENTS.contains(name) && !data.has("task")) {
            data.addProperty("task", id);
        }
    }

    /** Every event the mod emits, after it was sent: ends the running task when it is its end. */
    public void onEvent(String name, JsonObject data) {
        if (id == null || name.startsWith("task_")) return;
        JsonObject d = data == null ? new JsonObject() : data;
        if ("death".equals(name)) {
            fail("died", "died");
            return;
        }
        if ("reflex".equals(name)) {
            boolean recoverable = bool(d, "recoverable");
            if (paused) {
                if (!recoverable && str(d, "interrupted") != null) {
                    abortPaused("interrupted by a reflex: " + str(d, "kind"));
                } else if (recoverable && str(d, "kind") != null) {
                    pausedReflexKind = str(d, "kind");
                }
                return;
            }
            if (str(d, "interrupted") != null) {
                if (recoverable) {
                    pauseForReflex(str(d, "kind"));
                } else {
                    fail("interrupted", "interrupted by a reflex: " + str(d, "kind"));
                }
                return;
            }
        }
        if ("craft".equals(kind) || "smelt".equals(kind)) {
            if ((kind + "_finished").equals(name)) {
                JsonObject done = base();
                copy(d, done, "item", "crafted", "requested", "ready_in_secs");
                done.addProperty("detail", kind + " finished");
                finish(DONE, done);
            } else if ((kind + "_failed").equals(name)) {
                boolean cancelled = d.has("cancelled") && d.get("cancelled").getAsBoolean();
                String error = str(d, "error");
                fail(cancelled ? "cancelled" : "precondition", error == null ? kind + " failed" : error);
            }
            return;
        }
        if (!BARITONE.contains(kind)) return; // AltoClef: see altoTick
        switch (name) {
            case "goal_reached" -> {
                if ("goto".equals(kind)) done("reached the goal");
                else progress("reached a path target");
            }
            case "goal_failed" -> {
                if ("goto".equals(kind)) fail("unreachable", "no path to the goal");
            }
            case "baritone_idle" -> {
                boolean cancelled = d.has("cancelled") && d.get("cancelled").getAsBoolean();
                String reason = str(d, "reason");
                if (paused && cancelled && "reflex".equals(reason)) {
                    return;
                }
                if (cancelled && "reflex".equals(reason)) fail("interrupted", "interrupted by a reflex");
                else if (cancelled) fail("cancelled", "stopped");
                else if ("nothing_visible".equals(reason)) done("nothing more in sight");
                else done("finished");
            }
            default -> {
            }
        }
    }

    /** Once per client tick: AltoClef's busy state ({@code null}: unknown). */
    public void altoTick(Boolean busy) {
        if (id == null || !"altoclef".equals(kind) || busy == null || paused) return;
        altoTicks++;
        if (busy) {
            altoBusySeen = true;
            altoIdle = 0;
        } else if (altoBusySeen && ++altoIdle >= ALTO_IDLE_TICKS) {
            done("AltoClef finished");
        } else if (!altoBusySeen && altoTicks >= ALTO_START_TICKS) {
            done("AltoClef had nothing to do");
        }
    }

    private void progress(String detail) {
        JsonObject d = base();
        d.addProperty("detail", detail);
        out.emit(PROGRESS, d);
    }

    private void done(String detail) {
        JsonObject d = base();
        d.addProperty("detail", detail);
        finish(DONE, d);
    }

    /** Fails the running task (if any) with a code of PROTOCOL.md §6.1. */
    private void fail(String code, String message) {
        if (id == null) return;
        JsonObject d = base();
        d.addProperty("code", code);
        d.addProperty("message", message);
        finish(FAILED, d);
    }

    private void finish(String name, JsonObject data) {
        id = null;
        kind = null;
        paused = false;
        pausedReflexKind = null;
        out.emit(name, data);
    }

    private JsonObject base() {
        JsonObject d = new JsonObject();
        d.addProperty("task", id);
        d.addProperty("kind", kind);
        return d;
    }

    private static String str(JsonObject d, String key) {
        JsonElement e = d.get(key);
        return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isString() ? e.getAsString() : null;
    }

    private static boolean bool(JsonObject d, String key) {
        JsonElement e = d.get(key);
        return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isBoolean() && e.getAsBoolean();
    }

    private static void copy(JsonObject from, JsonObject to, String... keys) {
        for (String k : keys) {
            if (from.has(k)) to.add(k, from.get(k));
        }
    }
}
