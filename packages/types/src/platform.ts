import type { PlatformId } from "./ids.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/**
 * An account on a platform. Platform user ids are globally unique per platform, so the bot and
 * self accounts on Discord resolve the same person to the same `AccountRef`.
 */
export interface AccountRef {
  platform: PlatformId;
  id: string;
}

/** `"<platform>:<id>"`, e.g. `"discord:1234"` (the form used in config and `edited_by` fields). */
export function accountRefString(account: AccountRef): string {
  return `${account.platform}:${account.id}`;
}

export function sameAccount(a: AccountRef, b: AccountRef): boolean {
  return a.platform === b.platform && a.id === b.id;
}

export type ContextKind = "channel" | "thread" | "dm" | "voice";

/**
 * Identifies one conversation context. It is independent of which connection (bot or self
 * account) observed it.
 */
export interface ContextKey {
  platform: PlatformId;
  /** Guild / server id. `null` for DMs. */
  scope: string | null;
  channel: string;
  kind: ContextKind;
}

/**
 * Display form, used in lane keys and logs: `discord:<guild>:<channel>`, `discord:dm:<channel>`.
 * Voice contexts get a `voice:` infix (`discord:<guild>:voice:<channel>`): on Discord a voice
 * channel's text chat has the same channel id as the voice channel itself.
 * The kind is otherwise not part of it, so it is not a unique key; see `contextKeyEquals`.
 */
export function contextKeyString(key: ContextKey): string {
  const voice = key.kind === "voice" ? "voice:" : "";
  return key.scope === null
    ? `${key.platform}:dm:${voice}${key.channel}`
    : `${key.platform}:${key.scope}:${voice}${key.channel}`;
}

export function contextKeyEquals(a: ContextKey, b: ContextKey): boolean {
  return (
    a.platform === b.platform && a.scope === b.scope && a.channel === b.channel && a.kind === b.kind
  );
}

export interface MessageRef {
  context: ContextKey;
  id: string;
}

export interface Author {
  account: AccountRef;
  display_name: string;
  is_bot: boolean;
}

export interface Attachment {
  url: string;
  filename: string;
  content_type: string | null;
}

export interface IncomingMessage {
  id: MessageRef;
  author: Author;
  text: string;
  /** The message @-mentions one of her accounts. */
  mentions_self: boolean;
  /** The message replies to one of her messages. */
  reply_to_self: boolean;
  attachments: Attachment[];
  ts: Timestamp;
}

export interface OutgoingMessage {
  text: string;
  reply_to: MessageRef | null;
}

/**
 * Implemented by platform adapters so the scheduler can execute output actions without knowing
 * which platform (or which account) it talks to.
 */
export interface PlatformSink {
  readonly platform: PlatformId;
  send(context: ContextKey, message: OutgoingMessage, signal?: AbortSignal): Promise<MessageRef>;
  react(message: MessageRef, emoji: string, signal?: AbortSignal): Promise<void>;
  typing(context: ContextKey, signal?: AbortSignal): Promise<void>;
}

/**
 * Registry of platform sinks, keyed by platform. Created by the app at boot and provided as the
 * `PlatformSinksKey` service; platform modules register their sink on start and unregister on
 * stop.
 */
export class PlatformSinks {
  readonly #sinks = new Map<PlatformId, PlatformSink>();

  register(sink: PlatformSink): void {
    this.#sinks.set(sink.platform, sink);
  }

  unregister(platform: PlatformId): void {
    this.#sinks.delete(platform);
  }

  get(platform: PlatformId): PlatformSink | undefined {
    return this.#sinks.get(platform);
  }
}

export const PlatformSinksKey = serviceKey<PlatformSinks>("PlatformSinks");
