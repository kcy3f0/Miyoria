// `/api/memory*`: browse, search, edit and delete her long-term memories (active profile).
// Searches use the memory engine's hybrid recall when the memory module runs, else the store's
// full-text search; either way over every scope of the profile (an admin view).

import { type MemoryEngine, MemoryEngineKey, tokenString } from "@miyoria/memory";
import {
  type MemoryFilter,
  type MemoryHit,
  type MemoryKind,
  type MemoryRecord,
  type MemoryRecordStore,
  MemoryRecordStoreKey,
  type MemoryScope,
} from "@miyoria/store";
import { isUlid, type ProfileId, toTimestamp } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { boolParam, readJson, readQuery, usizeParam } from "./extract.js";
import { json, noContent, param, type Route } from "./route.js";
import { type ApiContext, type ApiState, toJson } from "./state.js";
import type { MemoryItem, MemoryRecordView, Page, UpdateMemoryRequest } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** Upper bound when collecting the profile's scopes for a search. */
const SCAN_LIMIT = 100_000;
const MAX_CONTENT_CHARS = 4000;

const ALL_KINDS: MemoryKind[] = ["episode", "fact", "self_note", "followup"];
const MemoryKindSchema = z.enum(ALL_KINDS);

/** A record without its search tokens and embedding vector. */
export function recordView(r: MemoryRecord): MemoryRecordView {
  return {
    id: r.id,
    profile: r.profile,
    kind: r.kind,
    scope: r.scope,
    subjects: r.subjects,
    content: r.content,
    importance: r.importance,
    confidence: r.confidence,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_accessed: r.last_accessed,
    access_count: r.access_count,
    source_context: r.source_context,
    due: r.due,
    done: r.done,
    superseded_by: r.superseded_by,
    has_embedding: r.embedding !== null && r.embedding.length > 0,
  };
}

interface Records {
  store: MemoryRecordStore;
  profile: ProfileId;
  /** The memory module's engine, when it runs (hybrid search). */
  engine: MemoryEngine | null;
}

/** The memory module's store and profile, else the app's store and the active profile. */
function records(state: ApiState): Records {
  const engine = state.optional(MemoryEngineKey);
  if (engine) return { store: engine.records, profile: engine.profile, engine };
  const store = state.service(MemoryRecordStoreKey, "memory store");
  return { store, profile: state.profile(), engine: null };
}

const ListQuerySchema = z.object({
  q: z.string().optional(),
  kind: MemoryKindSchema.optional(),
  subject: z
    .string()
    .transform((s) => s.toUpperCase())
    .refine(isUlid, "invalid ULID")
    .optional(),
  before: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "invalid timestamp")
    .optional(),
  include_superseded: boolParam.optional(),
  limit: usizeParam.optional(),
});
type ListQuery = z.output<typeof ListQuerySchema>;

function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function list(state: ApiState, c: ApiContext): Promise<Response> {
  const q = readQuery(c, ListQuerySchema);
  const recs = records(state);
  const { store, profile } = recs;
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const text = q.q?.trim() ?? "";
  if (text !== "") return json(await search(state, recs, q, text, limit));

  const filter: MemoryFilter = {
    subject: q.subject ?? null,
    scope: null,
    kind: q.kind ?? null,
    before: q.before ?? null,
    include_superseded: q.include_superseded ?? false,
    limit: limit + 1,
  };
  const found = await store.list(profile, filter);
  const more = found.length > limit;
  const kept = found.slice(0, limit);
  const last = kept[kept.length - 1];
  const page: Page<MemoryItem> = {
    items: kept.map((r) => ({ record: recordView(r) })),
    next_cursor: more && last ? last.created_at : null,
  };
  return json(page);
}

/** Every scope the profile has records in: an admin search may look everywhere. */
async function profileScopes(store: MemoryRecordStore, profile: ProfileId): Promise<MemoryScope[]> {
  const all = await store.list(profile, {
    subject: null,
    scope: null,
    kind: null,
    before: null,
    include_superseded: false,
    limit: SCAN_LIMIT,
  });
  const scopes: MemoryScope[] = [];
  for (const r of all) {
    if (!scopes.some((s) => sameScope(s, r.scope))) scopes.push(r.scope);
  }
  return scopes;
}

/** Search over every scope of the profile. Superseded records are never returned. */
async function search(
  state: ApiState,
  recs: Records,
  q: ListQuery,
  text: string,
  limit: number,
): Promise<Page<MemoryItem>> {
  const { store, profile, engine } = recs;
  const before = q.before !== undefined ? Date.parse(q.before) : null;
  const keep = (r: MemoryRecord) =>
    (q.subject === undefined || r.subjects.includes(q.subject)) &&
    (before === null || Date.parse(r.created_at) < before);
  let items: MemoryItem[];
  if (engine) {
    const scopes = await profileScopes(store, profile);
    const kinds = q.kind ? [q.kind] : ALL_KINDS;
    const found = await engine.search(scopes, text, kinds, MAX_LIMIT, toTimestamp(state.now()));
    items = found
      .filter((h) => keep(h.record))
      .slice(0, limit)
      .map((h) => ({
        record: recordView(h.record),
        text_score: h.text_score,
        vector_score: h.vector_score,
        score: h.score,
      }));
  } else {
    const hits = await textSearch(state, store, profile, q, text);
    const score = (h: MemoryHit) => Math.max(h.text_score, h.vector_score ?? 0);
    items = hits
      .filter((h) => keep(h.record))
      .sort(
        (a, b) =>
          score(b) - score(a) || Date.parse(b.record.created_at) - Date.parse(a.record.created_at),
      )
      .slice(0, limit)
      .map((h) => ({
        record: recordView(h.record),
        text_score: h.text_score,
        vector_score: h.vector_score,
      }));
  }
  return { items, next_cursor: null };
}

/** The store's full-text search (no memory module). */
async function textSearch(
  state: ApiState,
  store: MemoryRecordStore,
  profile: ProfileId,
  q: ListQuery,
  text: string,
): Promise<MemoryHit[]> {
  const tokens = state.tokenize(text);
  if (tokens.length === 0) return [];
  const scopes = await profileScopes(store, profile);
  if (scopes.length === 0) return [];
  return store.search({
    profile,
    scopes,
    kinds: q.kind ? [q.kind] : null,
    tokens,
    embedding: null,
    limit: MAX_LIMIT,
  });
}

function unknownMemory(id: string): ApiError {
  return ApiError.notFound(`unknown memory \`${id}\``);
}

/** The record with this id in the profile. */
async function find(
  store: MemoryRecordStore,
  profile: ProfileId,
  id: string,
): Promise<MemoryRecord> {
  const ulid = id.toUpperCase();
  if (!isUlid(ulid)) throw unknownMemory(id);
  const record = await store.get(ulid);
  if (!record || record.profile !== profile) throw unknownMemory(id);
  return record;
}

const UpdateMemorySchema = z
  .object({
    content: z.string().nullish(),
    kind: MemoryKindSchema.nullish(),
    importance: z.number().nullish(),
    done: z.boolean().nullish(),
  })
  .transform((r): UpdateMemoryRequest => {
    const out: UpdateMemoryRequest = {};
    if (r.content != null) out.content = r.content;
    if (r.kind != null) out.kind = r.kind;
    if (r.importance != null) out.importance = r.importance;
    if (r.done != null) out.done = r.done;
    return out;
  });

async function update(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, UpdateMemorySchema);
  const content = request.content?.trim();
  if (content === "") throw ApiError.badRequest("`content` must not be empty");
  if (content !== undefined && [...content].length > MAX_CONTENT_CHARS) {
    throw ApiError.badRequest(`\`content\` is longer than ${MAX_CONTENT_CHARS} characters`);
  }
  if (request.importance !== undefined && !(request.importance >= 0 && request.importance <= 1)) {
    throw ApiError.badRequest("`importance` must be between 0 and 1");
  }
  const { store, profile } = records(state);
  const record = { ...(await find(store, profile, param(c, "id"))) };
  if (content !== undefined && content !== record.content) {
    record.content = content;
    record.tokens = tokenString(content);
    // The memory module does not expose its embedder; drop the stale vector rather than keep
    // one that describes the old text.
    record.embedding = null;
  }
  if (request.kind !== undefined) record.kind = request.kind;
  if (request.importance !== undefined) record.importance = request.importance;
  if (request.done !== undefined) record.done = request.done;
  record.updated_at = toTimestamp(state.now());
  let failure: unknown = null;
  try {
    await store.upsert(record);
  } catch (error) {
    failure = error;
  }
  const detail = toJson(request) as Record<string, unknown>;
  if (failure !== null) detail.error = ApiError.internal(failure).message;
  await state.audit(c, "memory.update", record.id, toJson(detail), failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  return json(recordView(record));
}

async function remove(state: ApiState, c: ApiContext): Promise<Response> {
  const id = param(c, "id");
  const { store, profile } = records(state);
  const record = await find(store, profile, id);
  let removed = false;
  let failure: unknown = null;
  try {
    removed = await store.delete(record.id);
  } catch (error) {
    failure = error;
  }
  const detail = toJson({ kind: record.kind, scope: record.scope, content: record.content });
  await state.audit(c, "memory.delete", record.id, detail, failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  if (!removed) throw unknownMemory(id);
  return noContent();
}

export function memoryRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/memory", handler: (c) => list(state, c) },
    { method: "PATCH", path: "/api/memory/:id", handler: (c) => update(state, c) },
    { method: "DELETE", path: "/api/memory/:id", handler: (c) => remove(state, c) },
  ];
}
