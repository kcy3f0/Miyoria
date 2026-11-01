import { monotonicFactory } from "ulid";

// ULID ids (26-character Crockford base32 strings, sortable by creation time).
export type EventId = string;
/** Correlates every event, LLM call and action of one agent "turn" (perception to output). */
export type TurnId = string;
export type ActionId = string;
/** A cross-platform person. Several platform accounts can link to one person. */
export type PersonId = string;

// Free-form string ids.
/** Stable module identifier, e.g. `"platform.discord.bot"` or `"agent"`. */
export type ModuleId = string;
/** A profile bundles persona, LLM, voice and avatar, e.g. `"deepseek-chan"`. */
export type ProfileId = string;
/** `"discord"`, later `"twitch"`, `"youtube"`, `"cli"` ... */
export type PlatformId = string;

const nextUlid = monotonicFactory();

/** A fresh ULID. Ids made in the same millisecond still sort in creation order. */
export function newId(): string {
  return nextUlid();
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID.test(value);
}
