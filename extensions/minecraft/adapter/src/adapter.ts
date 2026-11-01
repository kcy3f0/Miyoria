// `GameAdapter` for Minecraft on top of the bridge client.

import type { ActionResult, GameAction, GameAdapter, GameEvent, GameInfo, GameObservation } from "@miyoria/sdk";
import { ACTIONS, ActionError, describeAction, errorText, toRequests } from "./actions.js";
import { BridgeError, type BridgeClient } from "./bridge.js";
import { type EventOptions, mapEvent } from "./events.js";
import { type Snapshot, compactState, summarize } from "./summary.js";

export const GAME_ID = "minecraft";

/** Most events buffered while nobody reads the stream (oldest dropped). */
const MAX_BUFFERED = 256;

export interface AdapterOptions extends EventOptions {
  allowCommands?: boolean;
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

  constructor(bridge: BridgeClient, opts: AdapterOptions = {}) {
    this.#bridge = bridge;
    this.#opts = opts;
    bridge.onEvent((raw) => {
      const e = mapEvent(raw, opts);
      if (e) this.#queue.push(e);
    });
    bridge.onStatus((hello) => {
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
