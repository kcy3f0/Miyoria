// Her own description of how she feels about each person, beside the social module's numbers.
// One settings record per person (`self:feeling:<person id>`) of the active profile, cached in
// memory so the prompt reads it without I/O.

import type { SettingsStore } from "@miyoria/store";
import {
  type Feeling,
  isJsonObject,
  type JsonValue,
  type PersonId,
  type ProfileId,
  toTimestamp,
} from "@miyoria/types";

/** Settings key prefix of feelings records. */
export const FEELING_PREFIX = "self:feeling:";

export function feelingKey(person: PersonId): string {
  return `${FEELING_PREFIX}${person}`;
}

function parseFeeling(person: PersonId, value: JsonValue): Feeling | null {
  if (!isJsonObject(value) || typeof value.text !== "string" || value.text.trim() === "") {
    return null;
  }
  return {
    person,
    text: value.text,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : toTimestamp(0),
    by: typeof value.by === "string" ? value.by : "self",
  };
}

export class FeelingsBook {
  readonly #items = new Map<PersonId, Feeling>();

  constructor(
    private readonly store: SettingsStore | null,
    private readonly profile: ProfileId,
    private readonly maxChars: number,
  ) {}

  async load(): Promise<void> {
    if (!this.store) return;
    const records = await this.store.list(this.profile, FEELING_PREFIX);
    this.#items.clear();
    for (const [key, value] of records) {
      const person = key.slice(FEELING_PREFIX.length);
      const feeling = person === "" ? null : parseFeeling(person, value);
      if (feeling) this.#items.set(person, feeling);
    }
  }

  get(person: PersonId): Feeling | null {
    const f = this.#items.get(person);
    return f ? { ...f } : null;
  }

  /** Most recently updated first. */
  all(): Feeling[] {
    return [...this.#items.values()]
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .map((f) => ({ ...f }));
  }

  /** Stores `text` (trimmed, limited); empty text deletes. Writes through to the store. */
  async set(person: PersonId, text: string, by: string, now: number): Promise<Feeling | null> {
    const chars = [...text.trim()];
    const body = chars.slice(0, Math.max(this.maxChars, 1)).join("");
    if (body === "") {
      await this.store?.set(this.profile, feelingKey(person), null);
      this.#items.delete(person);
      return null;
    }
    const feeling: Feeling = { person, text: body, updated_at: toTimestamp(now), by };
    await this.store?.set(this.profile, feelingKey(person), {
      text: feeling.text,
      updated_at: feeling.updated_at,
      by: feeling.by,
    });
    this.#items.set(person, feeling);
    return { ...feeling };
  }
}
