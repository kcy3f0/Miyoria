// Wire types shared by the server and the client (Rust `miyoria_api::types`). Field names and
// nullability mirror the serde JSON exactly; `apps/panel/src/api/*types.ts` mirror these.

import type { PendingApproval } from "@miyoria/actions";
import type { ModuleStatus } from "@miyoria/kernel";

import type { CostReport, ModelUsage, PeriodReport } from "@miyoria/llm";
import type { ItemState } from "@miyoria/queue";
import type { StreamAction } from "@miyoria/stage";
import type {
  AuthScope,
  MemoryKind,
  MemoryScope,
  Person,
  Relationship,
  RelationshipDelta,
} from "@miyoria/store";
import type {
  AccountRef,
  ChannelActivity,
  ContextKey,
  ConversationState,
  FeedbackTally,
  Feeling,
  KnowledgeDoc,
  Lesson,
  MindStats,
  ModuleId,
  ModuleStateKind,
  PersonId,
  PlatformId,
  ProfileId,
  ReflectionRun,
  ReflectionStats,
  SelfSnapshot,
  Thought,
  Timestamp,
  TurnId,
  VoiceParticipant,
  WorldSnapshot,
} from "@miyoria/types";

/** `GET /api/health`. */
export interface HealthInfo {
  status: string;
  version: string;
}

/** `GET /api/auth/methods`: which panel logins this Core offers. */
export interface AuthMethods {
  /** The static bearer token always works. */
  token: boolean;
  /** Discord OAuth2 (`[modules.api.discord_oauth]` is configured). */
  discord: boolean;
}

export interface SessionUser {
  /** Discord user id. */
  id: string;
  name: string;
  avatar_url: string | null;
}

export interface SessionPermissions {
  /** May use mutating routes (`admin.panel.write`; always for the token). */
  write: boolean;
}

/** `GET /api/auth/session`: who the caller is. */
export interface SessionInfo {
  /** `"token"` or `"discord"`. */
  method: string;
  /** The Discord user; `null` for the bearer token. */
  user: SessionUser | null;
  permissions: SessionPermissions;
}

/** One module as reported by `GET /api/modules` (the supervisor's `ModuleStatus`). */
export type ModuleInfo = ModuleStatus;

/** Token usage of one `provider:model`, from `GET /api/llm/usage`. */
export interface UsageInfo {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
}

/** One persona section, from `GET /api/persona`. */
export interface PersonaSectionInfo {
  key: string;
  body: string;
}

/** Body of `PUT /api/persona/{key}`. */
export interface SetPersonaRequest {
  body: string;
  /** Defaults to the caller (`"api"` for the token). */
  edited_by?: string;
}

/** Response of `PUT /api/persona/{key}`. */
export interface SetPersonaResponse {
  key: string;
  version: number;
}

/** Every error response: `{ "error": "..." }`. */
export interface ErrorBody {
  error: string;
}

/** A page of results. `next_cursor` is opaque; `null` on the last page. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// ---- LLM cost ---------------------------------------------------------------------------

/** Totals of one day (`YYYY-MM-DD`) or month (`YYYY-MM`). */
export type PeriodInfo = PeriodReport;
/** `GET /api/llm/cost`: the router's `CostReport` as-is. */
export type CostInfo = CostReport;
export type { ModelUsage };

// ---- people -----------------------------------------------------------------------------

/** `GET /api/people` items: every known person, with or without a relationship. */
export interface PersonSummary {
  person: Person;
  /** `null` before the first interaction. */
  relationship: Relationship | null;
  /** Short attitude label, e.g. `"朋友"`; `"陌生人"` (a neutral relationship's) without one. */
  label: string | null;
  blocked: boolean;
}

/** `GET /api/people/{id}` (the summary's fields flattened in). */
export interface PersonDetail extends PersonSummary {
  /** Oldest first; values are the resulting absolute levels. */
  history: RelationshipDelta[];
  memory_count: number;
}

/** Body of `PATCH /api/people/{id}`; omitted fields are unchanged. */
export interface UpdatePersonRequest {
  /** Replaces every tag except `blocked` (use `blocked`). */
  tags?: string[];
  notes?: string;
  /** `null` clears it. */
  call_name?: string | null;
  blocked?: boolean;
}

/** Body of `POST /api/people/{id}/adjust`. */
export interface AdjustPersonRequest {
  /** Added to the affinity directly, ignoring the daily caps. */
  affinity: number;
}

// ---- memory -----------------------------------------------------------------------------

/** A `MemoryRecord` without its search tokens and embedding vector. */
export interface MemoryRecordView {
  id: string;
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
  superseded_by: string | null;
  has_embedding: boolean;
}

/** `GET /api/memory` items. The scores are present only for a search (`q`). */
export interface MemoryItem {
  record: MemoryRecordView;
  /** The backend's full-text relevance, 0 when only the vector matched. */
  text_score?: number;
  /** `null` for a search that compared no vectors. */
  vector_score?: number | null;
  /**
   * Hybrid recall score (vector, text, recency, importance), present when the search ran through
   * the memory engine; results are ordered by it.
   */
  score?: number;
}

/** Query of `GET /api/memory`. */
export interface MemoryListQuery {
  /**
   * Search text: hybrid recall (vector, text, recency, importance) through the memory module
   * when it runs, full text otherwise. Omitted lists newest first.
   */
  q?: string;
  kind?: MemoryKind;
  subject?: PersonId;
  /** Only records created before this time (pagination when listing). */
  before?: Timestamp;
  include_superseded?: boolean;
  limit?: number;
}

/** Body of `PATCH /api/memory/{id}`; omitted fields are unchanged. */
export interface UpdateMemoryRequest {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  done?: boolean;
}

// ---- roles & permissions ----------------------------------------------------------------

/** Body of `POST` / `DELETE /api/auth/assignments`. */
export interface AssignRoleRequest {
  account: AccountRef;
  role: string;
  scope: AuthScope;
}

/** Body of `PUT /api/auth/roles/{name}`. */
export interface UpsertRoleRequest {
  rank: number;
  grants?: string[];
  denies?: string[];
}

/** Body of `DELETE /api/auth/mappings`. */
export interface RemoveMappingRequest {
  platform: PlatformId;
  guild: string;
  platform_role: string;
}

// ---- extensions -------------------------------------------------------------------------

/** One extension, from `GET /api/extensions`. */
export interface ExtensionInfo {
  id: string;
  /** Supervisor module running it (`ext.<id>`). */
  module: ModuleId;
  name: string;
  version: string;
  description: string;
  /** Extension directory. */
  source: string;
  enabled: boolean;
  state: ModuleStateKind;
  reason: string | null;
  /** Granted permissions, e.g. `"tools"`, `"events:game.*"`. */
  permissions: string[];
}

// ---- MCP --------------------------------------------------------------------------------

export type McpState = "connecting" | "ready" | "failed" | "disabled";

export interface McpToolInfo {
  /** Registry name (`mcp_<server>_<tool>`). */
  name: string;
  description: string;
}

/** One configured MCP server, from `GET /api/mcp`. */
export interface McpServerInfo {
  name: string;
  /** `"stdio"` or `"http"`. */
  transport: string;
  /** Command line or URL; `null` while the MCP module does not report it. */
  target: string | null;
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

// ---- request queue ----------------------------------------------------------------------

export interface QueueAuthor {
  account: AccountRef;
  display_name: string;
}

/** One queued request, from `GET /api/queue`. */
export interface QueueItemInfo {
  /** The queue's numeric item id, as a string. */
  id: string;
  /** Free-form, e.g. `"chat"`, `"song"`, `"game_goal"`. */
  kind: string;
  context: ContextKey | null;
  author: QueueAuthor | null;
  text: string;
  priority: number;
  enqueued_at: Timestamp;
  /** `active` items come first, then `pending` ones. */
  state: ItemState;
  votes: number;
}

/** `GET /api/queue` and the response of every queue mutation. */
export interface QueueState {
  paused: boolean;
  /** In processing order. */
  items: QueueItemInfo[];
}

/** Body of `POST /api/queue/{id}/move`. */
export interface MoveRequest {
  /** 0-based target index in `QueueState.items`, clamped. */
  position: number;
}

// ---- stage ------------------------------------------------------------------------------

export interface StageLinkState {
  connected: boolean;
  error: string | null;
}

/** `GET /api/stage` and the response of stage mutations. */
export interface StageState {
  vts: StageLinkState;
  obs: StageLinkState;
  scene: string | null;
  /** OBS scene names, top of OBS's scene list first; empty while OBS is not connected. */
  scenes: string[];
  /** Last expression (VTube Studio hotkey) triggered through the API. */
  expression: string | null;
  /** VTube Studio hotkey names of the loaded model (what `POST /api/stage/expression` takes). */
  expressions: string[];
  /** Emotions of the profile's `avatar.toml` (what `POST /api/stage/say` takes), sorted. */
  emotions: string[];
  /** The Stage node's overlay page (an OBS browser source); `null` without a node. */
  overlay_url: string | null;
  /** Her speech is playing. */
  speaking: boolean;
  /** Name of the connected Stage node, `null` while disconnected. */
  node: string | null;
  /** OBS is streaming. */
  streaming: boolean;
}

/** One scene role in `GET /api/stage/scenes`. */
export interface SceneRoleState {
  /** `chat`, `game`, `brb`, `starting`, `ending` or one of the owner's roles. */
  role: string;
  /** Label of a built-in role, `null` for the owner's own roles. */
  label: string | null;
  /** The OBS scene it switches to, `null` = none. */
  scene: string | null;
  /** Where that came from: the config file, the panel or the automatic classification. */
  source: "config" | "panel" | "auto" | null;
  /** What the classification picked. */
  auto: string | null;
  /** Set in the config file (the panel cannot change it). */
  locked: boolean;
}

/** `GET /api/stage/scenes` and the response of its mutations. */
export interface SceneRolesState {
  /** OBS scene names the stage node reports. */
  scenes: string[];
  roles: SceneRoleState[];
  /** `llm`, `heuristic` (keywords) or `null` (not classified yet). */
  classified_by: "llm" | "heuristic" | null;
  classifying: boolean;
}

/** Body of `PUT /api/stage/scenes`: `scene: null` goes back to the classification. */
export interface SceneRoleRequest {
  role: string;
  scene: string | null;
}

/** Body of `POST /api/stage/scene`. */
export interface SceneRequest {
  scene: string;
}

/** Body of `POST /api/stage/expression`. */
export interface ExpressionRequest {
  expression: string;
}

/** Body of `POST /api/stage/stream`. */
export interface StreamRequest {
  action: StreamAction;
}

/** Body of `POST /api/stage/say`. */
export interface SayRequest {
  text: string;
  emotion?: string;
}

/** Response of `POST /api/stage/say`. */
export interface SayResponse {
  turn: TurnId | null;
}

// ---- voice ------------------------------------------------------------------------------

/** Latency over the recent window; `null` percentiles without samples. */
export interface LatencyStats {
  p50_ms: number | null;
  p95_ms: number | null;
  samples: number;
}

export interface VoiceLatency {
  asr: LatencyStats;
  llm_first_token: LatencyStats;
  tts_first_audio: LatencyStats;
}

/** One voice channel she is in. */
export interface VoiceSession {
  context: ContextKey;
  label: string | null;
  participants: VoiceParticipant[];
  /** Accounts currently speaking. */
  speaking: AccountRef[];
  joined_at: Timestamp;
  latency: VoiceLatency;
  last_turn: TurnId | null;
}

/** `GET /api/voice`. */
export interface VoiceState {
  sessions: VoiceSession[];
}

/** One of her feelings, with the person's name. */
export interface FeelingView extends Feeling {
  display_name: string | null;
}

/** `GET /api/self`: her inner state and her feelings about people (newest first). */
export interface SelfView extends SelfSnapshot {
  feelings: FeelingView[];
}

/** A text context of the world snapshot, with its human name when the platform knows it. */
export interface ChannelActivityView extends ChannelActivity {
  label: string | null;
}

/** `GET /api/world`: what she perceives right now. */
export interface WorldView extends Omit<WorldSnapshot, "channels"> {
  channels: ChannelActivityView[];
}

/** One channel level (docs/design/autonomy.md §21). */
export interface ChannelLevelInfo {
  /** `off`, `mention-only`, `quiet`, `normal`, `lively` or `always`. */
  mode: string;
  /** In words (`安靜`). */
  label: string;
  description: string;
}

/** The level of one text channel. */
export interface ChannelLevelView {
  context: ContextKey;
  /** The channel's name when the platform knows it. */
  label: string | null;
  mode: string;
  /** Set at runtime (`/channel mode` or the panel); `false`: from config or the profile. */
  custom: boolean;
  /** The mode without the runtime setting (what resetting goes back to). */
  default: string;
}

/**
 * `GET /api/channels/levels`: the levels, and the text channels she has seen recently or that
 * have their own level.
 */
export interface ChannelLevelsView {
  levels: ChannelLevelInfo[];
  channels: ChannelLevelView[];
}

/** `GET /api/mind` (and the answer of `POST /api/mind/pause|resume`). */
export interface MindView {
  /** Her autonomy is paused (only commands and the panel act; her mind does not think). */
  paused: boolean;
  /** The `mind` module is running. */
  running: boolean;
  /** Her mind takes triggers right now. */
  accepting: boolean;
  stats: MindStats | null;
  /** High-risk actions waiting for an owner. */
  pending_approvals: number;
}

export type { PendingApproval, Thought };

// ---- what she organized and learned (phase G) -----------------------------------------------

/** One of her documents, with its short id (as her prompts show it) and whom it is about. */
export interface KnowledgeDocView extends KnowledgeDoc {
  short_id: string;
  subject_label: string;
}

/** `GET /api/knowledge`: every document, most recently updated first. */
export interface KnowledgeView {
  documents: KnowledgeDocView[];
}

/** `GET /api/knowledge/conversations`: her notes on a conversation, with the place's name. */
export interface ConversationNoteView extends ConversationState {
  label: string | null;
}

export interface LessonView extends Lesson {
  display_name: string | null;
}

/** `GET /api/reflection?days=7`. */
export interface ReflectionView {
  stats: ReflectionStats;
  runs: ReflectionRun[];
  lessons: LessonView[];
  feedback: FeedbackTally[];
}

// ---- live controls (`control.ts`) and telemetry (`telemetry.ts`) ----------------------------

/** Answer of a control route: what the capability said it did. */
export interface ControlResult {
  text: string;
}

/** One song of her set list (`GET /api/songs`). */
export interface SongView {
  no: number;
  /** What was asked for. Untrusted. */
  query: string;
  title: string | null;
  artist: string | null;
  duration_s: number | null;
  key: number;
  requester_name: string;
  state: "preparing" | "ready" | "playing" | "done" | "failed" | "cancelled";
  /** Worker stage while preparing (`download`, `separate`, `convert`, ...). */
  stage: string;
  /** 0..1 while preparing. */
  progress: number;
  error: string | null;
  /** Sung as soon as she is free once ready. */
  forced: boolean;
  created_at: string;
  ready_at: string | null;
}

/** `GET /api/songs` (and the answers of the song routes, with `text`). */
export interface SongsState {
  /** Number of the song she is singing. */
  playing: number | null;
  /** Why speech is paused (a song job has the GPU), else `null`. */
  paused: string | null;
  songs: SongView[];
}

/** Process-wide LLM counters at a sample, summed over models and purposes. */
export interface TelemetryLlm {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  cost_usd: number;
  errors: number;
  /** `miyoria_llm_first_token_seconds`: cumulative counts at each finite upper bound. */
  first_token: { count: number; sum_s: number; buckets: { le_s: number; count: number }[] };
}

/** One sample. Counters are totals since the process started; `events` count since the last one. */
export interface TelemetryPoint {
  at: string;
  mood: { valence: number; arousal: number; energy: number } | null;
  boredom: number | null;
  drives: Record<string, number> | null;
  initiative: number | null;
  llm: TelemetryLlm;
  mind: { calls_total: number; tokens_total: number } | null;
  voice_sessions: number;
  speaking: boolean;
  /** `messages`, `turns`, `initiatives`, `utterances`, `actions` since the previous sample. */
  events: Record<string, number>;
}

/** `GET /api/telemetry?minutes=360`: samples, oldest first. */
export interface TelemetryView {
  interval_ms: number;
  points: TelemetryPoint[];
}
