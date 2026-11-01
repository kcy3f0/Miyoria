import { type Query, QueryCache, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isApiError } from "../api/http";
import type { MemoryQuery, PeopleQuery, UpdateMemoryRequest, UpdatePersonRequest } from "../api/planned-types";
import type { DecisionsQuery, ModuleAction, ModuleInfo, SetPersonaRequest } from "../api/types";
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
  memory: (q: MemoryQuery) => ["memory", q] as const,
  roles: ["auth", "roles"] as const,
  assignments: ["auth", "assignments"] as const,
  extensions: ["extensions"] as const,
  mcp: ["mcp"] as const,
  queue: ["queue"] as const,
  stage: ["stage"] as const,
  voice: ["voice"] as const,
};

/** Polls every `ms`, but stops once the route turned out not to exist or the token is bad. */
const poll =
  (ms: number) =>
  (query: Query<any, any, any, any>): number | false => {
    const e = query.state.error;
    return isApiError(e) && FINAL.has(e.kind) ? false : ms;
  };

/** Errors that retrying cannot fix. */
const FINAL = new Set(["unauthorized", "not_provided", "not_found", "bad_response"]);

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

// --- live --------------------------------------------------------------------

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

export function useDecisions(q: DecisionsQuery) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.decisions(q), queryFn: ({ signal }) => api.decisions(q, { signal }) });
}

export function useUsage() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.usage, queryFn: ({ signal }) => api.llmUsage({ signal }), refetchInterval: poll(30_000) });
}

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

// --- planned -----------------------------------------------------------------

export function useCost() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.cost, queryFn: ({ signal }) => api.llmCost({ signal }), refetchInterval: poll(60_000) });
}

export function usePeople(q: PeopleQuery) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.people(q), queryFn: ({ signal }) => api.people(q, { signal }) });
}

export function usePerson(id: string) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.person(id), queryFn: ({ signal }) => api.person(id, { signal }) });
}

export function useUpdatePerson(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdatePersonRequest) => api.updatePerson(id, req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["people"] }),
  });
}

export function useMemory(q: MemoryQuery) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.memory(q), queryFn: ({ signal }) => api.memory(q, { signal }) });
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

export function useRoles() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.roles, queryFn: ({ signal }) => api.roles({ signal }) });
}

export function useAssignments() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.assignments, queryFn: ({ signal }) => api.assignments({ signal }) });
}

export function useExtensions() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.extensions, queryFn: ({ signal }) => api.extensions({ signal }) });
}

export function useExtensionAction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "enable" | "disable" | "restart" }) => api.extensionAction(id, action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.extensions }),
  });
}

export function useMcpServers() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.mcp, queryFn: ({ signal }) => api.mcpServers({ signal }) });
}

export function useMcpAction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, action }: { name: string; action: "enable" | "disable" | "restart" }) => api.mcpAction(name, action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.mcp }),
  });
}

export function useQueue() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.queue, queryFn: ({ signal }) => api.queue({ signal }), refetchInterval: poll(3_000) });
}

export function useStage() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.stage, queryFn: ({ signal }) => api.stage({ signal }), refetchInterval: poll(5_000) });
}

export function useVoice() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.voice, queryFn: ({ signal }) => api.voice({ signal }), refetchInterval: poll(5_000) });
}
