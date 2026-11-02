// One function per Admin API route (`packages/api/src`). To add an endpoint: put its wire
// types in `types.ts`, add a function here and a query key + hook in `app/queries.ts`.

import { type ApiClient, seg } from "./http";
import type {
  AdjustPersonRequest,
  AssignRoleRequest,
  AuthMethods,
  CostReport,
  DataCategoryId,
  DataInventory,
  DataWipeResult,
  ExtensionInfo,
  McpServerInfo,
  MemoryItem,
  MemoryQuery,
  MemoryRecordView,
  Page,
  PeopleQuery,
  PersonDetail,
  PersonSummary,
  QueueState,
  RemoveMappingRequest,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
  SayRequest,
  SceneRolesState,
  StageState,
  StreamAction,
  UpdateMemoryRequest,
  UpdatePersonRequest,
  UpsertRoleRequest,
  VoiceState,
  SelfView,
  WorldView,
  DecisionRecord,
  DecisionsQuery,
  HealthInfo,
  ModuleAction,
  ModuleInfo,
  PersonaOverride,
  PersonaSectionInfo,
  SessionInfo,
  SetPersonaRequest,
  SetPersonaResponse,
  UsageMap,
} from "./types";

type Opts = { signal?: AbortSignal };

export function createApi(client: ApiClient) {
  return {
    health: (o?: Opts) => client.get<HealthInfo>("/api/health", { ...o, public: true }),

    // panel login
    authMethods: (o?: Opts) => client.get<AuthMethods>("/api/auth/methods", { ...o, public: true }),
    session: (o?: Opts) => client.get<SessionInfo>("/api/auth/session", o),
    /** Ends the Discord session (clears the cookie); harmless for the token. */
    logout: () => client.post<void>("/api/auth/logout", undefined, { public: true }),
    /** Where the browser goes to start a Discord login; `next` is a local path such as `/#/people`. */
    discordLoginUrl: (next: string) => client.url("/api/auth/oauth/login", { next }),

    modules: (o?: Opts) => client.get<ModuleInfo[]>("/api/modules", o),
    moduleAction: (id: string, action: ModuleAction) =>
      client.post<ModuleInfo>(`/api/modules/${seg(id)}/${action}`),

    decisions: (q: DecisionsQuery = {}, o?: Opts) =>
      client.get<DecisionRecord[]>("/api/decisions", {
        ...o,
        query: { limit: q.limit, context: q.context ? JSON.stringify(q.context) : undefined },
      }),

    llmUsage: (o?: Opts) => client.get<UsageMap>("/api/llm/usage", o),

    persona: (o?: Opts) => client.get<PersonaSectionInfo[]>("/api/persona", o),
    setPersonaSection: (key: string, req: SetPersonaRequest) =>
      client.put<SetPersonaResponse>(`/api/persona/${seg(key)}`, req),
    personaHistory: (key: string, o?: Opts) =>
      client.get<PersonaOverride[]>(`/api/persona/${seg(key)}/history`, o),

    llmCost: (o?: Opts) => client.get<CostReport>("/api/llm/cost", o),

    people: (q: PeopleQuery = {}, o?: Opts) =>
      client.get<Page<PersonSummary>>("/api/people", { ...o, query: { ...q } }),
    person: (id: string, o?: Opts) => client.get<PersonDetail>(`/api/people/${seg(id)}`, o),
    updatePerson: (id: string, req: UpdatePersonRequest) =>
      client.patch<PersonSummary>(`/api/people/${seg(id)}`, req),
    adjustPerson: (id: string, req: AdjustPersonRequest) =>
      client.post<PersonSummary>(`/api/people/${seg(id)}/adjust`, req),

    memory: (q: MemoryQuery = {}, o?: Opts) =>
      client.get<Page<MemoryItem>>("/api/memory", { ...o, query: { ...q } }),
    updateMemory: (id: string, req: UpdateMemoryRequest) =>
      client.patch<MemoryRecordView>(`/api/memory/${seg(id)}`, req),
    deleteMemory: (id: string) => client.delete<void>(`/api/memory/${seg(id)}`),

    roles: (o?: Opts) => client.get<RoleDefinition[]>("/api/auth/roles", o),
    assignments: (o?: Opts) => client.get<RoleAssignment[]>("/api/auth/assignments", o),
    assignRole: (req: AssignRoleRequest) =>
      client.post<RoleAssignment>("/api/auth/assignments", req),
    revokeRole: (req: AssignRoleRequest) =>
      client.delete<void>("/api/auth/assignments", { body: req }),
    role: (name: string, o?: Opts) => client.get<RoleDefinition>(`/api/auth/roles/${seg(name)}`, o),
    upsertRole: (name: string, req: UpsertRoleRequest) =>
      client.put<RoleDefinition>(`/api/auth/roles/${seg(name)}`, req),
    deleteRole: (name: string) => client.delete<void>(`/api/auth/roles/${seg(name)}`),
    mappings: (platform: string, guild: string, o?: Opts) =>
      client.get<RoleMapping[]>("/api/auth/mappings", { ...o, query: { platform, guild } }),
    setMapping: (req: RoleMapping) => client.put<RoleMapping>("/api/auth/mappings", req),
    removeMapping: (req: RemoveMappingRequest) =>
      client.delete<void>("/api/auth/mappings", { body: req }),

    extensions: (o?: Opts) => client.get<ExtensionInfo[]>("/api/extensions", o),
    extensionAction: (id: string, action: "enable" | "disable" | "restart") =>
      client.post<ExtensionInfo>(`/api/extensions/${seg(id)}/${action}`),

    mcpServers: (o?: Opts) => client.get<McpServerInfo[]>("/api/mcp", o),
    /** Only `restart` exists at runtime; servers are turned on and off in `miyoria.toml`. */
    mcpRestart: (name: string) => client.post<McpServerInfo>(`/api/mcp/${seg(name)}/restart`),

    queue: (o?: Opts) => client.get<QueueState>("/api/queue", o),
    queueSkip: (id: string) => client.post<QueueState>(`/api/queue/${seg(id)}/skip`),
    queueMove: (id: string, position: number) =>
      client.post<QueueState>(`/api/queue/${seg(id)}/move`, { position }),
    queuePause: (paused: boolean) =>
      client.post<QueueState>(`/api/queue/${paused ? "pause" : "resume"}`),

    stage: (o?: Opts) => client.get<StageState>("/api/stage", o),
    stageScene: (scene: string) => client.post<StageState>("/api/stage/scene", { scene }),
    stageExpression: (expression: string) =>
      client.post<StageState>("/api/stage/expression", { expression }),
    stageStream: (action: StreamAction) => client.post<StageState>("/api/stage/stream", { action }),
    stageSay: (req: SayRequest) => client.post<{ turn: string | null }>("/api/stage/say", req),
    sceneRoles: (o?: Opts) => client.get<SceneRolesState>("/api/stage/scenes", o),
    setSceneRole: (role: string, scene: string | null) =>
      client.put<SceneRolesState>("/api/stage/scenes", { role, scene }),
    classifyScenes: () => client.post<SceneRolesState>("/api/stage/scenes/classify"),

    voice: (o?: Opts) => client.get<VoiceState>("/api/voice", o),

    self: (o?: Opts) => client.get<SelfView>("/api/self", o),
    world: (o?: Opts) => client.get<WorldView>("/api/world", o),

    // her data
    dataInventory: (o?: Opts) => client.get<DataInventory>("/api/data", o),
    /** A JSON backup of `categories` (all exportable ones without). */
    dataExport: (categories?: DataCategoryId[]) =>
      client.download("GET", "/api/data/export", { query: { categories: categories?.join(",") } }),
    dataWipe: (categories: DataCategoryId[], confirm?: string) =>
      client.post<DataWipeResult>("/api/data/wipe", { categories, confirm }),
    /** The full backup a reset needs; its `x-miyoria-backup-token` header unlocks the reset. */
    dataBackup: () => client.download("POST", "/api/data/backup"),
    dataReset: (confirm: string, backupToken: string) =>
      client.post<DataWipeResult>("/api/data/reset", { confirm, backup_token: backupToken }),
  };
}

export type Api = ReturnType<typeof createApi>;
