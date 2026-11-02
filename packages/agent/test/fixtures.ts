// Small builders shared by the unit tests.

import {
  type AccountRef,
  type ContextKey,
  type ContextKind,
  type IncomingMessage,
  toTimestamp,
} from "@miyoria/types";
import type { HistoryEntry } from "../src/index.js";

export function tctx(kind: ContextKind = "channel"): ContextKey {
  return { platform: "t", scope: kind === "dm" ? null : "g", channel: "c", kind };
}

export function tacc(id: string): AccountRef {
  return { platform: "t", id };
}

/** A message in the `t` test context, authored by `who` (display name upper-cased if `upper`). */
export function tmsg(
  kind: ContextKind,
  who: string,
  text: string,
  options: { upper?: boolean; ts?: number } = {},
): IncomingMessage {
  return {
    id: { context: tctx(kind), id: "1" },
    author: {
      account: tacc(who),
      display_name: options.upper ? who.toUpperCase() : who,
      is_bot: false,
    },
    text,
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(options.ts ?? Date.now()),
  };
}

export function entry(author: string, text: string, isSelf: boolean): HistoryEntry {
  return {
    id: null,
    replyTo: null,
    parents: [],
    author,
    account: tacc(author),
    isBot: false,
    text,
    attachments: [],
    ts: Date.now(),
    isSelf,
    pending: null,
    spoken: false,
    interrupted: false,
    turn: null,
  };
}
