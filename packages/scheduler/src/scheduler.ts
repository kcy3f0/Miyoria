import { errorMessage, type ModuleContext } from "@miyoria/kernel";
import {
  type Action,
  type ActionPayload,
  type ActionSink,
  actionPlatform,
  isActionExpired,
  type LaneKey,
  type MessageRef,
  type PlatformSink,
  PlatformSinksKey,
  PRIORITY_RANK,
  type TurnId,
  timestampMs,
  type VoiceSink,
  VoiceSinkKey,
} from "@miyoria/types";
import type { SchedulerConfig } from "./config.js";

interface Queued {
  seq: number;
  /** `action.created_at` in epoch ms, parsed once. */
  createdMs: number;
  action: Action;
}

type WakeResult = "notified" | "timeout" | "aborted";

/** Wakes a sleeping lane worker (Rust `tokio::sync::Notify`, without the stored permit). */
class Wake {
  #resolve: ((result: WakeResult) => void) | null = null;

  notify(): void {
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.("notified");
  }

  /**
   * Waits for `notify`, `ms` to pass or `signal` to abort. Nothing is lost between the
   * worker's queue check and this call: both run in the same synchronous step.
   */
  wait(ms: number, signal: AbortSignal): Promise<WakeResult> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve("aborted");
        return;
      }
      const settle = (result: WakeResult) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.#resolve = null;
        resolve(result);
      };
      const onAbort = () => settle("aborted");
      const timer = setTimeout(() => settle("timeout"), ms);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#resolve = settle;
    });
  }
}

interface Lane {
  queue: Queued[];
  wake: Wake;
}

type Target = { kind: "platform"; sink: PlatformSink } | { kind: "voice"; sink: VoiceSink };

interface Outcome {
  message: MessageRef | null;
  interrupted: boolean;
}

type Completion = { ok: true; message: MessageRef | null } | { ok: false; error: string };

type Bounded<T> = { kind: "done"; value: T } | { kind: "timeout" } | { kind: "cancelled" };

/**
 * Runs `fn` until it settles, `timeoutMs` pass or `parent` aborts. The signal given to `fn` is
 * aborted afterwards in every case, so a call that lost the race can stop early.
 */
async function runBounded<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<Bounded<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupt = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    onAbort = () => resolve({ kind: "cancelled" });
    if (parent.aborted) onAbort();
    else parent.addEventListener("abort", onAbort, { once: true });
  });
  const work = (async () => fn(controller.signal))().then(
    (value): Bounded<T> => ({ kind: "done", value }),
  );
  // If `interrupt` wins, a later rejection of `work` is expected and must not go unhandled.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, interrupt]);
  } finally {
    clearTimeout(timer);
    if (onAbort) parent.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

/** Thrown by `submit` once the scheduler's module is stopping. */
export class SchedulerStoppedError extends Error {
  override readonly name = "SchedulerStoppedError";

  constructor() {
    super("scheduler is stopped");
  }
}

/**
 * Per-lane action queues. Each lane has its own worker task that runs the lane's actions one at
 * a time, most urgent first (priority, then `created_at`, then submission order), through the
 * `PlatformSinks` service (`VoiceSink` for `speak`). Idle workers exit.
 */
export class Scheduler implements ActionSink {
  readonly #ctx: ModuleContext;
  readonly #config: SchedulerConfig;
  /** A lane is present exactly while its worker is alive. */
  readonly #lanes = new Map<LaneKey, Lane>();
  #seq = 0;

  constructor(ctx: ModuleContext, config: SchedulerConfig) {
    this.#ctx = ctx;
    this.#config = config;
  }

  activeLanes(): LaneKey[] {
    return [...this.#lanes.keys()];
  }

  /** Number of queued (not yet started) actions over all lanes. */
  queued(): number {
    let total = 0;
    for (const lane of this.#lanes.values()) total += lane.queue.length;
    return total;
  }

  async submit(action: Action): Promise<void> {
    if (this.#ctx.signal.aborted) throw new SchedulerStoppedError();
    const queued: Queued = {
      seq: this.#seq++,
      createdMs: timestampMs(action.created_at),
      action,
    };
    let replaced: Action | null = null;
    let lane = this.#lanes.get(action.lane);
    const isNew = lane === undefined;
    if (lane === undefined) {
      lane = { queue: [], wake: new Wake() };
      this.#lanes.set(action.lane, lane);
    }
    const key = action.coalesce_key;
    if (key !== null) {
      const pos = lane.queue.findIndex((q) => q.action.coalesce_key === key);
      if (pos >= 0) replaced = (lane.queue.splice(pos, 1)[0] as Queued).action;
    }
    lane.queue.push(queued);
    lane.wake.notify();
    if (isNew) {
      const laneKey = action.lane;
      const { wake } = lane;
      this.#ctx.spawn("lane", (signal) => this.#runLane(laneKey, wake, signal));
    }
    if (replaced) this.#complete(replaced, { ok: false, error: "coalesced" });
  }

  async cancelTurn(turn: TurnId): Promise<void> {
    const removed: Action[] = [];
    for (const lane of this.#lanes.values()) removed.push(...takeTurn(lane, turn));
    for (const action of removed) this.#complete(action, { ok: false, error: "cancelled" });
  }

  async #runLane(laneKey: LaneKey, wake: Wake, signal: AbortSignal): Promise<void> {
    this.#ctx.log.debug({ lane: laneKey }, "lane worker started");
    while (!signal.aborted) {
      const action = this.#pop(laneKey);
      if (action) {
        await this.#execute(action, signal);
        continue;
      }
      const result = await wake.wait(this.#config.lane_idle_ms, signal);
      if (result === "aborted") break;
      if (result === "timeout" && this.#removeIfIdle(laneKey)) {
        this.#ctx.log.debug({ lane: laneKey }, "lane worker idle, exiting");
        return;
      }
    }
    // Stopping: drop whatever is still queued in this lane.
    const leftover = this.#lanes.get(laneKey)?.queue ?? [];
    this.#lanes.delete(laneKey);
    for (const q of leftover) this.#complete(q.action, { ok: false, error: "cancelled" });
  }

  #pop(laneKey: LaneKey): Action | null {
    const queue = this.#lanes.get(laneKey)?.queue;
    if (!queue || queue.length === 0) return null;
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      if (isBefore(queue[i] as Queued, queue[best] as Queued)) best = i;
    }
    return (queue.splice(best, 1)[0] as Queued).action;
  }

  #removeIfIdle(laneKey: LaneKey): boolean {
    const lane = this.#lanes.get(laneKey);
    if (lane && lane.queue.length === 0) {
      this.#lanes.delete(laneKey);
      return true;
    }
    return false;
  }

  async #execute(action: Action, signal: AbortSignal): Promise<void> {
    if (isActionExpired(action, this.#ctx.clock.now())) {
      this.#complete(action, { ok: false, error: "expired" });
      return;
    }
    const target = this.#targetFor(action.payload);
    if (typeof target === "string") {
      this.#complete(action, { ok: false, error: target });
      return;
    }
    // Speech runs as long as playback lasts; give it more room.
    const timeoutMs =
      target.kind === "voice" ? this.#config.speak_timeout_ms : this.#config.execute_timeout_ms;
    let completion: Completion;
    try {
      const bounded = await runBounded((s) => run(target, action, s), timeoutMs, signal);
      if (bounded.kind === "done") {
        const { message, interrupted } = bounded.value;
        if (interrupted && action.turn !== null) {
          // The rest of an interrupted turn must not be spoken.
          this.#dropQueuedTurn(action.lane, action.turn);
        }
        completion = { ok: true, message };
      } else {
        completion = {
          ok: false,
          error: bounded.kind === "timeout" ? "timed out" : "cancelled",
        };
      }
    } catch (error) {
      completion = { ok: false, error: errorMessage(error) };
    }
    this.#complete(action, completion);
  }

  #dropQueuedTurn(laneKey: LaneKey, turn: TurnId): void {
    const lane = this.#lanes.get(laneKey);
    if (!lane) return;
    for (const action of takeTurn(lane, turn)) {
      this.#complete(action, { ok: false, error: "cancelled" });
    }
  }

  /** The sink for the payload, or the failure text. */
  #targetFor(payload: ActionPayload): Target | string {
    if (payload.type === "speak") {
      const voice = this.#ctx.services.get(VoiceSinkKey);
      return voice ? { kind: "voice", sink: voice } : "no voice sink";
    }
    const platform = actionPlatform(payload);
    const sink = this.#ctx.services.get(PlatformSinksKey)?.get(platform);
    return sink ? { kind: "platform", sink } : `no sink for platform ${platform}`;
  }

  #complete(action: Action, result: Completion): void {
    if (!result.ok) {
      const fields = { action: action.id, lane: action.lane, error: result.error };
      if (["expired", "cancelled", "coalesced"].includes(result.error)) {
        this.#ctx.log.debug(fields, "action dropped");
      } else {
        this.#ctx.log.warn(fields, "action failed");
      }
    }
    this.#ctx.publish(
      {
        type: "action_completed",
        data: {
          action: action.id,
          turn: action.turn,
          ok: result.ok,
          error: result.ok ? null : result.error,
          message: result.ok ? result.message : null,
        },
      },
      { turn: action.turn },
    );
  }
}

/** Removes and returns the queued actions of `turn` from `lane`. */
function takeTurn(lane: Lane, turn: TurnId): Action[] {
  const dropped: Action[] = [];
  lane.queue = lane.queue.filter((q) => {
    if (q.action.turn !== turn) return true;
    dropped.push(q.action);
    return false;
  });
  return dropped;
}

/** (priority, created_at, submission order) ordering: true when `a` runs before `b`. */
function isBefore(a: Queued, b: Queued): boolean {
  const byPriority = PRIORITY_RANK[a.action.priority] - PRIORITY_RANK[b.action.priority];
  if (byPriority !== 0) return byPriority < 0;
  if (a.createdMs !== b.createdMs) return a.createdMs < b.createdMs;
  return a.seq < b.seq;
}

async function run(target: Target, action: Action, signal: AbortSignal): Promise<Outcome> {
  const { payload } = action;
  if (target.kind === "platform") {
    switch (payload.type) {
      case "send_message": {
        const message = await target.sink.send(payload.context, payload.message, signal);
        return { message, interrupted: false };
      }
      case "react":
        await target.sink.react(payload.message, payload.emoji, signal);
        return { message: null, interrupted: false };
      case "typing":
        await target.sink.typing(payload.context, signal);
        return { message: null, interrupted: false };
      default:
        break;
    }
  } else if (payload.type === "speak") {
    const outcome = await target.sink.speak(
      payload.context,
      payload.text,
      payload.emotion,
      action.turn,
      signal,
    );
    return { message: null, interrupted: outcome === "interrupted" };
  }
  throw new Error("action payload does not match its target");
}
