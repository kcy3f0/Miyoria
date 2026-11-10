// The method guard (docs/design/v4-plan.md §11.2 item 5): the same method failing twice with
// the same code is held for a while, so she has to change method instead of asking again.
//
// A method is an action with the item it is about (`obtain:bread`, `mine:oak_log`,
// `hunt:cow`), not its parameter string: on 2026-11-08 `obtain bread` failed 35 times and the
// old guard (goto / mine / look / attack for 45 s, cleared by any success, even `stop`) never
// held it. A success of another method does not clear a hold; only progress with the same
// method does. An answer that the item cannot be had that way at all (`invalid`, e.g. "no
// crafting recipe makes apple") holds it for the rest of the session at once. A goal that ran
// out of attempts holds its item as a goal (`goal:<item>`), so it is not proposed again four
// seconds later. Pure; times are epoch ms.

import type { JsonObject, JsonValue } from "@miyoria/types";
import type { GameConfig } from "./config.js";

/** Failure codes that say the method cannot work for this item at all: one is enough. */
export const FINAL_CODES: readonly string[] = ["invalid"];

/** Codes that are not the method failing (her body was taken, someone stopped it). */
export const INTERRUPTION_CODES: readonly string[] = [
  "busy",
  "cancelled",
  "superseded",
  "died",
  "disconnected",
  "crashed",
];

/** `"Oak Log"`, `"minecraft:oak_log"` → `"oak_log"`. */
export function normalizeItem(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .replace(/\s+/g, "_");
}

function str(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? normalizeItem(value) : null;
}

/** The item (or block, creature) an action is about, if it names one. */
export function itemOf(args: JsonObject): string | null {
  const one = str(args.item) ?? str(args.block) ?? str(args.entity);
  if (one !== null) return one;
  if (Array.isArray(args.blocks)) {
    const blocks = args.blocks.flatMap((b) => str(b) ?? []).sort();
    if (blocks.length > 0) return blocks.join("+");
  }
  if (Array.isArray(args.find)) {
    const found = args.find.flatMap((b) => str(b) ?? []).sort();
    if (found.length > 0) return found.join("+");
  }
  return str(args.find);
}

/** The method of an action: `obtain:bread`, `explore`, `goto:crafting_table`. */
export function methodKey(name: string, args: JsonObject): string {
  const item = itemOf(args);
  return item === null ? name : `${name}:${item}`;
}

const GOAL_PREFIX = "goal:";

export interface MethodHold {
  method: string;
  code: string;
  /** What the game said the last time (game data: escaped where it is shown). */
  why: string;
  until: number;
  /** A held proposal already asked for a quick new decision (once per hold). */
  nudged: boolean;
}

type MethodConfig = Pick<GameConfig, "method_repeat_limit" | "method_hold_secs">;

export class MethodGuard {
  readonly #cfg: MethodConfig;
  /** The last failure code of each method and how many times in a row it came. */
  readonly #fails = new Map<string, { code: string; n: number }>();
  readonly #held = new Map<string, MethodHold>();

  constructor(cfg: MethodConfig) {
    this.#cfg = cfg;
  }

  /**
   * `method` failed with `code` (`no_progress`: it ended without changing anything). Returns
   * the hold this failure started, if it did.
   */
  failed(method: string, code: string, why: string, now: number): MethodHold | null {
    if (this.#cfg.method_repeat_limit <= 0 || INTERRUPTION_CODES.includes(code)) return null;
    // A parameter mistake of an action without an item (`goto` without coordinates) is not the
    // method being impossible: only item methods are held for good.
    if (FINAL_CODES.includes(code) && method.includes(":")) {
      return this.#hold(method, code, why, Number.POSITIVE_INFINITY);
    }
    const prev = this.#fails.get(method);
    const n = prev?.code === code ? prev.n + 1 : 1;
    this.#fails.set(method, { code, n });
    if (n < this.#cfg.method_repeat_limit || this.#cfg.method_hold_secs <= 0) return null;
    this.#fails.delete(method);
    return this.#hold(method, code, why, now + this.#cfg.method_hold_secs * 1000);
  }

  #hold(method: string, code: string, why: string, until: number): MethodHold {
    const hold: MethodHold = { method, code, why, until, nudged: false };
    this.#held.set(method, hold);
    return hold;
  }

  /** `method` got her somewhere: its failures and hold are over. Other methods stay held. */
  progressed(method: string): void {
    this.#fails.delete(method);
    this.#held.delete(method);
  }

  /** The hold on `method` right now, if any. */
  held(method: string, now: number): MethodHold | null {
    const hold = this.#held.get(method);
    if (!hold) return null;
    if (now >= hold.until) {
      this.#held.delete(method);
      return null;
    }
    return hold;
  }

  /** A goal for `item` ran out of attempts: proposing it again waits like a method. */
  holdGoal(item: string, code: string, why: string, now: number): MethodHold | null {
    if (this.#cfg.method_hold_secs <= 0) return null;
    return this.#hold(`${GOAL_PREFIX}${item}`, code, why, now + this.#cfg.method_hold_secs * 1000);
  }

  goalHeld(item: string, now: number): MethodHold | null {
    return this.held(`${GOAL_PREFIX}${item}`, now);
  }

  /** The goal for `item` was reached after all. */
  goalReached(item: string): void {
    this.#held.delete(`${GOAL_PREFIX}${item}`);
  }

  /** Every hold in force, oldest first. */
  holds(now: number): MethodHold[] {
    return [...this.#held.keys()].flatMap((m) => this.held(m, now) ?? []);
  }

  /** Prompt lines for the holds in force (the reasons are game data; the caller escapes them). */
  lines(now: number): string[] {
    return this.holds(now).map((h) => {
      const left = Number.isFinite(h.until)
        ? `暫停 ${Math.max(1, Math.ceil((h.until - now) / 60_000))} 分鐘`
        : "這場不能再用";
      const what = h.method.startsWith(GOAL_PREFIX)
        ? `目標「${h.method.slice(GOAL_PREFIX.length)}」`
        : h.method;
      return `${what}(${left}):${h.code},${h.why}`;
    });
  }
}
