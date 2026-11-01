// Wire types of the panel-facing routes in `API-PLAN.md`, served by
// `crates/miyoria-api` (Rust mirrors in `src/types.rs`). Shapes follow the store
// records in `crates/miyoria-store` (people, relationships, memory, auth).
// `apps/panel/API-PLAN.md` documents each route with example JSON — change
// both together.

import type {
  AccountRef,
  ContextKey,
  ModuleStateKind,
  PersonId,
  PlatformId,
  ProfileId,
  Timestamp,
  TurnId,
  Ulid,
  VoiceParticipant,
} from "./types";

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
  /** Command line (`stdio`) or URL (`http`); `null` while the Core does not report it. */
  target: string | null;
  /** `false` when disabled in `miyoria.toml`; only `restart` works at runtime (409 otherwise). */
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
  /** Browser-source URL of the overlay, if the stage serves one. */
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
