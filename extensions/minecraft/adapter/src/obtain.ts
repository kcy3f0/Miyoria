// Runs an `obtain` plan step by step with the mod's ordinary requests (Baritone `mine` /
// `explore` / `goto`, `craft`, `smelt`, `place`): plan from the real inventory, do the first
// step, wait for the event that ends it, plan again. A failed step is tried once more after
// re-planning; the second failure ends the plan with the reason. A reflex that interrupts a step
// (lava, a fight...) is waited out and the step planned again, without counting as a failure.
//
// Steer (v3 §10.6): the top of each round, before it looks at the inventory and plans, is the
// safe point between two steps. A queued change of target (`item`, `count`) is read there and
// nowhere else, never in the middle of a mining or crafting job, and the next plan starts from
// whatever is already in her inventory, which is the progress that is kept.

import type { GameEvent, TaskFailureCode } from "@miyoria/sdk";
import { errorText, failureCode } from "./actions.js";
import { BridgeError, type BridgeEvent } from "./bridge.js";
import { pickaxeTier, requiredTier } from "./harvest.js";
import { zh } from "./names.js";
import {
  type Inventory,
  type KnownChest,
  PlanError,
  type Step,
  type World,
  bedOf,
  boatOf,
  countOf,
  describeStep,
  itemName,
  knows,
  members,
  normalizeItem,
  plan,
  planksOf,
  preferredY,
} from "./planner.js";
import type { Snapshot } from "./summary.js";

/** What the runner needs from the adapter. */
export interface RunnerHost {
  request(type: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  observe(): Promise<Snapshot>;
  emit(event: GameEvent): void;
  /** A queued steer was applied at a step boundary, or the plan ended before it could be. */
  steered?(steer: string, outcome: "applied" | "too_late", detail: string): void;
  /** Remembered chests near `snap` whose contents have been observed. */
  chestsFor?(snap: Snapshot): KnownChest[];
  /** Records a placed station (`crafting_table` / `furnace`) in spatial memory. */
  recordStation?(station: "crafting_table" | "furnace", snap: Snapshot): void;
  /** Records a mine entrance when falling back to underground branch mining. */
  recordMineEntrance?(snap: Snapshot): void;
  /** Syncs chest memory when a `chest` operation runs inside `obtain`. */
  onChestEvent?(name: "chest_contents" | "chest_finished", data: Record<string, unknown>): void;
}

/** What a steer of an `obtain` plan may change. */
export interface PlanPatch {
  item?: string;
  count?: number;
}

/**
 * The patch of a steer, checked: only `item` (something the planner knows how to get) and
 * `count` (1 to 64) can change in a running plan. The string is the reason it was refused.
 */
export function parsePlanPatch(patch: Record<string, unknown>): PlanPatch | string {
  const out: PlanPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "item") {
      const item = normalizeItem(typeof value === "string" ? value : "");
      if (!/^#?[a-z0-9_]+$/.test(item)) return "item 要是物品 id";
      if (!knows(item)) return `不知道怎麼取得${itemName(item)}(只會砍樹、挖礦、打獵、裝水、合成和用熔爐燒的東西)`;
      out.item = item;
    } else if (key === "count") {
      if (typeof value !== "number" || !Number.isFinite(value)) return "count 要是數字";
      out.count = Math.min(64, Math.max(1, Math.round(value)));
    } else {
      return `取得物品只能改 item 和 count,不能改 ${key}`;
    }
  }
  return out.item === undefined && out.count === undefined ? "調整是空的" : out;
}

/** A change of target waiting for the next step boundary. */
interface QueuedSteer {
  id: string;
  patch: PlanPatch;
}

export interface RunnerOptions {
  /** Longest a `mine` may run before it is stopped. */
  mineTimeoutMs?: number;
  /** Longest wait for a `craft` / `smelt` job or a `goto`. */
  jobTimeoutMs?: number;
  /** Longest wait for underground `mine_branch`. */
  branchTimeoutMs?: number;
  /** Longest wait for `clear_leaves`. */
  clearLeavesTimeoutMs?: number;
  /** Longest wait for a `hunt` step. */
  huntTimeoutMs?: number;
  /** Longest wait for a `chest` take step. */
  chestTimeoutMs?: number;
  /** How long to explore for blocks that are not in sight. */
  exploreMs?: number;
  /** Interval of the `observe` polls while exploring. */
  explorePollMs?: number;
  /** Extra wait after the furnace's `ready_in_secs` before collecting. */
  collectMarginMs?: number;
  /** Longest wait for an interrupting reflex to end. */
  reflexWaitMs?: number;
  maxSteps?: number;
}

export interface RunnerResult {
  ok: boolean;
  message: string;
  cancelled?: boolean;
  /** Why it failed (`ok: false`), as a task failure code. */
  code?: TaskFailureCode;
}

/** Legacy step events always hidden from commentary (the adapter does not forward them). */
export const STEP_EVENTS = new Set([
  "goal_reached",
  "goal_failed",
  "baritone_idle",
  "craft_finished",
  "craft_failed",
  "smelt_finished",
  "smelt_failed",
]);

/** Additional step events hidden from commentary only while an `ObtainRunner` plan owns them. */
export const RUNNER_STEP_EVENTS = new Set([
  "branch_progress",
  "branch_finished",
  "branch_failed",
  "clear_leaves_finished",
  "clear_leaves_failed",
  "hunt_finished",
  "hunt_failed",
  "chest_finished",
  "chest_failed",
]);

type Wake = BridgeEvent | "timeout" | "cancelled" | "reflex" | "reflex_pause";
type JobWake = BridgeEvent | "timeout" | "cancelled" | "reflex";
type Outcome = "done" | "progress" | "interrupted" | { fail: string; code: TaskFailureCode };

interface Waiter {
  names: Set<string>;
  resolve: (w: Wake) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Stations she can reach without placing one (any visible within the scan radius; `goto` covers the walk). */
export function worldOf(s: Snapshot, chests?: KnownChest[]): World {
  const blocks = s.nearby_blocks ?? [];
  const seen = (block: string) => blocks.some((b) => b.block === block);
  const world: World = { table: seen("crafting_table"), furnace: seen("furnace") };
  if (seen("blast_furnace")) world.blastFurnace = true;
  if (seen("smoker")) world.smoker = true;
  if (seen("water")) world.water = true;
  if (chests && chests.length > 0) world.chests = chests;
  return world;
}

/** The member of a group she has most of (`#logs` → `birch_log`), for the mod's concrete ids. */
function mostOf(inv: Inventory, group: string): string | undefined {
  let best: string | undefined;
  let most = 0;
  for (const m of members(group)) {
    const n = inv[m] ?? 0;
    if (n > most) [best, most] = [m, n];
  }
  return best;
}

export class ObtainRunner {
  #item: string;
  #count: number;
  readonly #host: RunnerHost;
  readonly #o: Required<RunnerOptions>;
  #cancelled = false;
  /** Changes of target waiting for the next step boundary, oldest first. */
  #steers: QueuedSteer[] = [];
  /** `run` has ended: a steer now comes too late. */
  #over = false;
  /** Failed steps by name (a step is tried once more after re-planning). */
  readonly #failures = new Map<string, number>();
  #waiters = new Set<Waiter>();
  #plan: Step[] = [];
  #done = 0;

  constructor(host: RunnerHost, target: string, count: number, opts: RunnerOptions = {}) {
    this.#host = host;
    this.#item = normalizeItem(target);
    this.#count = count;
    const mineTimeoutMs = opts.mineTimeoutMs ?? 240_000;
    const jobTimeoutMs = opts.jobTimeoutMs ?? 45_000;
    this.#o = {
      mineTimeoutMs,
      jobTimeoutMs,
      branchTimeoutMs: opts.branchTimeoutMs ?? mineTimeoutMs,
      clearLeavesTimeoutMs: opts.clearLeavesTimeoutMs ?? Math.min(jobTimeoutMs, 10_000),
      huntTimeoutMs: opts.huntTimeoutMs ?? Math.max(jobTimeoutMs, 0),
      chestTimeoutMs: opts.chestTimeoutMs ?? jobTimeoutMs,
      exploreMs: opts.exploreMs ?? 90_000,
      explorePollMs: opts.explorePollMs ?? 5_000,
      collectMarginMs: opts.collectMarginMs ?? 1_500,
      reflexWaitMs: opts.reflexWaitMs ?? 60_000,
      maxSteps: opts.maxSteps ?? 40,
    };
  }

  get item(): string {
    return this.#item;
  }

  get count(): number {
    return this.#count;
  }

  /**
   * Queues a change of target (`patch` from `parsePlanPatch`) for the next step boundary.
   * `too_late`: the plan already ended. Nothing runs here: the plan reads it between steps.
   */
  steer(id: string, patch: PlanPatch): "queued" | "too_late" {
    if (this.#over || this.#cancelled) return "too_late";
    this.#steers.push({ id, patch });
    return "queued";
  }

  /** Reads the queued changes: the one place a running plan's target changes. */
  #applySteers(): void {
    const queued = this.#steers.splice(0);
    for (const { id, patch } of queued) {
      if (patch.item !== undefined) this.#item = patch.item;
      if (patch.count !== undefined) this.#count = patch.count;
      // The new target may need steps the old one did not, and a failed step was another plan's.
      this.#failures.clear();
      const want = this.#want();
      this.#event("plan_steered", `改成取得${want}`);
      this.#host.steered?.(id, "applied", `目標改成${want},已有的東西照算`);
    }
  }

  #want(): string {
    return `${itemName(this.#item)}${this.#count > 1 ? `×${this.#count}` : ""}`;
  }

  /** Progress for `observe`. */
  status(): { target: string; count: number; step: number; total: number; doing: string | null } {
    const current = this.#plan[0];
    return {
      target: this.item,
      count: this.count,
      step: this.#done + 1,
      total: this.#done + this.#plan.length,
      doing: current ? describeStep(current) : null,
    };
  }

  /** Stops after the current request; `run` resolves with `cancelled`. */
  cancel(): void {
    this.#cancelled = true;
    for (const w of [...this.#waiters]) this.#wake(w, "cancelled");
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  /** A mod event; ends the wait it belongs to. */
  feed(e: BridgeEvent): void {
    if (e.name === "chest_contents" || e.name === "chest_finished") {
      this.#host.onChestEvent?.(e.name, e.data);
    }
    if (e.name === "reflex") {
      const recoverable = e.data.recoverable === true || e.data.paused_task === true;
      const interrupting = !recoverable && typeof e.data.interrupted === "string";
      for (const w of [...this.#waiters]) {
        if (recoverable && w.names.has("reflex_pause")) this.#wake(w, "reflex_pause");
        else if (interrupting && w.names.has("reflex")) this.#wake(w, "reflex");
      }
      return;
    }
    for (const w of [...this.#waiters]) {
      if (w.names.has(e.name)) this.#wake(w, e);
    }
  }

  #wake(w: Waiter, value: Wake): void {
    if (!this.#waiters.delete(w)) return;
    clearTimeout(w.timer);
    w.resolve(value);
  }

  /** Starts waiting for one of `names` (register before sending the request that causes it). */
  #wait(names: string[], ms: number): { done: Promise<Wake>; cancel: () => void } {
    let waiter!: Waiter;
    const done = new Promise<Wake>((resolve) => {
      waiter = { names: new Set(names), resolve, timer: setTimeout(() => this.#wake(waiter, "timeout"), ms) };
    });
    if (this.#cancelled) {
      waiter.resolve("cancelled");
      clearTimeout(waiter.timer);
    } else {
      this.#waiters.add(waiter);
    }
    return { done, cancel: () => this.#wake(waiter, "cancelled") };
  }

  async #sleep(ms: number): Promise<boolean> {
    const w = this.#wait([], ms);
    return (await w.done) === "timeout";
  }

  #event(type: string, text: string, data: Record<string, unknown> = {}, important = false): void {
    this.#host.emit({ type, data: { target: this.#item, count: this.#count, ...data, text }, important });
  }

  async run(): Promise<RunnerResult> {
    try {
      return await this.#run();
    } finally {
      this.#over = true;
      // A change that never reached a step boundary is too late: the plan is over.
      for (const { id } of this.#steers.splice(0)) {
        this.#host.steered?.(id, "too_late", "取得結束了,調整沒有機會生效");
      }
    }
  }

  async #run(): Promise<RunnerResult> {
    const failures = this.#failures;
    try {
      for (let i = 0; i < this.#o.maxSteps; i++) {
        if (this.#cancelled) return { ok: false, message: "被叫停了", cancelled: true };
        // The safe point: between two steps, nothing is running.
        this.#applySteers();
        const want = this.#want();
        const snap = await this.#host.observe();
        const inv = snap.inventory ?? {};
        if (countOf(inv, this.item) >= this.count) {
          this.#plan = [];
          return { ok: true, message: `拿到${want}了` };
        }
        this.#plan = plan(this.item, this.count, inv, worldOf(snap, this.#host.chestsFor?.(snap)));
        const step = this.#plan[0];
        if (!step) return { ok: true, message: `拿到${want}了` };
        const total = this.#done + this.#plan.length;
        this.#event("plan_step", `取得${want}:第 ${this.#done + 1}/${total} 步,${describeStep(step)}`, {
          step: this.#done + 1,
          total,
          doing: describeStep(step),
        });
        const outcome = await this.#execute(step, snap);
        if (this.#cancelled) return { ok: false, message: "被叫停了", cancelled: true };
        if (outcome === "done") {
          this.#done++;
          failures.clear();
        } else if (typeof outcome === "object") {
          const key = describeStep(step);
          const n = (failures.get(key) ?? 0) + 1;
          failures.set(key, n);
          if (n >= 2) return { ok: false, message: `取得${want}失敗,卡在「${key}」:${outcome.fail}`, code: outcome.code };
        }
      }
      return { ok: false, message: `取得${this.#want()}的步驟太多了,停下來`, code: "internal" };
    } catch (error) {
      if (error instanceof PlanError) return { ok: false, message: error.message, code: "precondition" };
      if (error instanceof BridgeError) {
        return { ok: false, message: errorText(error.code, error.message), code: failureCode(error.code) };
      }
      throw error;
    }
  }

  /** Sends one request; a `reflex_active` refusal waits the reflex out and sends it again. */
  async #send(type: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await this.#host.request(type, params);
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "reflex_active") throw error;
      await this.#reflexEnd();
      return this.#host.request(type, params);
    }
  }

  async #reflexEnd(): Promise<void> {
    await this.#wait(["reflex_end"], this.#o.reflexWaitMs).done;
  }

  /** Waits out a recoverable reflex pause until resumed, aborted, or finished. */
  async #waitRecoverable(names: string[]): Promise<JobWake | "resumed" | "aborted"> {
    const first = await this.#wait(["reflex_resumed", "reflex_aborted", "reflex_end", ...names], this.#o.reflexWaitMs)
      .done;
    if (first === "cancelled") return "cancelled";
    if (first === "timeout") return "aborted";
    if (typeof first === "object") {
      if (first.name === "reflex_resumed") return "resumed";
      if (first.name === "reflex_aborted") return "aborted";
      if (first.name === "reflex_end") {
        if (first.data.resumed === true) return "resumed";
        if (first.data.aborted === true) return "aborted";
        // Give same-tick `reflex_resumed` a brief window if `reflex_end` fired first.
        const next = await this.#wait(
          ["reflex_resumed", "reflex_aborted", ...names],
          Math.min(50, this.#o.reflexWaitMs),
        ).done;
        if (typeof next === "object") {
          if (next.name === "reflex_resumed") return "resumed";
          if (next.name === "reflex_aborted") return "aborted";
          return next;
        }
        return next === "cancelled" ? "cancelled" : "aborted";
      }
      return first;
    }
    return "aborted";
  }

  /** Sends a request and waits for one of `names`; reflex pauses wait to resume cleanly. */
  async #job(type: string, params: Record<string, unknown>, names: string[], ms: number): Promise<JobWake> {
    let w = this.#wait([...names, "reflex", "reflex_pause"], ms);
    try {
      await this.#send(type, params);
    } catch (error) {
      w.cancel();
      throw error;
    }
    while (true) {
      const wake = await w.done;
      if (wake === "reflex") {
        await this.#reflexEnd();
        return "reflex";
      }
      if (wake === "reflex_pause") {
        const res = await this.#waitRecoverable(names);
        if (res === "resumed") {
          w = this.#wait([...names, "reflex", "reflex_pause"], ms);
          continue;
        }
        if (res === "aborted") return "reflex";
        if (typeof res === "object" && res.data.cancelled === true) return "cancelled";
        return res;
      }
      // A job stopped from outside (a reflex took over, `stop`) is not the step failing.
      if (typeof wake === "object" && wake.data.cancelled === true) return "cancelled";
      return wake;
    }
  }

  async #execute(step: Step, snap: Snapshot): Promise<Outcome> {
    try {
      switch (step.kind) {
        case "mine":
          return await this.#mine(step, snap);
        case "craft":
          return await this.#craft(step, snap);
        case "smelt":
          return await this.#smelt(step, snap);
        case "place":
          await this.#send("place", { item: step.item });
          this.#host.recordStation?.(step.item, snap);
          return "done";
        case "hunt":
          return await this.#hunt(step, snap);
        case "fill_water":
          return await this.#fillWater(snap);
        case "chest_take":
          return await this.#chestTake(step, snap);
      }
    } catch (error) {
      if (error instanceof BridgeError) return { fail: errorText(error.code, error.message), code: failureCode(error.code) };
      throw error;
    }
  }

  async #tryMineVisible(step: Extract<Step, { kind: "mine" }>, before: number): Promise<Outcome> {
    // Baritone's count is the total of the blocks' drops in her inventory.
    const params = { command: "mine", blocks: step.blocks, count: before + step.count };
    let wake: JobWake;
    try {
      wake = await this.#job("baritone", params, ["baritone_idle"], this.#o.mineTimeoutMs);
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      if (error.code === "too_far") {
        const block = /nearest (\S+) in sight/.exec(error.message)?.[1];
        return block && (await this.#goto(block)) ? "progress" : { fail: errorText(error.code, error.message), code: "unreachable" };
      }
      throw error;
    }
    if (wake === "reflex") return "interrupted";
    if (wake === "timeout") {
      await this.#host.request("stop").catch(() => undefined);
      return { fail: `挖${itemName(step.item)}挖太久了`, code: "timeout" };
    }
    if (wake === "cancelled") return "interrupted";
    const after = countOf((await this.#host.observe()).inventory ?? {}, step.item);
    if (after >= before + step.count) return "done";
    return after > before ? "progress" : { fail: `沒挖到${itemName(step.item)}`, code: "not_found" };
  }

  async #clearLeaves(): Promise<"cleared" | "none" | "interrupted"> {
    let w = this.#wait(
      ["clear_leaves_finished", "clear_leaves_failed", "reflex", "reflex_pause"],
      this.#o.clearLeavesTimeoutMs,
    );
    let res: Record<string, unknown>;
    try {
      res = await this.#send("clear_leaves", { radius: 5, max_blocks: 24 });
    } catch (error) {
      w.cancel();
      if (error instanceof BridgeError && (error.code === "unknown_type" || error.code === "invalid_args")) {
        return "none";
      }
      throw error;
    }
    if (res.skipped === true) {
      w.cancel();
      return "none";
    }
    if (typeof res.cleared === "number") {
      w.cancel();
      return res.cleared > 0 ? "cleared" : "none";
    }
    while (true) {
      const wake = await w.done;
      if (wake === "reflex") {
        await this.#reflexEnd();
        return "interrupted";
      }
      if (wake === "reflex_pause") {
        const recovered = await this.#waitRecoverable(["clear_leaves_finished", "clear_leaves_failed"]);
        if (recovered === "resumed") {
          w = this.#wait(
            ["clear_leaves_finished", "clear_leaves_failed", "reflex", "reflex_pause"],
            this.#o.clearLeavesTimeoutMs,
          );
          continue;
        }
        if (recovered === "aborted" || recovered === "cancelled" || recovered === "timeout") return "interrupted";
        if (typeof recovered === "object") {
          if (recovered.name === "clear_leaves_failed") return "none";
          return recovered.data.cleared === 0 ? "none" : "cleared";
        }
        return "interrupted";
      }
      if (wake === "cancelled") return "interrupted";
      if (wake === "timeout") return "none";
      if (wake.name === "clear_leaves_failed") return "none";
      return wake.data.cleared === 0 ? "none" : "cleared";
    }
  }

  async #branchMine(
    step: Extract<Step, { kind: "mine" }>,
    targetY: number,
    before: number,
  ): Promise<Outcome | "unsupported"> {
    let wake: JobWake;
    try {
      wake = await this.#job(
        "mine_branch",
        { target_y: targetY, ores: step.blocks, max_steps: 64, torch_interval: 8 },
        ["branch_finished", "branch_failed"],
        this.#o.branchTimeoutMs,
      );
    } catch (error) {
      if (error instanceof BridgeError && error.code === "unknown_type") return "unsupported";
      throw error;
    }
    if (wake === "reflex" || wake === "cancelled") return "interrupted";
    if (wake === "timeout") {
      await this.#host.request("stop").catch(() => undefined);
      return { fail: `分支採礦找${itemName(step.item)}挖太久了`, code: "timeout" };
    }
    if (wake.name === "branch_failed") {
      return { fail: String(wake.data.error ?? `分支採礦沒找到${itemName(step.item)}`), code: "not_found" };
    }
    const mid = countOf((await this.#host.observe()).inventory ?? {}, step.item);
    if (mid >= before + step.count) return "done";
    // Finish mining any exposed ore vein left in sight by branch mining.
    try {
      const vein = await this.#tryMineVisible(step, before);
      if (vein === "done" || vein === "progress" || vein === "interrupted") return vein;
    } catch (error) {
      if (!(error instanceof BridgeError && error.code === "not_visible")) throw error;
    }
    return mid > before
      ? "progress"
      : { fail: `分支採礦到 Y=${targetY} 還是沒找到足夠的${itemName(step.item)}`, code: "not_found" };
  }

  async #mine(step: Extract<Step, { kind: "mine" }>, snap: Snapshot): Promise<Outcome> {
    const before = countOf(snap.inventory ?? {}, step.item);
    // Stage 1: mine visible blocks; for logs blocked by canopy leaves, clear leaves and retry once.
    try {
      const first = await this.#tryMineVisible(step, before);
      if (first === "done" || first === "progress" || first === "interrupted") return first;
      if (step.item === "#logs") {
        const cleared = await this.#clearLeaves();
        if (cleared === "interrupted") return "interrupted";
        if (cleared === "cleared") {
          try {
            return await this.#tryMineVisible(step, before);
          } catch (error) {
            if (!(error instanceof BridgeError && error.code === "not_visible")) throw error;
          }
        }
      }
      return first;
    } catch (error) {
      if (!(error instanceof BridgeError && error.code === "not_visible")) throw error;
    }

    if (step.item === "#logs") {
      const cleared = await this.#clearLeaves();
      if (cleared === "interrupted") return "interrupted";
      if (cleared === "cleared") {
        try {
          return await this.#tryMineVisible(step, before);
        } catch (error) {
          if (!(error instanceof BridgeError && error.code === "not_visible")) throw error;
        }
      }
    }

    // Stage 2: explore surface or cave surroundings for visible targets.
    if (await this.#explore(step.blocks)) return "progress";

    // Stage 3: underground ore branch-mining fallback in the Overworld when pickaxe tier suffices.
    const targetY = step.preferredY ?? preferredY(step.item);
    const inOverworld = !snap.dimension || snap.dimension === "overworld";
    const needTier = Math.max(...step.blocks.map(requiredTier));
    if (targetY !== undefined && inOverworld && pickaxeTier(snap.inventory ?? {}) >= needTier) {
      this.#host.recordMineEntrance?.(snap);
      const branch = await this.#branchMine(step, targetY, before);
      if (branch !== "unsupported") return branch;
    }

    return {
      fail: `附近看不到${step.blocks.map(zh).join("、")},探索了 ${Math.round(this.#o.exploreMs / 1000)} 秒也沒找到(去洞穴、山壁或地表其他地方找找)`,
      code: "not_found",
    };
  }

  /** Explores until one of `targets` comes into sight; false when the time runs out. */
  async #explore(targets: string[], matchEntity = false): Promise<boolean> {
    await this.#send("baritone", { command: "explore" });
    const end = Date.now() + this.#o.exploreMs;
    while (Date.now() < end) {
      if (!(await this.#sleep(this.#o.explorePollMs))) return false;
      const snap = await this.#host.observe();
      const found = matchEntity
        ? (snap.nearby_entities ?? []).some((e) => targets.includes(e.type))
        : (snap.nearby_blocks ?? []).some((b) => targets.includes(b.block));
      if (found) {
        await this.#host.request("stop").catch(() => undefined);
        return true;
      }
    }
    await this.#host.request("stop").catch(() => undefined);
    return false;
  }

  async #goto(block: string): Promise<boolean> {
    const wake = await this.#job(
      "baritone",
      { command: "goto", block },
      ["goal_reached", "goal_failed", "baritone_idle"],
      this.#o.jobTimeoutMs,
    );
    return typeof wake === "object" && wake.name !== "goal_failed";
  }

  async #gotoPos(x: number, y: number, z: number, near = 3): Promise<boolean> {
    const wake = await this.#job(
      "baritone",
      { command: "goto", x: Math.round(x), y: Math.round(y), z: Math.round(z), near },
      ["goal_reached", "goal_failed", "baritone_idle"],
      this.#o.jobTimeoutMs,
    );
    return typeof wake === "object" && wake.name !== "goal_failed";
  }

  /** Walks to (or puts down) the station after `too_far` / `needs_station`; false when it cannot. */
  async #station(error: BridgeError, station: "crafting_table" | "furnace", inv: Inventory): Promise<boolean> {
    if (error.code === "too_far") {
      const nearest = /nearest (\S+) in sight/.exec(error.message)?.[1];
      return this.#goto(nearest ?? station);
    }
    if (error.code === "needs_station" && (inv[station] ?? 0) > 0) {
      await this.#send("place", { item: station });
      return true;
    }
    return false;
  }

  #concreteCraftItem(stepItem: string, inv: Inventory): { item?: string; fail?: string } {
    if (stepItem === "#planks") {
      const log = mostOf(inv, "#logs");
      const item = log ? planksOf(log) : undefined;
      return item ? { item } : { fail: "沒有原木可以做木材" };
    }
    if (stepItem === "#boats") {
      const best = members("#planks")
        .filter((p) => (inv[p] ?? 0) >= 5)
        .sort((a, b) => (inv[b] ?? 0) - (inv[a] ?? 0))[0];
      const planks = best ?? mostOf(inv, "#planks");
      const item = planks ? boatOf(planks) : undefined;
      return item ? { item } : { fail: "沒有足夠同一種木材可以做木船" };
    }
    if (stepItem === "#beds") {
      const best = members("#wool")
        .filter((w) => (inv[w] ?? 0) >= 3)
        .sort((a, b) => (inv[b] ?? 0) - (inv[a] ?? 0))[0];
      const wool = best ?? mostOf(inv, "#wool");
      const item = wool ? bedOf(wool) : undefined;
      return item ? { item } : { fail: "沒有足夠同色羊毛可以做床" };
    }
    return { item: stepItem };
  }

  async #craft(step: Extract<Step, { kind: "craft" }>, snap: Snapshot): Promise<Outcome> {
    const inv = snap.inventory ?? {};
    const resolved = this.#concreteCraftItem(step.item, inv);
    if (!resolved.item) return { fail: resolved.fail ?? "材料不夠", code: "precondition" };
    const item = resolved.item;
    const count = Math.min(64, step.count);
    for (let tries = 0; tries < 3; tries++) {
      let wake: JobWake;
      try {
        wake = await this.#job("craft", { item, count }, ["craft_finished", "craft_failed"], this.#o.jobTimeoutMs);
      } catch (error) {
        if (error instanceof BridgeError && (await this.#station(error, "crafting_table", inv))) continue;
        throw error;
      }
      if (wake === "reflex" || wake === "cancelled") return "interrupted";
      if (wake === "timeout") return { fail: `做${itemName(step.item)}沒有回應`, code: "timeout" };
      if (wake.name === "craft_failed") return { fail: String(wake.data.error ?? "合成失敗"), code: "precondition" };
      const made = typeof wake.data.crafted === "number" ? wake.data.crafted : count;
      if (made <= 0) return { fail: "材料不夠", code: "precondition" };
      // Fewer than asked (one kind of log ran out, a stack over 64): the next plan does the rest.
      return made >= step.count ? "done" : "progress";
    }
    return { fail: `走不到工作台旁邊做${itemName(step.item)}`, code: "unreachable" };
  }

  async #hunt(step: Extract<Step, { kind: "hunt" }>, snap: Snapshot): Promise<Outcome> {
    const before = countOf(snap.inventory ?? {}, step.item);
    let wake: JobWake;
    try {
      wake = await this.#job(
        "hunt",
        { entity: step.entity, count: step.count, range: 32 },
        ["hunt_finished", "hunt_failed"],
        this.#o.huntTimeoutMs,
      );
    } catch (error) {
      if (error instanceof BridgeError && error.code === "not_visible") {
        return (await this.#explore([step.entity], true))
          ? "progress"
          : { fail: `附近找不到${zh(step.entity)}可以取得${itemName(step.item)}`, code: "not_found" };
      }
      throw error;
    }
    if (wake === "reflex" || wake === "cancelled") return "interrupted";
    if (wake === "timeout") {
      await this.#host.request("stop").catch(() => undefined);
      return { fail: `打獵${zh(step.entity)}打太久了`, code: "timeout" };
    }
    if (wake.name === "hunt_failed") {
      const err = String(wake.data.error ?? "");
      if (/not_visible|none|no .* nearby|找不到/i.test(err)) {
        if (await this.#explore([step.entity], true)) return "progress";
      }
      return { fail: err || `打獵${zh(step.entity)}失敗`, code: "not_found" };
    }
    const after = countOf((await this.#host.observe()).inventory ?? {}, step.item);
    if (after >= before + step.count) return "done";
    if (after > before) return "progress";
    const collected = typeof wake.data.collected === "number" ? wake.data.collected : 0;
    return collected >= step.count
      ? "done"
      : collected > 0
        ? "progress"
        : { fail: `沒打到${itemName(step.item)}`, code: "not_found" };
  }

  async #fillWater(snap: Snapshot): Promise<Outcome> {
    const before = countOf(snap.inventory ?? {}, "water_bucket");
    let waterBlock = (snap.nearby_blocks ?? []).find((b) => b.block === "water");
    if (!waterBlock) {
      if (await this.#explore(["water"])) return "progress";
      return { fail: "附近找不到水可以裝水桶", code: "not_found" };
    }
    if (waterBlock.distance !== undefined && waterBlock.distance > 4) {
      const walked = waterBlock.nearest
        ? await this.#gotoPos(waterBlock.nearest.x, waterBlock.nearest.y, waterBlock.nearest.z, 3)
        : await this.#goto("water");
      if (!walked) return { fail: "走不到水邊裝水", code: "unreachable" };
      const fresh = await this.#host.observe();
      waterBlock = (fresh.nearby_blocks ?? []).find((b) => b.block === "water") ?? waterBlock;
    }
    await this.#send("select_slot", { item: "bucket" });
    if (waterBlock.nearest) await this.#send("look", { at: waterBlock.nearest });
    await this.#send("use", {});
    const after = countOf((await this.#host.observe()).inventory ?? {}, "water_bucket");
    return after > before ? "done" : { fail: "沒有成功裝到水桶", code: "precondition" };
  }

  async #chestTake(step: Extract<Step, { kind: "chest_take" }>, snap: Snapshot): Promise<Outcome> {
    const before = countOf(snap.inventory ?? {}, step.item);
    for (let tries = 0; tries < 2; tries++) {
      let wake: JobWake;
      try {
        wake = await this.#job(
          "chest",
          { op: "take", items: { [step.item]: step.count }, position: step.chest },
          ["chest_finished", "chest_failed"],
          this.#o.chestTimeoutMs,
        );
      } catch (error) {
        if (error instanceof BridgeError && error.code === "too_far") {
          if (await this.#gotoPos(step.chest.x, step.chest.y, step.chest.z, 3)) continue;
          return { fail: "走不到箱子旁邊拿東西", code: "unreachable" };
        }
        throw error;
      }
      if (wake === "reflex" || wake === "cancelled") return "interrupted";
      if (wake === "timeout") return { fail: `開箱拿${itemName(step.item)}沒有回應`, code: "timeout" };
      if (wake.name === "chest_failed") {
        return { fail: String(wake.data.error ?? "從箱子拿東西失敗"), code: "precondition" };
      }
      this.#host.onChestEvent?.("chest_finished", { position: step.chest, ...wake.data });
      const after = countOf((await this.#host.observe()).inventory ?? {}, step.item);
      if (after >= before + step.count) return "done";
      return after > before ? "progress" : { fail: `箱子裡沒拿到${itemName(step.item)}`, code: "not_found" };
    }
    return { fail: "走不到箱子旁邊拿東西", code: "unreachable" };
  }

  async #smelt(step: Extract<Step, { kind: "smelt" }>, snap: Snapshot): Promise<Outcome> {
    const inv = snap.inventory ?? {};
    const input = step.input.startsWith("#") ? mostOf(inv, step.input) : step.input;
    if (!input) return { fail: `沒有${itemName(step.input)}可以燒`, code: "precondition" };
    const target = countOf(inv, step.item) + step.count;
    let ready = step.count * 10;
    for (let tries = 0; ; tries++) {
      if (tries >= 3) return { fail: "一直放不進熔爐", code: "internal" };
      let wake: JobWake;
      try {
        wake = await this.#job(
          "smelt",
          { item: input, count: Math.min(64, step.count) },
          ["smelt_finished", "smelt_failed"],
          this.#o.jobTimeoutMs,
        );
      } catch (error) {
        if (error instanceof BridgeError && (await this.#station(error, "furnace", inv))) continue;
        throw error;
      }
      if (wake === "reflex" || wake === "cancelled") return "interrupted";
      if (wake === "timeout") return { fail: "熔爐沒有回應", code: "timeout" };
      if (wake.name === "smelt_failed") return { fail: String(wake.data.error ?? "熔爐出錯"), code: "precondition" };
      if (typeof wake.data.ready_in_secs === "number") ready = wake.data.ready_in_secs;
      break;
    }
    // The furnace keeps burning with its screen closed; come back to take the output.
    for (let i = 0; i < step.count + 3; i++) {
      if (!(await this.#sleep(ready * 1000 + this.#o.collectMarginMs))) return "interrupted";
      let wake: JobWake;
      try {
        wake = await this.#job("smelt", {}, ["smelt_finished", "smelt_failed"], this.#o.jobTimeoutMs);
      } catch (error) {
        if (error instanceof BridgeError && (await this.#station(error, "furnace", inv))) continue;
        throw error;
      }
      if (wake === "reflex" || wake === "cancelled") return "interrupted";
      if (typeof wake === "object" && wake.name === "smelt_failed") {
        return { fail: String(wake.data.error ?? "熔爐出錯"), code: "precondition" };
      }
      if (countOf((await this.#host.observe()).inventory ?? {}, step.item) >= target) return "done";
      ready = 10;
    }
    return { fail: `${itemName(step.item)}一直燒不好`, code: "timeout" };
  }
}
