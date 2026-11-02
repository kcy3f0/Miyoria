// `GameAdapter` for Minecraft on top of the bridge client.

import type { ActionResult, GameAction, GameAdapter, GameEvent, GameInfo, GameObservation } from "@miyoria/sdk";
import { ACTIONS, ActionError, describeAction, errorText, toRequests } from "./actions.js";
import { BridgeError, type BridgeClient, type BridgeEvent } from "./bridge.js";
import { type EventOptions, mapEvent } from "./events.js";
import { type Snapshot, compactState, summarize } from "./summary.js";

export const GAME_ID = "minecraft";

/** Most events buffered while nobody reads the stream (oldest dropped). */
const MAX_BUFFERED = 256;

export interface AdapterOptions extends EventOptions {
  allowCommands?: boolean;
}

/**
 * What the bot was last told to do; decides how Baritone's path events are read.
 * `null` = unknown (just connected) or nothing running.
 */
export type Task = "goto" | "baritone" | "altoclef" | null;

/** The task a successful action leaves running (`undefined` = unchanged, e.g. `chat`, `look`). */
export function taskOf(requests: ReturnType<typeof toRequests>): Task | undefined {
  let task: Task | undefined;
  for (const r of requests) {
    if (r.type === "stop") task = null;
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

  constructor(bridge: BridgeClient, opts: AdapterOptions = {}) {
    this.#bridge = bridge;
    this.#opts = opts;
    bridge.onEvent((raw) => this.#onEvent(raw));
    bridge.onStatus((hello) => {
      this.#task = null;
      if (hello) {
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
    return { id: GAME_ID, name: "Minecraft", actions: ACTIONS };
  }

  async observe(): Promise<GameObservation> {
    if (!this.#bridge.ready) {
      return { summary: `${errorText("not_connected", "")}。`, state: { connected: false } };
    }
    try {
      const snapshot = (await this.#bridge.request("observe")) as Snapshot;
      const caps = this.#bridge.hello?.capabilities;
      const state = compactState(snapshot);
      if (caps) state.capabilities = { baritone: !!caps.baritone, altoclef: !!caps.altoclef };
      return { summary: summarize(snapshot), state };
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
    let requests: ReturnType<typeof toRequests>;
    try {
      requests = toRequests(action, { allowCommands: this.#opts.allowCommands });
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
      for (const r of requests) results.push(await this.#bridge.request(r.type, r.params));
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false, message: errorText(error.code, error.message) };
      throw error;
    }
    const task = taskOf(requests);
    if (task !== undefined) this.#task = task;
    return { ok: true, message: describeAction(action), data: results.length === 1 ? results[0] : results };
  }

  events(): AsyncIterable<GameEvent> {
    return this.#queue;
  }

  /** Ends the event stream. */
  close(): void {
    this.#queue.end();
  }
}
