import {
  type Query,
  QueryCache,
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { isApiError } from "@/api/http";
import type {
  AdjustPersonRequest,
  AssignRoleRequest,
  DataCategoryId,
  DecisionsQuery,
  MemoryQuery,
  ModuleAction,
  ModuleInfo,
  PeopleQuery,
  QueueState,
  RemoveMappingRequest,
  RoleMapping,
  SayRequest,
  SceneRolesState,
  SetPersonaRequest,
  StageState,
  StreamAction,
  UpdateMemoryRequest,
  UpdatePersonRequest,
  UpsertRoleRequest,
} from "@/api/types";
import { useApi } from "./connection";

export const queryKeys = {
  health: ["health"] as const,
  modules: ["modules"] as const,
  decisionsAll: ["decisions"] as const,
  decisions: (q: DecisionsQuery) => ["decisions", q] as const,
  usage: ["llm", "usage"] as const,
  cost: ["llm", "cost"] as const,
  persona: ["persona"] as const,
  personaHistory: (key: string) => ["persona", key, "history"] as const,
  people: (q: PeopleQuery) => ["people", q] as const,
  person: (id: string) => ["people", "detail", id] as const,
  memory: (q: Omit<MemoryQuery, "before">) => ["memory", q] as const,
  roles: ["auth", "roles"] as const,
  assignments: ["auth", "assignments"] as const,
  mappings: (platform: string, guild: string) => ["auth", "mappings", platform, guild] as const,
  extensions: ["extensions"] as const,
  mcp: ["mcp"] as const,
  queue: ["queue"] as const,
  stage: ["stage"] as const,
  sceneRoles: ["stage", "scenes"] as const,
  voice: ["voice"] as const,
  self: ["self"] as const,
  world: ["world"] as const,
  data: ["data"] as const,
  mind: ["mind"] as const,
  thoughts: ["mind", "thoughts"] as const,
  approvals: ["mind", "approvals"] as const,
};

/** Errors that retrying cannot fix. */
const FINAL = new Set(["unauthorized", "not_provided", "not_found", "bad_response"]);

/** Polls every `ms`, but stops once the route turned out not to exist or the token is bad. */
const poll =
  (ms: number) =>
  (query: Query<any, any, any, any>): number | false => {
    const e = query.state.error;
    return isApiError(e) && FINAL.has(e.kind) ? false : ms;
  };

export function createQueryClient(onError?: (error: Error) => void): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: (error) => onError?.(error) }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        retry: (count, error) => !(isApiError(error) && FINAL.has(error.kind)) && count < 2,
      },
      mutations: { retry: false },
    },
  });
}

// --- system ------------------------------------------------------------------

export function useHealth() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.health, queryFn: ({ signal }) => api.health({ signal }), refetchInterval: poll(15_000) });
}

export function useModules() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.modules, queryFn: ({ signal }) => api.modules({ signal }), refetchInterval: poll(20_000) });
}

export function useModuleAction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ModuleAction }) => api.moduleAction(id, action),
    onSuccess: (updated) => {
      qc.setQueryData<ModuleInfo[]>(queryKeys.modules, (list) => list?.map((m) => (m.id === updated.id ? updated : m)));
      void qc.invalidateQueries({ queryKey: queryKeys.modules });
    },
  });
}

export function useExtensions() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.extensions, queryFn: ({ signal }) => api.extensions({ signal }), refetchInterval: poll(30_000) });
}

export function useExtensionAction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ModuleAction }) => api.extensionAction(id, action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.extensions }),
  });
}

export function useMcpServers() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.mcp, queryFn: ({ signal }) => api.mcpServers({ signal }), refetchInterval: poll(30_000) });
}

export function useMcpRestart() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.mcpRestart(name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.mcp }),
  });
}

// --- activity ----------------------------------------------------------------

export function useDecisions(q: DecisionsQuery) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.decisions(q), queryFn: ({ signal }) => api.decisions(q, { signal }) });
}

export function useUsage() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.usage, queryFn: ({ signal }) => api.llmUsage({ signal }), refetchInterval: poll(30_000) });
}

export function useCost() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.cost, queryFn: ({ signal }) => api.llmCost({ signal }), refetchInterval: poll(60_000) });
}

// --- character ---------------------------------------------------------------

export function usePersona() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.persona, queryFn: ({ signal }) => api.persona({ signal }) });
}

export function usePersonaHistory(key: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.personaHistory(key ?? ""),
    queryFn: ({ signal }) => api.personaHistory(key ?? "", { signal }),
    enabled: Boolean(key),
  });
}

export function useSetPersona() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, req }: { key: string; req: SetPersonaRequest }) => api.setPersonaSection(key, req),
    onSuccess: (_res, { key }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.persona });
      void qc.invalidateQueries({ queryKey: queryKeys.personaHistory(key) });
    },
  });
}

export function usePeople(q: PeopleQuery, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.people(q), queryFn: ({ signal }) => api.people(q, { signal }), enabled });
}

export function usePerson(id: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.person(id ?? ""),
    queryFn: ({ signal }) => api.person(id ?? "", { signal }),
    enabled: Boolean(id),
  });
}

export function useUpdatePerson(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdatePersonRequest) => api.updatePerson(id, req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["people"] }),
  });
}

export function useAdjustPerson(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: AdjustPersonRequest) => api.adjustPerson(id, req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["people"] }),
  });
}

const MEMORY_PAGE = 50;

/** Newest first, one page at a time: `next_cursor` is the `before` of the next page. */
export function useMemory(q: Omit<MemoryQuery, "before" | "limit">) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.memory(q),
    queryFn: ({ signal, pageParam }) =>
      api.memory({ ...q, limit: MEMORY_PAGE, before: pageParam ?? undefined }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function useUpdateMemory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: UpdateMemoryRequest }) => api.updateMemory(id, req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["memory"] }),
  });
}

export function useDeleteMemory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMemory(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["memory"] }),
  });
}

// --- access ------------------------------------------------------------------

export function useRoles() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.roles, queryFn: ({ signal }) => api.roles({ signal }) });
}

export function useAssignments() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.assignments, queryFn: ({ signal }) => api.assignments({ signal }) });
}

export function useMappings(platform: string, guild: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.mappings(platform, guild),
    queryFn: ({ signal }) => api.mappings(platform, guild, { signal }),
    enabled: Boolean(platform && guild),
  });
}

export function useAccessMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const auth = () => void qc.invalidateQueries({ queryKey: ["auth"] });
  return {
    assign: useMutation({ mutationFn: (r: AssignRoleRequest) => api.assignRole(r), onSuccess: auth }),
    revoke: useMutation({ mutationFn: (r: AssignRoleRequest) => api.revokeRole(r), onSuccess: auth }),
    upsertRole: useMutation({
      mutationFn: ({ name, req }: { name: string; req: UpsertRoleRequest }) => api.upsertRole(name, req),
      onSuccess: auth,
    }),
    deleteRole: useMutation({ mutationFn: (name: string) => api.deleteRole(name), onSuccess: auth }),
    setMapping: useMutation({ mutationFn: (m: RoleMapping) => api.setMapping(m), onSuccess: auth }),
    removeMapping: useMutation({ mutationFn: (m: RemoveMappingRequest) => api.removeMapping(m), onSuccess: auth }),
  };
}

// --- live --------------------------------------------------------------------

export function useQueue() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.queue, queryFn: ({ signal }) => api.queue({ signal }), refetchInterval: poll(3_000) });
}

export function useQueueMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (state: QueueState) => qc.setQueryData(queryKeys.queue, state);
  return {
    skip: useMutation({ mutationFn: (id: string) => api.queueSkip(id), onSuccess: set }),
    move: useMutation({
      mutationFn: ({ id, position }: { id: string; position: number }) => api.queueMove(id, position),
      onSuccess: set,
    }),
    pause: useMutation({ mutationFn: (paused: boolean) => api.queuePause(paused), onSuccess: set }),
  };
}

export function useStage() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.stage, queryFn: ({ signal }) => api.stage({ signal }), refetchInterval: poll(5_000) });
}

export function useStageMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (state: StageState) => qc.setQueryData(queryKeys.stage, state);
  return {
    scene: useMutation({ mutationFn: (name: string) => api.stageScene(name), onSuccess: set }),
    expression: useMutation({ mutationFn: (name: string) => api.stageExpression(name), onSuccess: set }),
    stream: useMutation({ mutationFn: (action: StreamAction) => api.stageStream(action), onSuccess: set }),
    say: useMutation({ mutationFn: (req: SayRequest) => api.stageSay(req) }),
  };
}

export function useSceneRoles() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.sceneRoles,
    queryFn: ({ signal }) => api.sceneRoles({ signal }),
    refetchInterval: poll(15_000),
  });
}

export function useSceneRoleMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (state: SceneRolesState) => qc.setQueryData(queryKeys.sceneRoles, state);
  return {
    set: useMutation({
      mutationFn: ({ role, scene }: { role: string; scene: string | null }) => api.setSceneRole(role, scene),
      onSuccess: set,
    }),
    classify: useMutation({ mutationFn: () => api.classifyScenes(), onSuccess: set }),
  };
}

export function useVoice() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.voice, queryFn: ({ signal }) => api.voice({ signal }), refetchInterval: poll(5_000) });
}

// --- inner life --------------------------------------------------------------

export function useSelf() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.self, queryFn: ({ signal }) => api.self({ signal }), refetchInterval: poll(5_000) });
}

export function useWorld() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.world, queryFn: ({ signal }) => api.world({ signal }), refetchInterval: poll(5_000) });
}

// --- data --------------------------------------------------------------------

export function useDataInventory() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.data, queryFn: ({ signal }) => api.dataInventory({ signal }), refetchInterval: poll(30_000) });
}

/** Deletes and the reset change what every page shows: everything is refetched. */
export function useDataMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const all = () => void qc.invalidateQueries();
  return {
    wipe: useMutation({
      mutationFn: ({ categories, confirm }: { categories: DataCategoryId[]; confirm?: string }) => api.dataWipe(categories, confirm),
      onSuccess: all,
    }),
    reset: useMutation({
      mutationFn: ({ confirm, token }: { confirm: string; token: string }) => api.dataReset(confirm, token),
      onSuccess: all,
    }),
  };
}
export function useMind() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.mind, queryFn: ({ signal }) => api.mind({ signal }), refetchInterval: poll(5_000) });
}

export function useThoughts(limit = 50) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.thoughts,
    queryFn: ({ signal }) => api.thoughts(limit, { signal }),
    refetchInterval: poll(5_000),
  });
}

export function useApprovals() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.approvals, queryFn: ({ signal }) => api.approvals({ signal }), refetchInterval: poll(5_000) });
}

export function useMindMutations() {
  const api = useApi();
  const qc = useQueryClient();
  return {
    pause: useMutation({
      mutationFn: (paused: boolean) => api.autonomyPause(paused),
      onSuccess: (view) => qc.setQueryData(queryKeys.mind, view),
    }),
    answer: useMutation({
      mutationFn: ({ id, approved }: { id: string; approved: boolean }) => api.answerApproval(id, approved),
      onSuccess: (pending) => {
        qc.setQueryData(queryKeys.approvals, pending);
        void qc.invalidateQueries({ queryKey: queryKeys.mind });
      },
    }),
  };
}

