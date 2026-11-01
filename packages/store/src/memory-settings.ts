import type { JsonValue, ProfileId } from "@miyoria/types";
import type { SettingsStore } from "./stores.js";

/**
 * `SettingsStore` backed by a map, for tests and quick local runs. Values are deep-copied in
 * and out, like a real database round trip.
 */
export class MemorySettingsStore implements SettingsStore {
  readonly #data = new Map<string, Map<string, JsonValue>>();

  async get(profile: ProfileId, key: string): Promise<JsonValue | null> {
    const value = this.#data.get(profile)?.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  async set(profile: ProfileId, key: string, value: JsonValue | null): Promise<void> {
    let entries = this.#data.get(profile);
    if (value === null) {
      entries?.delete(key);
      return;
    }
    if (!entries) {
      entries = new Map();
      this.#data.set(profile, entries);
    }
    entries.set(key, structuredClone(value));
  }

  async list(profile: ProfileId, prefix: string): Promise<Map<string, JsonValue>> {
    const entries = this.#data.get(profile) ?? new Map<string, JsonValue>();
    const keys = [...entries.keys()].filter((k) => k.startsWith(prefix)).sort();
    return new Map(keys.map((k) => [k, structuredClone(entries.get(k) as JsonValue)]));
  }
}
