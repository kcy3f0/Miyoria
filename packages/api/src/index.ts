// @miyoria/api: the Admin API (module `api`), an HTTP + SSE server for the CLI and the admin
// panel, plus a typed `ApiClient`.
//
// Every `/api` route except `GET /api/health` and the login routes requires
// `Authorization: Bearer <token>` or a panel session cookie; panel files at `/` never do.
// Session users need `admin.panel.access`, and `admin.panel.write` for anything but `GET`; their
// changes must also send `X-Miyoria-Request: 1` (CSRF guard). Unknown `/api/*` routes answer
// `404 {"error":"no such endpoint"}`. Errors are `{"error": "..."}`; a missing service (its
// module is stopped) is `503`. Changes are recorded in the `AuditLog` (actor `"api"` for the
// token, `discord:<id>` for a session) when there is one.
//
// Routes (shapes in `types.ts`):
//
// * `GET /api/health` → `{ status, version }`
// * `GET /api/auth/methods`, `GET /api/auth/oauth/login?next=/#/…`,
//   `GET /api/auth/oauth/callback` (public), `GET /api/auth/session`, `POST /api/auth/logout`
// * `GET /api/modules`, `POST /api/modules/{id}/enable|disable|restart`
// * `GET /api/decisions?limit=50&context=<json ContextKey>` (newest first)
// * `GET /api/llm/usage`, `GET /api/llm/cost`
// * `GET /api/persona`, `PUT /api/persona/{key}`, `GET /api/persona/{key}/history`
// * `GET /api/people?q=&limit=&cursor=`, `GET|PATCH /api/people/{id}`,
//   `POST /api/people/{id}/adjust`
// * `GET /api/memory?q=&kind=&subject=&before=&include_superseded=&limit=`,
//   `PATCH|DELETE /api/memory/{id}`
// * `GET /api/auth/roles`, `GET|PUT|DELETE /api/auth/roles/{name}`,
//   `GET|POST|DELETE /api/auth/assignments`, `GET|PUT|DELETE /api/auth/mappings`
// * `GET /api/extensions`, `POST /api/extensions/{id}/enable|disable|restart`
// * `GET /api/mcp`, `POST /api/mcp/{name}/restart`
// * `GET /api/queue`, `POST /api/queue/{id}/skip|move`, `POST /api/queue/pause|resume`
// * `GET /api/stage`, `POST /api/stage/scene|expression|stream|say`
// * `GET /api/voice`
// * `GET /api/events?topics=platform.*,agent.*` (Server-Sent Events of bus envelopes)

export {
  ApiClient,
  type CallOptions,
  ClientError,
  type ClientErrorKind,
  type EventStream,
  SseParser,
} from "./client.js";
export { ApiError, NO_SUCH_ENDPOINT } from "./errors.js";
export { ContextLabels, LABEL_MISS_TTL_MS, LABEL_TIMEOUT_MS, LABEL_TTL_MS } from "./labels.js";
export { METRICS_PATH } from "./metrics.js";
export {
  type ApiConfig,
  ApiConfigError,
  ApiConfigSchema,
  ApiModule,
  type ApiModuleOptions,
  avatarEmotions,
  DEFAULT_BIND,
  DEFAULT_PANEL_DIR,
  FETCH_BLOCKED_PORTS,
  PRUNE_EVERY_MS,
  parseBind,
} from "./module.js";
export { MONITOR_TOPICS, Monitor, percentile } from "./monitor.js";
export {
  type DiscordOAuthConfig,
  DiscordOAuthConfigSchema,
  OAuthConfigError,
  pkceChallenge,
  safeNext,
} from "./oauth.js";
export { PANEL_DIR_ENV, pickDir } from "./panel.js";
export { absoluteHistory } from "./people.js";
export { ActiveProfileKey, isQueueNotFound, MCP_MODULE_ID } from "./services.js";
export {
  COOKIE,
  CSRF_HEADER,
  PANEL_ACCESS,
  PANEL_WRITE,
  STORE_PREFIX as SESSION_STORE_PREFIX,
  STORE_PROFILE as SESSION_STORE_PROFILE,
} from "./session.js";
export type { Tokenizer } from "./state.js";
export type {
  AdjustPersonRequest,
  AssignRoleRequest,
  AuthMethods,
  CostInfo,
  ErrorBody,
  ExpressionRequest,
  ExtensionInfo,
  HealthInfo,
  LatencyStats,
  McpServerInfo,
  McpState,
  McpToolInfo,
  MemoryItem,
  MemoryListQuery,
  MemoryRecordView,
  ModelUsage,
  ModuleInfo,
  MoveRequest,
  Page,
  PeriodInfo,
  PersonaSectionInfo,
  PersonDetail,
  PersonSummary,
  QueueAuthor,
  QueueItemInfo,
  QueueState,
  RemoveMappingRequest,
  SayRequest,
  SayResponse,
  SceneRequest,
  SessionInfo,
  SessionPermissions,
  SessionUser,
  SetPersonaRequest,
  SetPersonaResponse,
  StageLinkState,
  StageState,
  StreamRequest,
  UpdateMemoryRequest,
  UpdatePersonRequest,
  UpsertRoleRequest,
  UsageInfo,
  VoiceLatency,
  VoiceSession,
  VoiceState,
} from "./types.js";
