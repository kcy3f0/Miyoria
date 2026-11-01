// One function per Admin API route. To add an endpoint: put its wire types in
// `types.ts` (live) or `planned-types.ts` (planned), add a function here, a
// query key + hook in `queries.ts`, and — for planned routes — a section in
// `API-PLAN.md`.

import { type ApiClient, seg } from "./http";
import type {
  AdjustPersonRequest,
  AssignRoleRequest,
  CostReport,
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
  StageState,
  StreamAction,
  UpdateMemoryRequest,
  UpdatePersonRequest,
  UpsertRoleRequest,
  VoiceState,
} from "./planned-types";
import type {
  AuthMethods,
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
    // --- live (crates/miyoria-api/src/server.rs) ---------------------------
    health: (o?: Opts) => client.get<HealthInfo>("/api/health", { ...o, public: true }),

    // --- panel login (crates/miyoria-api/src/oauth.rs) ----------------------
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

    // --- panel routes (API-PLAN.md) -----------------------------------------
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
    mcpAction: (name: string, action: "enable" | "disable" | "restart") =>
      client.post<McpServerInfo>(`/api/mcp/${seg(name)}/${action}`),

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

    voice: (o?: Opts) => client.get<VoiceState>("/api/voice", o),
  };
}

export type Api = ReturnType<typeof createApi>;
