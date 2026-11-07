// What her game narration is about: a stable key per thing that happened, so saying it again in
// other words is still the same thing (a stop-gap for v3 §6 `attention_key`). This file only
// names things; the Arbiter decides whether a key may be said (`Impulse.attention`).
//
// Most repetition on 2026-11-07 was not game events: the decision loop's free-text commentary
// kept bringing up the same thing. So a free line takes the key of what it is about (`keyOf`): an
// earlier fact or line it resembles, else a key of its own.
//
// A line without a key is one the Arbiter must not limit as narration: urgent events and results
// someone asked for. Those never come through here.

import type { Impulse, JsonObject } from "@miyoria/types";
import type { ActionCall } from "./decision.js";

/** What a line of narration is about (`Impulse.attention`). */
export type About = NonNullable<Impulse["attention"]>;

/** Facts and lines remembered for `keyOf`. */
const MAX_TOPICS = 64;
/** Her recent lines shown to the decision model. */
const MAX_LINES = 6;
/** Letters of a free line in its own key. */
const KEY_LETTERS = 24;
/** Events that are worth a line although nothing marks them important. */
const NOTED = new Set(["craft_finished", "smelt_finished", "night_started"]);
/** Goals that end in having an item: the same thing as the event of making it. */
const ITEM_ACTIONS = new Set(["craft", "obtain", "get"]);

/** Letters and digits only, lower case (CJK kept). */
function letters(text: string): string {
  return [...text.toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");
}

function bigrams(text: string): Set<string> {
  const chars = [...letters(text)];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/**
 * Whether two short lines are about the same thing: at least 3 shared character bigrams covering
 * at least 40% of the shorter one (the rule of `mind/selfstart.ts`, which game cannot import).
 */
export function similar(a: string, b: string): boolean {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared >= 3 && shared / Math.min(x.size, y.size) >= 0.4;
}

/** What an event is about (`stone_pickaxe`, `zombie`, `lava`), `""` when it does not say. */
function subject(data: JsonObject | null): string {
  if (data === null) return "";
  for (const field of ["item", "title", "attacker", "last_attacker", "kind", "source"]) {
    const value = data[field];
    if (typeof value === "string" && value !== "") return value;
  }
  const types = data.new_types;
  if (Array.isArray(types)) {
    return types
      .filter((t) => typeof t === "string")
      .sort()
      .join("+");
  }
  const items = data.items;
  if (typeof items === "object" && items !== null && !Array.isArray(items)) {
    return Object.keys(items).sort().join("+");
  }
  return "";
}

/** The key of a game event: `game:craft:stone_pickaxe`, `game:damage:zombie`, `game:night_started`. */
export function eventKey(kind: string, data: JsonObject | null): string {
  const what = subject(data);
  const name = kind.replace(/_finished$/, "");
  return what === "" ? `game:${name}` : `game:${name}:${what}`;
}

/** The key of a goal she reached (one that ends in having an item: the key of making it). */
export function goalKey(text: string, action: ActionCall | null): string {
  const item = action?.args.item;
  if (action && ITEM_ACTIONS.has(action.name) && typeof item === "string" && item !== "") {
    return `game:craft:${item}`;
  }
  return `game:goal:${[...letters(text)].slice(0, KEY_LETTERS).join("")}`;
}

/** Whether `kind` (or `kind:subject`, like `reflex:lava`) is in `events`. */
export function matchesEvent(
  events: readonly string[],
  kind: string,
  data: JsonObject | null,
): boolean {
  return events.includes(kind) || events.includes(`${kind}:${subject(data)}`);
}

/** Whether an event is worth remembering as something she may talk about. */
export function isNoted(kind: string, important: boolean): boolean {
  return important || NOTED.has(kind);
}

interface Topic {
  key: string;
  text: string;
}

/**
 * The director's memory of what there is to talk about. It outlives a session (the same world
 * comes back after a restart of the game), not the process.
 */
export class Narration {
  #topics: Topic[] = [];
  #lines: string[] = [];

  /** `text` is about `key`. */
  note(key: string, text: string): void {
    this.#topics = [...this.#topics.filter((t) => t.text !== text), { key, text }].slice(
      -MAX_TOPICS,
    );
  }

  /** The key of a free line: of the newest topic it resembles, else its own. */
  keyOf(text: string): string {
    for (const t of [...this.#topics].reverse()) if (similar(text, t.text)) return t.key;
    return `game:remark:${[...letters(text)].slice(0, KEY_LETTERS).join("")}`;
  }

  /** She was told to say `text` (about `key`). */
  said(key: string, text: string): void {
    this.note(key, text);
    this.#lines = [...this.#lines.filter((l) => l !== text), text].slice(-MAX_LINES);
  }

  /** What she was told to say lately, oldest first. */
  lines(): string[] {
    return [...this.#lines];
  }
}
