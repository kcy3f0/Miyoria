// Per-person privacy choices (`/me privacy`), one settings record per account so every feature
// that respects a choice reads the same place. Stored like voice consent: under the global
// settings profile, because the choice belongs to the person, not to a character.
//
//   key   privacy:<platform>:<user id>
//   value {"presence": false, ...}
//
// Fields are optional; a missing field means the default (allowed). Writers merge into the
// existing record (`mergePrivacy`) so features adding their own fields never drop each other's.

import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import type { AccountRef } from "./platform.js";

/** Settings profile privacy records are stored under. */
export const PRIVACY_PROFILE = "_global";
/** Settings key prefix of privacy records. */
export const PRIVACY_PREFIX = "privacy:";

/** Settings key of one account's record: `privacy:<platform>:<id>`. */
export function privacyKey(account: AccountRef): string {
  return `${PRIVACY_PREFIX}${account.platform}:${account.id}`;
}

/** The account of a privacy key, or `null` when `key` is not one. */
export function privacyAccount(key: string): AccountRef | null {
  if (!key.startsWith(PRIVACY_PREFIX)) return null;
  const rest = key.slice(PRIVACY_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  return { platform: rest.slice(0, colon), id: rest.slice(colon + 1) };
}

/** What one person allows. */
export interface PersonPrivacy {
  /** She may read their presence (status, game, music, custom status). Default `true`. */
  presence: boolean;
}

/** Reads a stored record; anything unreadable counts as the defaults. */
export function parsePrivacy(value: JsonValue | null): PersonPrivacy {
  const obj = isJsonObject(value) ? value : {};
  return { presence: obj.presence !== false };
}

/** `existing` with `change` applied, keeping fields other features own. */
export function mergePrivacy(
  existing: JsonValue | null,
  change: Readonly<Record<string, boolean | undefined>>,
): JsonObject {
  const base: JsonObject = isJsonObject(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(change)) {
    if (value !== undefined) base[key] = value;
  }
  return base;
}
