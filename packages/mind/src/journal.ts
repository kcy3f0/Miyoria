// Her thought journal: every thought with its triggers, the changes she made, her intents and
// what became of them (gate decisions, what she said). One settings record per thought
// (`mind:thought:<id>`, ULIDs sort by time) of the active profile, the newest `keep` kept, and
// a copy in memory for the panel.

import { errorMessage, getLogger, SerialQueue } from "@miyoria/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  isJsonObject,
  type JsonValue,
  type ProfileId,
  type Thought,
  type TurnId,
} from "@miyoria/types";

const log = getLogger("mind.journal");

/** Settings key prefix of journal entries. */
export const THOUGHT_PREFIX = "mind:thought:";

export function thoughtKey(id: string): string {
  return `${THOUGHT_PREFIX}${id}`;
}

function parseThought(value: JsonValue): Thought | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.id !== "string" || typeof value.at !== "string") return null;
  if (typeof value.thought !== "string" || !Array.isArray(value.intents)) return null;
  return value as unknown as Thought;
}

function toJson(thought: Thought): JsonValue {
  return JSON.parse(JSON.stringify(thought)) as JsonValue;
}

export class Journal {
  readonly #items: Thought[] = [];
  readonly #writes = new SerialQueue();

  constructor(
    private readonly store: SettingsStore | null,
    private readonly profile: ProfileId,
    private readonly keep: number,
    /** Called with a copy after every add and update (publishes `mind.thought`). */
    private readonly changed: (thought: Thought) => void = () => {},
  ) {}

  async load(): Promise<void> {
    if (!this.store) return;
    const records = await this.store.list(this.profile, THOUGHT_PREFIX);
    this.#items.length = 0;
    for (const value of records.values()) {
      const thought = parseThought(value);
      if (thought) this.#items.push(thought);
    }
    this.#items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.#items.splice(0, Math.max(this.#items.length - this.keep, 0));
  }

  /** Newest first. */
  list(limit = 50): Thought[] {
    return this.#items
      .slice(-Math.max(limit, 0))
      .reverse()
      .map((t) => structuredClone(t));
  }

  /** The most recent `n`, oldest first. */
  recent(n: number): Thought[] {
    return this.#items.slice(-Math.max(n, 0)).map((t) => structuredClone(t));
  }

  get size(): number {
    return this.#items.length;
  }

  add(thought: Thought): Promise<void> {
    this.#items.push(structuredClone(thought));
    const dropped = this.#items.splice(0, Math.max(this.#items.length - this.keep, 0));
    this.changed(structuredClone(thought));
    return this.#persist(
      thought.id,
      dropped.map((t) => t.id),
    );
  }

  /** Applies `f` to the thought with an intent of turn `turn`; `false` when there is none. */
  updateByTurn(turn: TurnId, f: (thought: Thought, intent: Thought["intents"][number]) => void) {
    for (let i = this.#items.length - 1; i >= 0; i--) {
      const thought = this.#items[i] as Thought;
      const intent = thought.intents.find((x) => x.turn === turn);
      if (!intent) continue;
      f(thought, intent);
      this.changed(structuredClone(thought));
      void this.#persist(thought.id, []);
      return true;
    }
    return false;
  }

  /** Applies `f` to the thought `id`. */
  update(id: string, f: (thought: Thought) => void): boolean {
    const thought = this.#items.find((t) => t.id === id);
    if (!thought) return false;
    f(thought);
    this.changed(structuredClone(thought));
    void this.#persist(id, []);
    return true;
  }

  /** Waits for pending writes. */
  flush(): Promise<void> {
    return this.#writes.run(async () => {});
  }

  #persist(id: string, dropped: string[]): Promise<void> {
    const store = this.store;
    if (!store) return Promise.resolve();
    return this.#writes
      .run(async () => {
        const current = this.#items.find((t) => t.id === id);
        try {
          if (current) await store.set(this.profile, thoughtKey(id), toJson(current));
          for (const old of dropped) await store.set(this.profile, thoughtKey(old), null);
        } catch (error) {
          log.warn({ err: errorMessage(error) }, "cannot persist her thought journal");
        }
      })
      .catch(() => undefined);
  }
}
