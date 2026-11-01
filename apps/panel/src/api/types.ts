// Wire types of the Admin API that exists today. They mirror, field for field,
// `crates/miyoria-api/src/types.rs`, `crates/miyoria-types` and the store
// records the API serializes. Timestamps are RFC 3339 strings (chrono), ids are
// ULID strings. Keep this file in sync when the Rust side changes.

/** A ULID, serialized as a 26-character string. */
export type Ulid = string;
/** RFC 3339 timestamp, e.g. `2026-11-01T08:30:00.123Z`. */
export type Timestamp = string;

// ---------------------------------------------------------------------------
// miyoria-types: ids and platform

export type ModuleId = string;
export type ProfileId = string;
export type PlatformId = string;
export type TurnId = Ulid;
export type EventId = Ulid;
export type ActionId = Ulid;
export type PersonId = Ulid;

export interface AccountRef {
  platform: PlatformId;
  id: string;
}

export type ContextKind = "channel" | "thread" | "dm" | "voice";

export interface ContextKey {
  platform: PlatformId;
  /** Guild / server id. `null` for DMs. */
  scope: string | null;
  channel: string;
  kind: ContextKind;
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
  mentions_self: boolean;
  reply_to_self: boolean;
  attachments: Attachment[];
  ts: Timestamp;
}

// ---------------------------------------------------------------------------
// miyoria-types: voice

export interface VoiceParticipant {
  account: AccountRef;
  display_name: string;
  is_self: boolean;
  muted: boolean;
  deafened: boolean;
}

export interface VoiceUtterance {
  id: string;
  context: ContextKey;
  speaker: Author;
  text: string;
  language: string | null;
  emotion: string | null;
  audio_events: string[];
  started_at: Timestamp;
  ended_at: Timestamp;
  asr_ms: number;
}

export type PlaybackState = "started" | "finished" | "interrupted" | "failed";

// ---------------------------------------------------------------------------
// miyoria-types: events

export type ModuleStateKind =
  | "disabled"
  | "starting"
  | "running"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

export const MODULE_STATES: readonly ModuleStateKind[] = [
  "running",
  "degraded",
  "starting",
  "stopping",
  "failed",
  "stopped",
  "disabled",
];

/** Why the agent did or did not respond. */
export interface DecisionTrace {
  turn: TurnId;
  context: ContextKey;
  respond: boolean;
  score: number;
  reasons: string[];
}

/** `Event`, serialized with `#[serde(tag = "type", content = "data")]`. */
export type BusEvent =
  | { type: "platform_ready"; data: { platform: PlatformId; self_account: AccountRef } }
  | { type: "platform_message_created"; data: IncomingMessage }
  | { type: "platform_typing"; data: { context: ContextKey; account: AccountRef } }
  | { type: "agent_turn_started"; data: { turn: TurnId; context: ContextKey } }
  | { type: "agent_decision"; data: DecisionTrace }
  | { type: "agent_turn_completed"; data: { turn: TurnId; context: ContextKey; text: string } }
  | {
      type: "action_completed";
      data: {
        action: ActionId;
        turn: TurnId | null;
        ok: boolean;
        error: string | null;
        message?: MessageRef | null;
      };
    }
  | { type: "voice_joined"; data: { context: ContextKey; participants: VoiceParticipant[] } }
  | { type: "voice_left"; data: { context: ContextKey; reason: string | null } }
  | { type: "voice_participants"; data: { context: ContextKey; participants: VoiceParticipant[] } }
  | { type: "voice_speaking"; data: { context: ContextKey; account: AccountRef; speaking: boolean } }
  | { type: "voice_utterance"; data: VoiceUtterance }
  | {
      type: "voice_playback";
      data: { context: ContextKey; turn: TurnId | null; state: PlaybackState; text: string };
    }
  | {
      type: "agent_initiative";
      data: { context: ContextKey; reason: string; hint: string; about: AccountRef[] };
    }
  | {
      type: "module_state_changed";
      data: { module: ModuleId; state: ModuleStateKind; reason: string | null };
    }
  | { type: "custom"; data: { topic: string; payload: unknown } };

export type BusEventType = BusEvent["type"];

/** Every event on the bus, as streamed by `GET /api/events`. */
export interface Envelope {
  id: EventId;
  ts: Timestamp;
  source: ModuleId;
  causation: EventId | null;
  correlation: TurnId | null;
  event: BusEvent;
}

// ---------------------------------------------------------------------------
// miyoria-api: types.rs

/** `GET /api/health` (no token required). */
export interface HealthInfo {
  status: string;
  version: string;
}

/** One module, from `GET /api/modules` and `POST /api/modules/{id}/{action}`. */
export interface ModuleInfo {
  id: ModuleId;
  name: string;
  description: string;
  enabled: boolean;
  state: ModuleStateKind;
  reason: string | null;
  recent_restarts: number;
}

export type ModuleAction = "enable" | "disable" | "restart";

/** Per `provider:model`, from `GET /api/llm/usage`. */
export interface UsageInfo {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
}

export type UsageMap = Record<string, UsageInfo>;

/** `GET /api/persona`. */
export interface PersonaSectionInfo {
  key: string;
  body: string;
}

/** Body of `PUT /api/persona/{key}`. */
export interface SetPersonaRequest {
  body: string;
  /** Defaults to `"api"` on the server. */
  edited_by?: string;
}

/** Response of `PUT /api/persona/{key}`. */
export interface SetPersonaResponse {
  key: string;
  version: number;
}

/** Every error response. */
export interface ErrorBody {
  error: string;
}

// ---------------------------------------------------------------------------
// miyoria-store records

/** `GET /api/persona/{key}/history` items (`PersonaOverride`). */
export interface PersonaOverride {
  profile: ProfileId;
  key: string;
  version: number;
  body: string;
  edited_by: string;
  edited_at: Timestamp;
}

/** `GET /api/decisions` items, newest first. */
export interface DecisionRecord {
  id: Ulid;
  profile: ProfileId;
  ts: Timestamp;
  trace: DecisionTrace;
}

export interface DecisionsQuery {
  /** Default 50, capped at 1000 by the server. */
  limit?: number;
  context?: ContextKey;
}

// ---------------------------------------------------------------------------
// panel login (crates/miyoria-api/src/oauth.rs)

/** `GET /api/auth/methods` (public). */
export interface AuthMethods {
  token: boolean;
  /** Discord OAuth2 is configured on this Core. */
  discord: boolean;
}

export interface SessionUser {
  /** Discord user id. */
  id: string;
  name: string;
  avatar_url: string | null;
}

/** `GET /api/auth/session`. */
export interface SessionInfo {
  method: "token" | "discord";
  /** `null` for the bearer token. */
  user: SessionUser | null;
  permissions: { write: boolean };
}
