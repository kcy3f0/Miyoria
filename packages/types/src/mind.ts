// Her mind loop (docs/design/autonomy.md §5): the thoughts the `mind` module has, the intents
// they produce and how those reach the agent.
//
// * The `mind` module provides `MindKey`: its journal (thoughts, intents, outcomes) and an
//   inbox for suggestions from other modules (initiative's idle channels, greetings, voice
//   joins, followups), which become reasons to think instead of direct `agent.initiative`
//   turns.
// * The agent provides `IntentSinkKey`: an intent opens a turn she starts herself (principal
//   `self`, with tools) in the right context, after the action it names passed the gate.

import type { TurnId } from "./ids.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** Published for every new or updated journal entry (`Thought`). */
export const MIND_THOUGHT_TOPIC = "mind.thought";

/** The capability of an intent that only means "start talking there". */
export const CHAT_START = "chat.start";
/** The capability of an intent that means "DM this person and talk". */
export const CHAT_DM = "chat.dm";

/** Something she decided to do. */
export interface Intent {
  id: string;
  /** Capability to run (`chat.start` / `chat.dm` to just start talking). */
  capability: string;
  args: JsonObject;
  /** Her reason, in her own words. */
  why: string;
  /** Her idea of how to open (her words; may echo other people). */
  opening: string | null;
  /** Where she acts and talks; the gate's principal context. */
  context: ContextKey | null;
  /** Who it is about or directed at (consent and per-person limits apply to them). */
  about: AccountRef | null;
  created_at: Timestamp;
  /** It no longer makes sense after this; dropped unstarted. */
  expires_at: Timestamp;
}

/**
 * `pending`: not submitted yet; `started`: her turn is queued or running; `done`: the action
 * ran (and her turn, if any, finished); `denied`: the gate refused; `dropped`: expired, busy or
 * interrupted; `failed`: the action failed after the gate allowed it.
 */
export type IntentStatus = "pending" | "started" | "done" | "denied" | "dropped" | "failed";

export interface IntentOutcome {
  status: IntentStatus;
  /** Short detail: the gate's reason, the action's result, why it was dropped. */
  detail: string;
  /** The turn she opened (or that the action ran in), when there is one. */
  turn: TurnId | null;
}

/** Provided by the agent: runs her intents (gate first, then her own turn). */
export interface IntentSink {
  submit(intent: Intent, signal?: AbortSignal): Promise<IntentOutcome>;
}

export const IntentSinkKey = serviceKey<IntentSink>("IntentSink");

// ---- journal --------------------------------------------------------------------------------

export type ThoughtTriggerKind =
  /** Her periodic heartbeat. */
  | "heartbeat"
  /** A `world.salient` event. */
  | "salient"
  /** A suggestion from another module (initiative). */
  | "suggestion"
  /** One of her turns ended. */
  | "turn"
  /** The voice channel she is in went quiet after a conversation. */
  | "voice_quiet"
  /** Asked for from the panel or a test. */
  | "manual";

export interface ThoughtTrigger {
  kind: ThoughtTriggerKind;
  /** Short neutral description (may contain untrusted names). */
  detail: string;
  context: ContextKey | null;
  at: Timestamp;
}

/** A gate decision made for one of her intents (pre-action or a tool call in her turn). */
export interface ThoughtDecision {
  at: Timestamp;
  capability: string;
  allowed: boolean;
  stage: string;
  reason: string;
}

export interface ThoughtIntent {
  id: string;
  capability: string;
  args: JsonValue;
  why: string;
  opening: string | null;
  context: ContextKey | null;
  about: AccountRef | null;
  expires_at: Timestamp;
  status: IntentStatus;
  detail: string | null;
  turn: TurnId | null;
  decisions: ThoughtDecision[];
  /** What she said in the turn she opened. */
  said: string | null;
}

/** One entry of her thought journal. */
export interface Thought {
  id: string;
  at: Timestamp;
  triggers: ThoughtTrigger[];
  /** Her inner monologue (first person, in her voice). */
  thought: string;
  /** What she changed in her inner state, in words (`多話程度 語音 0.8`, ...). */
  changes: string[];
  intents: ThoughtIntent[];
  /** Prompt + completion tokens of the call, when reported. */
  tokens: number | null;
  /** The call or the reply failed; `thought` is empty then. */
  error: string | null;
  /** Latency of the call. */
  ms: number;
}

/** A reason to think, offered by another module. */
export interface MindSuggestion {
  /** Module, e.g. `initiative`. */
  source: string;
  /** `idle_channel`, `greeting`, `voice_join`, `followup`, ... */
  reason: string;
  context: ContextKey | null;
  /** What it is about (zh-TW; may quote other people). */
  hint: string;
  about: AccountRef[];
}

/** Calls of her mind loop. */
export interface MindStats {
  /** Calls in the last hour. */
  calls_last_hour: number;
  max_calls_per_hour: number;
  calls_total: number;
  tokens_total: number;
  last_at: Timestamp | null;
  next_heartbeat_at: Timestamp | null;
  /** Why she is not thinking right now, if she is not (`paused`, `budget exhausted`, ...). */
  idle_reason: string | null;
}

/** Provided by the `mind` module. */
export interface Mind {
  /** She takes suggestions (running, not paused). */
  readonly accepting: boolean;
  /** Offers a reason to think; `false` when not accepted. */
  suggest(suggestion: MindSuggestion): boolean;
  /** Newest first. */
  thoughts(limit?: number): Thought[];
  stats(): MindStats;
}

export const MindKey = serviceKey<Mind>("Mind");
