// `GameAdapter` for Minecraft on top of the bridge client.

import type { ActionResult, GameAction, GameAdapter, GameEvent, GameInfo, GameObservation } from "@miyoria/sdk";
import { ACTIONS, ActionError, describeAction, errorText, toRequests } from "./actions.js";
import { BridgeError, type BridgeClient, type BridgeEvent } from "./bridge.js";
import { type EventOptions, mapEvent } from "./events.js";
import { GUIDE } from "./guide.js";
import { LaunchError, type Launcher } from "./launcher.js";
import { ObtainRunner, type RunnerOptions, STEP_EVENTS, worldOf } from "./obtain.js";
import { PlanError, countOf, describeStep, itemName, knows, normalizeItem, plan } from "./planner.js";
import { type Snapshot, compactState, summarize } from "./summary.js";

export const GAME_ID = "minecraft";

/** Most events buffered while nobody reads the stream (oldest dropped). */
const MAX_BUFFERED = 256;

export interface AdapterOptions extends EventOptions {
  allowCommands?: boolean;
  /** Starts / closes the game (`launch` / `quit`); without it both refuse. */
  launcher?: Launcher;
  /** Timeouts of `obtain` plans (tests shorten them). */
  runner?: RunnerOptions;
  /** How long an action refused with `reflex_active` waits for the reflex to end. */
  reflexWaitMs?: number;
}

/**
 * What the bot was last told to do; decides how Baritone's path events are read.
 * `null` = unknown (just connected) or nothing running.
 */
export type Task = "goto" | "baritone" | "altoclef" | "plan" | null;

/** The task a successful action leaves running (`undefined` = unchanged, e.g. `chat`, `look`). */
export function taskOf(requests: ReturnType<typeof toRequests>): Task | undefined {
  let task: Task | undefined;
  for (const r of requests) {
    // crafting and the furnace stop Baritone first (she stands still to use them)
    if (r.type === "stop" || r.type === "craft" || r.type === "smelt") task = null;
    else if (r.type === "altoclef") task = "altoclef";
    else if (r.type === "baritone") {
      const command = r.params.command;
      task = command === "stop" || command === "cancel" ? null : command === "goto" ? "goto" : "baritone";
    }
  }
  return task;
}

/** Push queue exposed as an async iterable. */
class EventQueue implements AsyncIterable<GameEvent> {
  #items: GameEvent[] = [];
  #waiters: Array<(r: IteratorResult<GameEvent>) => void> = [];
  #ended = false;

  push(e: GameEvent): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: e, done: false });
      return;
    }
    this.#items.push(e);
    if (this.#items.length > MAX_BUFFERED) this.#items.shift();
  }

  end(): void {
    this.#ended = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<GameEvent> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export class MinecraftAdapter implements GameAdapter {
  readonly #bridge: BridgeClient;
  readonly #opts: AdapterOptions;
  readonly #queue = new EventQueue();
  #task: Task = null;
  /** The running `obtain` plan. */
  #runner: ObtainRunner | null = null;
  /** Actions waiting for an interrupting reflex to end. */
  readonly #reflexWaiters = new Set<() => void>();

  constructor(bridge: BridgeClient, opts: AdapterOptions = {}) {
    this.#bridge = bridge;
    this.#opts = opts;
    bridge.onEvent((raw) => this.#onEvent(raw));
    bridge.onStatus((hello) => {
      this.#task = null;
      this.#cancelPlan();
      if (hello) {
        opts.launcher?.connected();
        const caps = hello.capabilities ?? {};
        const tools = [caps.baritone ? "Baritone" : "", caps.altoclef ? "AltoClef" : ""].filter(Boolean).join("、");
        this.#queue.push({
          type: "connected",
          data: { ...hello, text: `連上 Minecraft ${hello.minecraft ?? ""}${tools ? `(${tools})` : ""}` },
        });
      } else {
        this.#queue.push({ type: "disconnected", data: { text: "跟 Minecraft 的連線斷了" }, important: true });
      }
    });
  }

  /** The task the adapter believes is running (for tests and debugging). */
  get task(): Task {
    return this.#task;
  }

  /**
   * Baritone fires `goal_reached` / `goal_failed` for every path segment, not only for `goto`:
   * mining walks to ore after ore, `follow` reaches its target again and again, AltoClef paths
   * between sub-tasks. Only a `goto` (or an unknown task) forwards them; otherwise they would end
   * the director's goal after the first ore. While an AltoClef task runs, Baritone also goes idle
   * between sub-tasks, so `baritone_idle` is only forwarded once AltoClef itself is idle.
   */
  #onEvent(raw: BridgeEvent): void {
    if (raw.name === "reflex_end") for (const wake of [...this.#reflexWaiters]) wake();
    const runner = this.#runner;
    if (runner) {
      runner.feed(raw);
      // The plan's own steps end with these; the director only hears about the plan.
      if (STEP_EVENTS.has(raw.name)) return;
    } else if (raw.name === "reflex" && typeof raw.data.interrupted === "string") {
      this.#task = null; // the mod stopped what Baritone was doing
    }
    const task = this.#task;
    if ((raw.name === "goal_reached" || raw.name === "goal_failed") && task !== null && task !== "goto") {
      return;
    }
    if (raw.name === "baritone_idle") {
      if (task === "altoclef" && raw.data.cancelled !== true) {
        void this.#altoClefIdle(raw);
        return;
      }
      this.#task = null;
    }
    this.#push(raw);
  }

  /** Forwards `baritone_idle` during an AltoClef task only when AltoClef is done too. */
  async #altoClefIdle(raw: BridgeEvent): Promise<void> {
    let busy: boolean | null | undefined;
    try {
      busy = ((await this.#bridge.request("observe")) as Snapshot).altoclef?.busy;
    } catch {
      busy = undefined;
    }
    if (busy === true || this.#task !== "altoclef") return;
    this.#task = null;
    // `false`: AltoClef is done. Unknown (`null`, error): forward as a plain idle, as before.
    this.#push(busy === false ? { ...raw, data: { ...raw.data, altoclef_done: true } } : raw);
  }

  #push(raw: BridgeEvent): void {
    const e = mapEvent(raw, this.#opts);
    if (e) this.#queue.push(e);
  }

  describe(): GameInfo {
    return { id: GAME_ID, name: "Minecraft", actions: ACTIONS, guide: GUIDE };
  }

  /** `state.launch` while the game is not connected: whether `launch` can start it and how far it got. */
  #launchState(): Record<string, unknown> {
    const launcher = this.#opts.launcher;
    if (!launcher) return { available: false, problem: "沒有設定啟動器" };
    const problem = launcher.problem();
    const status = launcher.status();
    return {
      available: problem === null,
      ...(problem ? { problem } : {}),
      state: status.state,
      ...(status.state === "failed" ? { error: status.error } : {}),
      ...(status.state === "starting" ? { world: status.world, timeout_secs: launcher.timeoutMs / 1000 } : {}),
    };
  }

  async observe(): Promise<GameObservation> {
    if (!this.#bridge.ready) {
      const launch = this.#launchState();
      const starting = launch.state === "starting" ? "遊戲正在用 Prism 開,等模組連上。" : "";
      return { summary: `${errorText("not_connected", "")}。${starting}`, state: { connected: false, launch } };
    }
    try {
      const snapshot = (await this.#bridge.request("observe")) as Snapshot;
      const caps = this.#bridge.hello?.capabilities;
      const state = compactState(snapshot);
      if (caps) state.capabilities = { baritone: !!caps.baritone, altoclef: !!caps.altoclef };
      let summary = summarize(snapshot);
      const runner = this.#runner;
      if (runner) {
        const p = runner.status();
        state.plan = p;
        state.busy = true;
        summary += `\n正在取得 ${itemName(p.target)}${p.count > 1 ? `×${p.count}` : ""}(第 ${p.step}/${p.total} 步${p.doing ? `:${p.doing}` : ""})`;
      }
      return { summary, state };
    } catch (error) {
      if (error instanceof BridgeError) {
        const inGame = error.code !== "not_in_game";
        return {
          summary: `${errorText(error.code, error.message)}。`,
          state: { connected: error.code !== "not_connected", in_game: inGame ? undefined : false },
        };
      }
      throw error;
    }
  }

  async act(action: GameAction): Promise<ActionResult> {
    switch (action.name) {
      case "launch":
        return this.#launch();
      case "quit":
        return this.#quit();
      case "obtain":
        return this.#obtain(action.args ?? {});
    }
    // Anything but talking replaces a running plan (she chose to do something else).
    if (action.name !== "chat") this.#cancelPlan();
    let requests: ReturnType<typeof toRequests>;
    try {
      requests = toRequests(action, {
        allowCommands: this.#opts.allowCommands,
        inventory: action.name === "mine" ? await this.#inventory() : undefined,
      });
    } catch (error) {
      if (error instanceof ActionError) return { ok: false, message: error.message };
      throw error;
    }
    const caps = this.#bridge.hello?.capabilities;
    if (caps && requests.some((r) => r.type === "baritone") && caps.baritone === false) {
      return { ok: false, message: errorText("baritone_unavailable", "") };
    }
    if (caps && requests.some((r) => r.type === "altoclef") && caps.altoclef === false) {
      return { ok: false, message: errorText("altoclef_unavailable", "") };
    }
    const results: unknown[] = [];
    try {
      for (const r of requests) results.push(await this.#request(r.type, r.params));
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false, message: errorText(error.code, error.message) };
      throw error;
    }
    const task = taskOf(requests);
    if (task !== undefined) this.#task = task;
    return { ok: true, message: describeAction(action), data: results.length === 1 ? results[0] : results };
  }

  /** A request; refused with `reflex_active` it waits for the reflex to end, then tries once more. */
  async #request(type: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    try {
      return await this.#bridge.request(type, params);
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "reflex_active") throw error;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.#reflexWaiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, this.#opts.reflexWaitMs ?? 10_000);
        this.#reflexWaiters.add(wake);
      });
      return this.#bridge.request(type, params);
    }
  }

  async #launch(): Promise<ActionResult> {
    if (this.#bridge.ready) return { ok: true, message: "Minecraft 已經開著了", data: { state: "running" } };
    const launcher = this.#opts.launcher;
    if (!launcher) return { ok: false, message: "沒有設定啟動器,沒辦法自己開遊戲" };
    try {
      const status = launcher.launch();
      const world = status.state === "starting" && status.world ? `,直接進入世界「${status.world}」` : "";
      const secs = Math.round(launcher.timeoutMs / 1000);
      return {
        ok: true,
        message: `正在用 Prism Launcher 開 ${launcher.instance()}${world};等模組連上(最多 ${secs} 秒)`,
        data: this.#launchState(),
      };
    } catch (error) {
      if (error instanceof LaunchError) return { ok: false, message: `沒辦法開遊戲:${error.message}` };
      throw error;
    }
  }

  async #quit(): Promise<ActionResult> {
    if (!this.#bridge.ready) return { ok: true, message: "遊戲本來就沒開" };
    const launcher = this.#opts.launcher;
    if (!launcher?.shouldQuit()) return { ok: true, message: "遊戲留著沒關(不是她開的,或設定不關)" };
    this.#cancelPlan();
    try {
      await this.#bridge.request("quit");
    } catch (error) {
      if (error instanceof BridgeError) {
        return { ok: false, message: `關不掉遊戲:${errorText(error.code, error.message)}` };
      }
      throw error;
    }
    launcher.quitting();
    return { ok: true, message: "關掉 Minecraft 了" };
  }

  async #obtain(args: Record<string, unknown>): Promise<ActionResult> {
    const item = normalizeItem(typeof args.item === "string" ? args.item : "");
    if (!/^#?[a-z0-9_]+$/.test(item)) return { ok: false, message: "obtain 要給 item(物品 id)" };
    if (!knows(item)) {
      return {
        ok: false,
        message: `不知道怎麼取得${itemName(item)}(只會砍樹、挖礦、合成和用熔爐燒的東西);用 craft / smelt / mine 自己做`,
      };
    }
    const n = Number(args.count ?? 1);
    const count = Math.min(64, Math.max(1, Math.round(Number.isFinite(n) ? n : 1)));
    if (!this.#bridge.ready) return { ok: false, message: errorText("not_connected", "") };
    let snapshot: Snapshot;
    try {
      snapshot = (await this.#bridge.request("observe")) as Snapshot;
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false, message: errorText(error.code, error.message) };
      throw error;
    }
    const inv = snapshot.inventory ?? {};
    const want = `${itemName(item)}${count > 1 ? `×${count}` : ""}`;
    if (countOf(inv, item) >= count) return { ok: true, message: `背包裡已經有${want}了` };
    let steps: ReturnType<typeof plan>;
    try {
      steps = plan(item, count, inv, worldOf(snapshot));
    } catch (error) {
      if (error instanceof PlanError) return { ok: false, message: error.message };
      throw error;
    }
    this.#cancelPlan();
    const runner = new ObtainRunner(
      {
        request: (type, params) => this.#bridge.request(type, params),
        observe: async () => (await this.#bridge.request("observe")) as Snapshot,
        emit: (e) => this.#queue.push(e),
      },
      item,
      count,
      this.#opts.runner,
    );
    this.#runner = runner;
    this.#task = "plan";
    void runner.run().then(
      (result) => this.#planDone(runner, result.ok, result.message, result.cancelled === true),
      (error: unknown) => this.#planDone(runner, false, `出錯了:${String(error)}`, false),
    );
    const lines = steps.map(describeStep);
    return {
      ok: true,
      message: `開始取得${want}:${lines.join(" → ")}(共 ${lines.length} 步)`,
      data: { plan: lines },
    };
  }

  #planDone(runner: ObtainRunner, ok: boolean, message: string, cancelled: boolean): void {
    if (this.#runner !== runner) return;
    this.#runner = null;
    this.#task = null;
    if (cancelled) return; // replaced by another action, or `stop`
    const data = { target: runner.item, count: runner.count, text: message };
    this.#queue.push({ type: ok ? "plan_finished" : "plan_failed", data, important: true });
  }

  #cancelPlan(): void {
    const runner = this.#runner;
    if (!runner) return;
    this.#runner = null;
    this.#task = null;
    runner.cancel();
  }

  /** The running plan (tests). */
  get plan(): ObtainRunner | null {
    return this.#runner;
  }

  /** Her inventory right now, for the `mine` tool check; `undefined` when it cannot be read. */
  async #inventory(): Promise<Record<string, number> | undefined> {
    if (!this.#bridge.ready) return undefined;
    try {
      return ((await this.#bridge.request("observe")) as Snapshot).inventory;
    } catch {
      return undefined; // the mine request itself will report what is wrong
    }
  }

  events(): AsyncIterable<GameEvent> {
    return this.#queue;
  }

  /** Ends the event stream. */
  close(): void {
    this.#cancelPlan();
    this.#queue.end();
  }
}
