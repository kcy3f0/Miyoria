// osu! game adapter (docs/ARCHITECTURE.md §12.3): the director plays maps through the AI player and gets its
// game events for commentary. The AI plays on its own account, so a lazer client that spectates that account
// is the stream's game picture.

import type {
  ActionResult,
  GameAction,
  GameAdapter,
  GameEvent,
  GameInfo,
  GameObservation,
} from "@miyoria/sdk";
import type { Call } from "./client.js";

export const GAME_ID = "osu";
const LEVELS = ["easy", "normal", "hard", "expert"];
/** A combo break from at least this combo is worth commentary. */
const BIG_COMBO = 100;
const POLL_WAIT_SECS = 25;
const RETRY_MS = 5_000;

type Json = Record<string, unknown>;

const INFO: GameInfo = {
  id: GAME_ID,
  name: "osu!",
  actions: [
    {
      name: "play",
      description: "打一張譜(單人),直播畫面會看到。要準備 10–40 秒,打完會有 finished 事件",
      parameters: {
        type: "object",
        properties: {
          beatmap_id: { type: "integer", description: "譜面(難度)在 osu! 伺服器上的 id" },
          level: { type: "string", enum: LEVELS },
          mods: { type: "array", items: { type: "string" }, description: 'mod 縮寫,例如 ["HD"]' },
        },
        required: ["beatmap_id"],
      },
    },
    { name: "stop", description: "停止正在打的譜" },
    {
      name: "set_level",
      description: "換強度,下一張譜開始生效",
      parameters: {
        type: "object",
        properties: { level: { type: "string", enum: LEVELS } },
        required: ["level"],
      },
    },
    {
      name: "join_room",
      description: "進一間多人房跟大家一起打(在房間裡就不能單人打譜)",
      parameters: {
        type: "object",
        properties: { room_id: { type: "integer" }, password: { type: "string" } },
        required: ["room_id"],
      },
    },
    { name: "leave_room", description: "離開多人房" },
  ],
  prompt:
    "妳玩 osu! 的方式:妳的 AI 分身(強化學習模型)用妳的 osu! 帳號打譜,妳負責選譜、決定強度和實況。打譜的過程妳控制不了,只能看著它打。",
  guide:
    "打完一張(finished)再選下一張;正在打的時候不要再下 play。觀眾點的譜優先。強度:easy 約 72%、normal 約 97%、hard 約 98%、expert 約 99% 準度。",
};

function song(d: Json): string {
  const artist = typeof d.artist === "string" && d.artist ? `${d.artist} - ` : "";
  const version = typeof d.version === "string" && d.version ? ` [${d.version}]` : "";
  return `${artist}${String(d.title ?? d.beatmap_id ?? "?")}${version}`;
}

function pct(x: unknown): string {
  return `${(Number(x) * 100).toFixed(2)}%`;
}

/**
 * live.service event -> game event (text for commentary, importance). A finished map is the director's
 * `goal_reached` and a stopped or failed one its `goal_failed`, so `[modules.game]` needs no osu entries;
 * `data.type` keeps the service's own name.
 */
export function mapEvent(e: Json): GameEvent | null {
  const { type } = e;
  switch (type) {
    case "preparing":
      return { type, data: { ...e, text: `準備打 ${song(e)}(${String(e.level)})` } };
    case "started":
      return { type, data: { ...e, text: `開始打 ${song(e)}` }, important: true };
    case "combo_break": {
      const combo = Number(e.combo);
      return {
        type,
        data: {
          ...e,
          text: `${combo} combo 斷了(miss ${String(e.misses)},準度 ${pct(e.accuracy)})`,
        },
        important: combo >= BIG_COMBO,
      };
    }
    case "finished": {
      const fc = e.full_combo === true ? ",FC!" : `,miss ${String(e.misses)}`;
      const text = `打完 ${song(e)}:${pct(e.accuracy)} ${String(e.rank)}${fc}`;
      return { type: "goal_reached", data: { ...e, text }, important: true };
    }
    case "aborted":
      return { type: "goal_failed", data: { ...e, text: "中途停下來了" }, important: true };
    case "error":
      return {
        type: "goal_failed",
        data: { ...e, text: `出錯了:${String(e.message)}` },
        important: true,
      };
    default:
      return null;
  }
}

/** Short text of the AI's status for the model. */
export function summarize(s: Json): string {
  const now = s.now as Json | null;
  if (now) {
    return `正在打 ${song(now)}(${String(now.level)}):進度 ${Math.round(Number(now.progress) * 100)}%,combo ${String(now.combo)},準度 ${pct(now.accuracy)},miss ${String(now.misses)}`;
  }
  const where = s.room
    ? `在多人房 ${String(s.room)}`
    : s.playing === true
      ? "正在準備下一張譜(10–40 秒)"
      : "沒在打譜";
  const last = s.last_result as Json | null;
  const prev = last ? `;上一張 ${pct(last.accuracy)} ${String(last.rank)}` : "";
  return `${where},強度 ${String(s.level)}${prev}`;
}

/** Push queue exposed as an async iterable. */
class EventQueue implements AsyncIterable<GameEvent> {
  #items: GameEvent[] = [];
  #waiters: Array<(r: IteratorResult<GameEvent>) => void> = [];
  #ended = false;

  push(e: GameEvent): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: e, done: false });
    else this.#items.push(e);
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

export class OsuAdapter implements GameAdapter {
  readonly #call: Call;
  readonly #queue = new EventQueue();
  #closed = false;

  constructor(call: Call) {
    this.#call = call;
  }

  describe(): GameInfo {
    return INFO;
  }

  async observe(): Promise<GameObservation> {
    const r = await this.#call("GET", "/status");
    if (!r.ok)
      return {
        summary: `看不到 osu! AI 的狀態:${String(r.data.error)}`,
        state: { connected: false },
      };
    return { summary: summarize(r.data), state: { connected: true, ...r.data } };
  }

  async act(action: GameAction): Promise<ActionResult> {
    const a = action.args ?? {};
    const route: Record<string, [string, unknown]> = {
      play: [
        "/solo",
        {
          beatmap_id: a.beatmap_id,
          level: a.level,
          mods: Array.isArray(a.mods)
            ? a.mods.map((m) => ({ acronym: String(m).toUpperCase() }))
            : [],
        },
      ],
      stop: ["/stop", {}],
      set_level: ["/level", { level: a.level }],
      join_room: ["/join", { room_id: a.room_id, password: a.password }],
      leave_room: ["/leave", {}],
    };
    const target = route[action.name];
    if (!target) return { ok: false, message: `沒有「${action.name}」這個動作` };
    const r = await this.#call("POST", target[0], target[1]);
    return r.ok
      ? { ok: true, message: summarize(r.data) }
      : { ok: false, message: String(r.data.error) };
  }

  events(): AsyncIterable<GameEvent> {
    return this.#queue;
  }

  /** Long-polls live.service for events until closed; reports losing and regaining the service. */
  async pump(): Promise<void> {
    let after: number | null = null;
    let connected: boolean | null = null;
    while (!this.#closed) {
      const r = await this.#call(
        "GET",
        `/events?after=${after ?? 0}&wait=${after === null ? 0 : POLL_WAIT_SECS}`,
        undefined,
        (POLL_WAIT_SECS + 10) * 1000,
      );
      if (this.#closed) break;
      if (!r.ok) {
        if (connected !== false) {
          this.#queue.push({
            type: "disconnected",
            data: { text: "osu! AI 服務連不上" },
            important: true,
          });
          connected = false;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        continue;
      }
      if (connected !== true) {
        if (connected === false)
          this.#queue.push({ type: "connected", data: { text: "osu! AI 服務連上了" } });
        connected = true;
      }
      const events = (r.data.events as Json[] | undefined) ?? [];
      // the first poll only learns where the service is, so old events are not replayed
      if (after !== null) {
        for (const e of events) {
          const mapped = mapEvent(e);
          if (mapped) this.#queue.push(mapped);
        }
      }
      after = Number(r.data.last ?? after ?? 0);
    }
  }

  close(): void {
    this.#closed = true;
    this.#queue.end();
  }
}
