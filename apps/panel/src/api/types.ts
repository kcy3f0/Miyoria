// Wire types of the Admin API, field for field as `packages/api/src/types.ts` and
// `packages/types` serialize them. Timestamps are RFC 3339 strings, ids are ULID strings.
// Keep this file in sync when the API changes.

/** A ULID, serialized as a 26-character string. */
export type Ulid = string;
/** RFC 3339 timestamp, e.g. `2026-11-01T08:30:00.123Z`. */
export type Timestamp = string;

// ---------------------------------------------------------------------------
// ids and platform

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
// voice

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
// events

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
// core routes

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
// store records

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
// panel login (`packages/api/src/oauth.ts`)

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

// ---------------------------------------------------------------------------
// panel routes

/** A page of results. `next_cursor` is opaque; `null` on the last page. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// LLM cost (`CostReport` in miyoria-llm/src/cost.rs)

export type BudgetState = "ok" | "degraded" | "exhausted";

export interface ModelUsage {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  cost_usd: number;
}

export interface PeriodReport {
  /** `2026-11-01` for a day, `2026-11` for a month. */
  period: string;
  total_usd: number;
  calls: number;
  models: Record<string, ModelUsage>;
}

/** `GET /api/llm/cost`. */
export interface CostReport {
  state: BudgetState;
  daily_usd: number | null;
  monthly_usd: number | null;
  /** Fraction of a budget at which the router degrades, e.g. `0.8`. */
  degrade_at: number;
  today: PeriodReport;
  month: PeriodReport;
}

// ---------------------------------------------------------------------------
// People & relationships (`Person`, `Account`, `Relationship`, `RelationshipDelta`)

export interface Account {
  account: AccountRef;
  display_name: string;
  first_seen: Timestamp;
  last_seen: Timestamp;
}

export interface Person {
  id: PersonId;
  display_name: string;
  created_at: Timestamp;
  accounts: Account[];
}

export interface Relationship {
  profile: ProfileId;
  person: PersonId;
  /** -100..100 */
  affinity: number;
  /** 0..100 */
  trust: number;
  /** 0..100 */
  familiarity: number;
  tags: string[];
  notes: string;
  call_name: string | null;
  interactions: number;
  last_interaction: Timestamp | null;
  updated_at: Timestamp;
}

export interface RelationshipDelta {
  at: Timestamp;
  affinity: number;
  trust: number;
  familiarity: number;
  reason: string;
}

/** `GET /api/people` items. */
export interface PersonSummary {
  person: Person;
  relationship: Relationship | null;
  /** Short attitude label, e.g. `"朋友"`. */
  label: string | null;
  blocked: boolean;
}

/** `GET /api/people/{id}`. */
export interface PersonDetail extends PersonSummary {
  /** Oldest first, for the affinity chart. */
  history: RelationshipDelta[];
  memory_count: number;
}

/** `POST /api/people/{id}/adjust`: added to the affinity, ignoring daily caps. */
export interface AdjustPersonRequest {
  affinity: number;
}

export interface PeopleQuery {
  q?: string;
  limit?: number;
  cursor?: string;
}

/** `PATCH /api/people/{id}`; every field optional. */
export interface UpdatePersonRequest {
  /** Replaces every tag except `blocked` (set that with `blocked`). */
  tags?: string[];
  notes?: string;
  call_name?: string | null;
  blocked?: boolean;
}

// ---------------------------------------------------------------------------
// Memory (`MemoryRecord`, `MemoryHit`, `MemoryScope`)

export type MemoryKind = "episode" | "fact" | "self_note" | "followup";

export type MemoryScope =
  | { type: "global" }
  | { type: "guild"; platform: PlatformId; guild: string }
  | { type: "channel"; context: ContextKey }
  | { type: "dm"; account: AccountRef }
  | { type: "person"; person: PersonId };

/** A memory record without its embedding vector. */
export interface MemoryRecordView {
  id: Ulid;
  profile: ProfileId;
  kind: MemoryKind;
  scope: MemoryScope;
  subjects: PersonId[];
  content: string;
  importance: number;
  confidence: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  last_accessed: Timestamp | null;
  access_count: number;
  source_context: ContextKey | null;
  due: Timestamp | null;
  done: boolean;
  superseded_by: Ulid | null;
  has_embedding: boolean;
}

export interface MemoryItem {
  record: MemoryRecordView;
  /** Present when `q` was given: full-text relevance. */
  text_score?: number;
  /** Present when `q` was given and vectors were compared. */
  vector_score?: number | null;
}

export interface MemoryQuery {
  /** Search text; omit to list newest first. */
  q?: string;
  kind?: MemoryKind;
  subject?: PersonId;
  /** Only records created before this time (pagination when listing). */
  before?: Timestamp;
  include_superseded?: boolean;
  limit?: number;
}

/** `PATCH /api/memory/{id}`. */
export interface UpdateMemoryRequest {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  done?: boolean;
}

// ---------------------------------------------------------------------------
// Roles & permissions (`RoleDefinition`, `RoleAssignment`, `AuthScope`)

export type AuthScope =
  | { type: "global" }
  | { type: "guild"; platform: PlatformId; guild: string }
  | { type: "channel"; context: ContextKey };

export interface RoleDefinition {
  name: string;
  /** Higher outranks lower. */
  rank: number;
  grants: string[];
  denies: string[];
  builtin: boolean;
}

export interface RoleAssignment {
  account: AccountRef;
  role: string;
  scope: AuthScope;
  granted_by: string;
  at: Timestamp;
}

export interface AssignRoleRequest {
  account: AccountRef;
  role: string;
  scope: AuthScope;
}

/** `PUT /api/auth/roles/{name}`. */
export interface UpsertRoleRequest {
  rank: number;
  grants: string[];
  denies: string[];
}

/** Platform role (e.g. a Discord role id) → Miyoria role, per guild. */
export interface RoleMapping {
  platform: PlatformId;
  guild: string;
  platform_role: string;
  role: string;
}

/** `DELETE /api/auth/mappings`. */
export interface RemoveMappingRequest {
  platform: PlatformId;
  guild: string;
  platform_role: string;
}

// ---------------------------------------------------------------------------
// Extensions

export interface ExtensionInfo {
  id: string;
  /** Supervisor module running it, `ext.<id>`. */
  module: string;
  name: string;
  version: string;
  description: string;
  /** Extension directory. */
  source: string;
  enabled: boolean;
  state: ModuleStateKind;
  reason: string | null;
  /** Granted permissions: `"tools"`, `"commands"`, `"events:<topic>"`, `"network:<host>"`, `"input:<kind>"`. */
  permissions: string[];
}

// ---------------------------------------------------------------------------
// MCP servers

export type McpTransport = "stdio" | "http";
export type McpState = "connecting" | "ready" | "failed" | "disabled";

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpServerInfo {
  name: string;
  transport: McpTransport;
  /** Command line (`stdio`) or URL without credentials (`http`). */
  target: string | null;
  /** `false` when disabled in `miyoria.toml`; only `restart` works at runtime. */
  enabled: boolean;
  state: McpState;
  error: string | null;
  tools: McpToolInfo[];
  /** Tools the server offers before allow / deny filtering. */
  remote_tool_count: number;
  /** Permission node required to use the tools. */
  permission: string | null;
  reconnects: number;
}

// ---------------------------------------------------------------------------
// Request queue

/** Free-form request kind from the queue, e.g. `"chat"`, `"song"`, `"game_goal"`. */
export type QueueItemKind = string;

export type QueueItemState = "pending" | "active" | "done" | "skipped" | "removed";

export interface QueueItem {
  /** The queue's numeric item id, as a string (e.g. `"3"`). */
  id: string;
  kind: QueueItemKind;
  /** Where the request was made; `null` for requests from the API or a game. */
  context: ContextKey | null;
  author: { account: AccountRef; display_name: string } | null;
  text: string;
  priority: number;
  enqueued_at: Timestamp;
  /** `active` items come first, then `pending` ones. */
  state: QueueItemState;
  votes: number;
}

export interface QueueState {
  paused: boolean;
  /** In processing order. */
  items: QueueItem[];
}

// ---------------------------------------------------------------------------
// Stage / stream control

export interface StageLink {
  connected: boolean;
  error: string | null;
}

export interface StageState {
  vts: StageLink;
  obs: StageLink;
  scene: string | null;
  scenes: string[];
  expression: string | null;
  expressions: string[];
  /** Emotions of the profile's `avatar.toml`, what `POST /api/stage/say` takes. */
  emotions: string[];
  /** The Stage node's overlay page (an OBS browser source); `null` without a node. */
  overlay_url: string | null;
  speaking: boolean;
  /** Name of the connected Stage node; `null` while disconnected. */
  node: string | null;
  /** OBS is streaming. */
  streaming: boolean;
}

export type StreamAction = "start" | "stop";

export interface SayRequest {
  text: string;
  emotion?: string;
}

// ---------------------------------------------------------------------------
// Voice monitor

export interface LatencyStats {
  p50_ms: number | null;
  p95_ms: number | null;
  samples: number;
}

export interface VoiceSession {
  context: ContextKey;
  /** Guild and channel names when the platform knows them. */
  label: string | null;
  participants: VoiceParticipant[];
  speaking: AccountRef[];
  joined_at: Timestamp;
  latency: {
    asr: LatencyStats;
    llm_first_token: LatencyStats;
    tts_first_audio: LatencyStats;
  };
  last_turn: TurnId | null;
}

/** `GET /api/voice`. */
export interface VoiceState {
  sessions: VoiceSession[];
}

// ---------------------------------------------------------------------------
// inner life (`GET /api/self`, `GET /api/world`; `packages/types` self.ts / world.ts)

export type DriveName = "social" | "play" | "attention" | "rest" | "curiosity";

export interface Mood {
  /** -1..1 */
  valence: number;
  /** 0..1 */
  arousal: number;
  /** 0..1 */
  energy: number;
}

export interface Talkativeness {
  level: number;
  until: Timestamp | null;
  why: string;
  set_at: Timestamp;
}

export interface SelfPolicy {
  /** By scope: `*`, `voice`, `text`, `discord:<guild>`, or a context string. */
  talkativeness: Record<string, Talkativeness>;
  initiative: number;
  initiative_why: string;
}

export type AgendaStatus = "open" | "done" | "expired" | "dropped";

export interface AgendaItem {
  id: string;
  text: string;
  why: string;
  person: PersonId | null;
  context: ContextKey | null;
  created_at: Timestamp;
  due: Timestamp | null;
  expires_at: Timestamp | null;
  status: AgendaStatus;
  closed_at: Timestamp | null;
}

export interface FeelingView {
  person: PersonId;
  display_name: string | null;
  text: string;
  updated_at: Timestamp;
  by: string;
}

/** `GET /api/self`. */
export interface SelfView {
  at: Timestamp;
  mood: Mood | null;
  boredom: number;
  drives: Record<DriveName, number>;
  policy: SelfPolicy;
  /** Open items first, then recently closed ones. */
  agenda: AgendaItem[];
  /** Newest first. */
  feelings: FeelingView[];
}

export type PresenceStatus = "online" | "idle" | "dnd" | "offline";

export interface PresenceActivity {
  type: "playing" | "streaming" | "listening" | "watching" | "competing" | "custom";
  name: string;
  details: string | null;
  state: string | null;
  started_at: Timestamp | null;
  url: string | null;
}

export interface VoiceSpot {
  platform: PlatformId;
  guild: string;
  channel: string;
  channel_name: string | null;
}

export interface PersonPresence {
  account: AccountRef;
  person: PersonId | null;
  display_name: string;
  status: PresenceStatus | null;
  activities: PresenceActivity[];
  voice: VoiceSpot | null;
  online_since: Timestamp | null;
  updated_at: Timestamp;
}

export interface VoiceMember {
  account: AccountRef;
  person: PersonId | null;
  display_name: string;
  is_self: boolean;
  muted: boolean;
  deafened: boolean;
  video: boolean;
  streaming: boolean;
  since: Timestamp;
}

export interface VoiceChannelState {
  platform: PlatformId;
  guild: string;
  channel: string;
  name: string | null;
  members: VoiceMember[];
}

export interface ChannelActivity {
  context: ContextKey;
  label: string | null;
  recent_messages: number;
  per_minute: number;
  last_at: Timestamp | null;
  recent_authors: string[];
  topic: string[];
  lively: boolean;
  her_last_at: Timestamp | null;
}

export interface HerStatus {
  voice: ContextKey | null;
  voice_name: string | null;
  golive: string | null;
  streaming: boolean;
  scene: string | null;
  game: string | null;
}

export interface TimeContext {
  local: string;
  weekday: number;
  weekend: boolean;
  part_of_day: string;
  utc_offset_minutes: number;
}

/** `GET /api/world`. */
export interface WorldView {
  at: Timestamp;
  time: TimeContext;
  her: HerStatus;
  people: PersonPresence[];
  voice_channels: VoiceChannelState[];
  channels: ChannelActivity[];
}
