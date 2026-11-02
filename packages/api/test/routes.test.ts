// Route groups added for the admin panel: a real supervisor running the `api` module, in-memory
// stores, the real auth service and request queue, and fakes for the services of packages that
// are ported separately (`tests/routes.rs`).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/actions";
import { AuthService, AuthServiceKey } from "@miyoria/auth";
import { ExtensionCatalog, ExtensionCatalogKey, ExtensionManifest } from "@miyoria/ext-host";
import { Supervisor, SupervisorKey } from "@miyoria/kernel";
import { LlmRouter, LlmRouterKey } from "@miyoria/llm";
import { McpStatus, McpStatusKey, newServerStatus } from "@miyoria/mcp";
import {
  type Embedder,
  MemoryEngine,
  MemoryEngineKey,
  memoryConfig,
  tokenString,
} from "@miyoria/memory";
import { RequestQueue, RequestQueueKey } from "@miyoria/queue";
import { Social, SocialKey, socialConfig } from "@miyoria/social";
import {
  defaultStageStatus,
  SceneRoles,
  SceneRolesKey,
  ScenesConfigSchema,
  type StageLink,
  StageLinkKey,
  StageLinkModule,
  type StageStatus,
} from "@miyoria/stage";
import {
  type AuditEntry,
  AuditLogKey,
  AuthStoreKey,
  IdentityStoreKey,
  type MemoryKind,
  type MemoryRecord,
  MemoryRecordStoreKey,
  PeopleStoreKey,
  RelationshipStoreKey,
  type RoleMapping,
  SqliteStore,
} from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  type JsonValue,
  newId,
  type PersonId,
  type PlatformSink,
  PlatformSinks,
  PlatformSinksKey,
  VoiceSinkKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActiveProfileKey,
  ApiClient,
  ApiModule,
  type ApiModuleOptions,
  type AssignRoleRequest,
  avatarEmotions,
} from "../src/index.js";
import { FakeSink, Idle } from "./support/fakes.js";
import { errorOf, raw, statusOf, waitFor } from "./support/http.js";
import { TestStore } from "./support/stores.js";

const TOKEN = "test-token";
const PROFILE = "test-chan";

interface Harness {
  sup: Supervisor;
  store: TestStore;
  social: Social;
  queue: RequestQueue;
  sink: FakeSink;
  client: ApiClient;
  base: string;
}

const harnesses: Harness[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.sup.stopAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function harness(
  apiConfig: Record<string, JsonValue> = {},
  options: ApiModuleOptions = {},
): Promise<Harness> {
  const sup = new Supervisor();
  const store = new TestStore();
  const s = sup.services;
  const k = "kernel";
  s.provide(k, SupervisorKey, sup);
  s.provide(k, ActiveProfileKey, PROFILE);
  s.provide(k, PeopleStoreKey, store.people);
  s.provide(k, RelationshipStoreKey, store.relationships);
  s.provide(k, IdentityStoreKey, store.identity);
  s.provide(k, MemoryRecordStoreKey, store.memories);
  s.provide(k, AuthStoreKey, store.auth);
  s.provide(k, AuditLogKey, store.audit);
  s.provide("llm", LlmRouterKey, new LlmRouter(new Map(), new Map()));

  const social = new Social(
    PROFILE,
    "Test",
    [],
    socialConfig(),
    { people: store.people, relationships: store.relationships, identity: store.identity },
    () => {},
  );
  s.provide("social", SocialKey, social);
  const auth = await AuthService.load(store.auth, store.audit, [], "user");
  s.provide("auth", AuthServiceKey, auth);
  const queue = new RequestQueue();
  s.provide("queue", RequestQueueKey, queue);
  s.provide("mcp", McpStatusKey, new McpStatus());
  s.provide("extensions", ExtensionCatalogKey, catalog());
  const sink = new FakeSink();
  s.provide("voice", VoiceSinkKey, sink);
  // The app's gate (with the built-in `speak`); the panel's say goes through it.
  s.provide(k, ActuatorRegistryKey, new ActuatorRegistry({ services: s }));

  const api = new ApiModule({ env: () => undefined, ...options });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "", ...apiConfig }, true);
  await sup.register(new Idle("ext.demo", "Demo"), null, true);
  await sup.startAll();

  const base = api.url();
  if (!base) throw new Error("api is not running");
  const h = { sup, store, social, queue, sink, client: new ApiClient(base, TOKEN), base };
  harnesses.push(h);
  return h;
}

async function audited(h: Harness, action: string): Promise<AuditEntry> {
  const entry = (await h.store.audit.recent(100, "api")).find((e) => e.action === action);
  if (!entry) throw new Error(`no \`${action}\` audit entry`);
  return entry;
}

function catalog(): ExtensionCatalog {
  const manifest = ExtensionManifest.parse(
    [
      'id = "demo"',
      'version = "0.2.1"',
      'name = "Demo"',
      'description = "Says hi"',
      'runtime = "node"',
      'entry = "index.mjs"',
    ].join("\n"),
  );
  const granted = { tools: true, commands: false, events: ["game.*"], network: [], input: [] };
  return new ExtensionCatalog([
    { spec: { manifest, dir: "extensions/demo", granted }, enabled: true },
  ]);
}

function account(id: string): AccountRef {
  return { platform: "discord", id };
}

function voiceContext(): ContextKey {
  return { platform: "discord", scope: "g1", channel: "vc1", kind: "voice" };
}

/** Fixed vectors per text (a short vector equally close to every axis otherwise). */
class TableEmbedder implements Embedder {
  readonly name = "table";
  readonly enabled = true;
  constructor(readonly table: Map<string, number[]>) {}
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => [...(this.table.get(t) ?? [0.01, 0.01, 0.01])]);
  }
}

function memory(
  person: PersonId | null,
  kind: MemoryKind,
  content: string,
  minute: number,
): MemoryRecord {
  const at = new Date(Date.UTC(2026, 9, 1, 12, minute, 0)).toISOString();
  return {
    id: newId(),
    profile: PROFILE,
    kind,
    scope: person ? { type: "person", person } : { type: "global" },
    subjects: person ? [person] : [],
    content,
    tokens: tokenString(content),
    embedding: [0.1, 0.2],
    importance: 0.5,
    confidence: 0.9,
    created_at: at,
    updated_at: at,
    last_accessed: null,
    access_count: 0,
    source_context: null,
    source: null,
    due: null,
    done: false,
    superseded_by: null,
  };
}

describe("routes", () => {
  it("fallback_and_unavailable_shapes", async () => {
    const h = await harness();
    for (const path of ["/api/nope", "/api", "/api/people/x/nope", "/"]) {
      const r = await raw(h.base, "GET", path, { token: TOKEN });
      expect(r.status, path).toBe(404);
      expect(r.body, path).toEqual({ error: "no such endpoint" });
    }
    // New routes are protected like the old ones.
    const anon = new ApiClient(h.base, "wrong");
    expect(await statusOf(anon.queue())).toBe(401);

    // A stopped module's service yields 503 with a JSON error.
    const stage = await raw(h.base, "GET", "/api/stage", { token: TOKEN });
    expect(stage.status).toBe(503);
    expect((stage.body as { error: string }).error).toContain("stage link");
    h.sup.services.removeOwnedBy("llm");
    expect(await statusOf(h.client.cost())).toBe(503);
    h.sup.services.removeOwnedBy("queue");
    const queue = await raw(h.base, "GET", "/api/queue", { token: TOKEN });
    expect(queue.status).toBe(503);
    expect(typeof (queue.body as { error: unknown }).error).toBe("string");
  });

  it("llm_cost_report", async () => {
    const h = await harness();
    const cost = await h.client.cost();
    expect(cost.today.calls).toBe(0);
    expect(cost.today.period).toHaveLength("2026-11-01".length);
    expect(cost.month.period).toHaveLength("2026-11".length);
    const r = await raw(h.base, "GET", "/api/llm/cost", { token: TOKEN });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body.state).toBe("ok");
    for (const key of ["daily_usd", "monthly_usd", "degrade_at", "today", "month"]) {
      expect(body, `missing \`${key}\``).toHaveProperty(key);
    }
  });

  it("people_list_detail_and_changes", async () => {
    const h = await harness();
    const c = h.client;
    const now = Date.now();
    const owen = await h.store.people.upsertAccount(account("1"), "Owen");
    const mika = await h.store.people.upsertAccount(account("2"), "Mika");
    await h.social.adjust(owen, 10, "test", now);
    await h.social.adjust(owen, 5, "test", now);
    await h.social.adjust(mika, -3, "test", now);
    await h.store.memories.upsert(memory(owen, "fact", "Owen 喜歡拉麵", 0));

    let page = await c.people();
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
    page = await c.people({ q: "owe" });
    expect(page.items).toHaveLength(1);
    const summary = page.items[0];
    expect(summary?.person.id).toBe(owen);
    expect(summary?.person.display_name).toBe("Owen");
    expect(summary?.person.accounts[0]?.account).toEqual(account("1"));
    expect(summary?.relationship?.affinity).toBe(15);
    expect(summary?.label).not.toBeNull();
    expect(summary?.blocked).toBe(false);
    page = await c.people({ limit: 1 });
    expect(page.items).toHaveLength(1);
    const cursor = page.next_cursor;
    expect(cursor, "a second page").not.toBeNull();
    page = await c.people({ limit: 1, cursor: cursor ?? "" });
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeNull();

    const detail = await c.person(owen);
    expect(
      detail.history.map((d) => d.affinity),
      "absolute levels, oldest first",
    ).toEqual([10, 15]);
    expect(detail.memory_count).toBe(1);
    const flat = await raw(h.base, "GET", `/api/people/${owen}`, { token: TOKEN });
    expect(flat.body, "flattened").toHaveProperty("person");
    expect(flat.body).toHaveProperty("history");

    const updated = await c.updatePerson(owen, {
      tags: ["常客", " Minecraft ", "常客"],
      notes: "喜歡拉麵",
      call_name: "歐文",
      blocked: true,
    });
    const rel = updated.relationship;
    expect([...(rel?.tags ?? [])].sort()).toEqual(["Minecraft", "blocked", "常客"]);
    expect(rel?.notes).toBe("喜歡拉麵");
    expect(rel?.call_name).toBe("歐文");
    expect(updated.blocked).toBe(true);
    expect(h.social.relationship(owen)?.notes, "the engine's cache sees the notes").toBe(
      "喜歡拉麵",
    );
    const entry = await audited(h, "person.update");
    expect(entry.target).toBe(owen);
    expect(entry.ok).toBe(true);

    // `null` clears the call name; omitted fields stay.
    const patched = await raw(h.base, "PATCH", `/api/people/${owen}`, {
      token: TOKEN,
      json: { call_name: null, blocked: false, tags: ["常客"] },
    });
    expect(patched.status).toBe(200);
    const body = patched.body as {
      relationship: { call_name: unknown; notes: string; tags: string[] };
      blocked: boolean;
    };
    expect(body.relationship.call_name).toBeNull();
    expect(body.relationship.notes).toBe("喜歡拉麵");
    expect(body.relationship.tags).toEqual(["常客"]);
    expect(body.blocked).toBe(false);

    const adjusted = await c.adjustPerson(mika, 20);
    expect(adjusted.relationship?.affinity).toBe(17);
    await audited(h, "person.adjust");

    for (const id of [newId(), "nope"]) {
      const err = await errorOf(c.person(id));
      expect(err.status).toBe(404);
      expect(err.message).toContain("unknown person");
    }
    expect(await statusOf(c.updatePerson(newId(), {}))).toBe(404);

    h.sup.services.removeOwnedBy("social");
    expect(await statusOf(c.updatePerson(owen, {}))).toBe(503);
    // Reads still work from the stores.
    expect((await c.people()).items).toHaveLength(2);
  });

  it("people_list_includes_people_without_a_relationship", async () => {
    const h = await harness();
    const c = h.client;
    const now = Date.now();
    const owen = await h.store.people.upsertAccount(account("1"), "Owen");
    const mika = await h.store.people.upsertAccount(account("2"), "Mika");
    const lurker = await h.store.people.upsertAccount(account("3"), "Lurker");
    await h.social.adjust(owen, 10, "test", now);

    let page = await c.people();
    const order = page.items.map((i) => i.person.id);
    expect(order[0], "with a relationship first").toBe(owen);
    expect([...order].sort()).toEqual([owen, mika, lurker].sort());
    const stranger = page.items.find((i) => i.person.id === mika);
    expect(stranger?.relationship).toBeNull();
    expect(stranger?.label).toBe("陌生人");
    expect(stranger?.blocked).toBe(false);
    expect(stranger?.person.display_name).toBe("Mika");
    expect(stranger?.person.accounts.map((a) => a.account)).toEqual([account("2")]);
    expect(page.items[0]?.relationship?.affinity).toBe(10);

    page = await c.people({ q: "mik" });
    expect(page.items.map((i) => i.person.id)).toEqual([mika]);
    page = await c.people({ q: "discord" });
    expect(page.items, "account ids are not matched by platform").toHaveLength(0);
    page = await c.people({ q: "3" });
    expect(
      page.items.map((i) => i.person.id),
      "account id",
    ).toEqual([lurker]);

    page = await c.people({ limit: 2 });
    expect(page.items.map((i) => i.person.id)).toEqual(order.slice(0, 2));
    expect(page.next_cursor).toBe("2");
    page = await c.people({ limit: 2, cursor: "2" });
    expect(page.items.map((i) => i.person.id)).toEqual(order.slice(2));
    expect(page.next_cursor).toBeNull();

    // A relationship the engine has not written yet still shows.
    await h.social.adjust(mika, 1, "test", now);
    page = await c.people();
    expect(page.items.find((i) => i.person.id === mika)?.relationship?.affinity).toBe(1);
    const detail = await c.person(lurker);
    expect(detail.relationship).toBeNull();
    expect(detail.label).toBe("陌生人");
    expect(detail.memory_count).toBe(0);
  });

  it("memory_search_uses_hybrid_recall", async () => {
    const h = await harness();
    const c = h.client;
    const sqlite = await SqliteStore.open(":memory:");
    try {
      const embedder = new TableEmbedder(
        new Map([
          ["Owen 喜歡 豚骨 拉麵", [1, 0, 0]],
          ["大家 一起 玩 Minecraft", [0, 1, 0]],
          ["Owen 下週 要 看 牙醫", [0, 0, 1]],
          ["他愛吃什麼", [0.9, 0.1, 0]],
          ["Minecraft", [0, 1, 0]],
        ]),
      );
      const engine = new MemoryEngine(PROFILE, memoryConfig(), sqlite.memories, { embedder });
      h.sup.services.provide("memory", MemoryEngineKey, engine);
      const owen = newId();
      const withVector = async (r: MemoryRecord) => {
        r.embedding = (await embedder.embed([r.content]))[0] ?? null;
        await sqlite.memories.upsert(r);
        return r;
      };
      const ramen = await withVector(memory(owen, "fact", "Owen 喜歡 豚骨 拉麵", 1));
      const game = await withVector(memory(null, "episode", "大家 一起 玩 Minecraft", 2));
      const dentist = memory(owen, "followup", "Owen 下週 要 看 牙醫", 3);
      dentist.scope = { type: "dm", account: account("1") };
      dentist.done = true;
      await withVector(dentist);
      const old = memory(owen, "fact", "Owen 喜歡 拉麵", 0);
      old.superseded_by = ramen.id;
      await withVector(old);

      // No shared words: found by the vector, ranked by the hybrid score.
      let page = await c.memory({ q: "他愛吃什麼" });
      const first = page.items[0];
      expect(first?.record.id).toBe(ramen.id);
      expect(first?.text_score).toBe(0);
      expect(first?.vector_score ?? 0).toBeGreaterThan(0.9);
      expect(first?.score ?? 0).toBeGreaterThan(0);
      expect(
        page.items.map((i) => i.record.id),
        "never superseded",
      ).not.toContain(old.id);
      for (let i = 1; i < page.items.length; i++) {
        expect(page.items[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(page.items[i]?.score ?? 0);
      }
      expect(page.next_cursor).toBeNull();

      // Every scope (DM too) and done followups are visible to the admin; filters apply.
      page = await c.memory({ q: "牙醫" });
      expect(page.items[0]?.record.id).toBe(dentist.id);
      expect(page.items[0]?.text_score ?? 0).toBeGreaterThan(0);
      page = await c.memory({ q: "拉麵", kind: "episode" });
      expect(page.items.every((i) => i.record.kind === "episode")).toBe(true);
      page = await c.memory({ q: "拉麵", subject: owen });
      expect(page.items.every((i) => i.record.subjects.includes(owen))).toBe(true);
      expect(page.items.map((i) => i.record.id)).toContain(ramen.id);
      page = await c.memory({ q: "Minecraft", limit: 1 });
      expect(page.items.map((i) => i.record.id)).toEqual([game.id]);
      page = await c.memory({ q: "拉麵", before: "2026-10-01T12:00:30Z" });
      expect(page.items, "only records created before").toEqual([]);

      expect((await sqlite.memories.get(ramen.id))?.access_count, "not touched").toBe(0);

      // Without the memory module the store's full-text search answers.
      h.sup.services.removeOwnedBy("memory");
      page = await c.memory({ q: "他愛吃什麼" });
      expect(page.items).toEqual([]);
    } finally {
      await sqlite.close();
    }
  });

  it("memory_list_search_edit_delete", async () => {
    const h = await harness();
    const c = h.client;
    const owen = newId();
    const ramen = memory(owen, "fact", "Owen 喜歡 豚骨 拉麵", 1);
    const game = memory(null, "episode", "大家 一起 玩 Minecraft", 2);
    const note = memory(null, "self_note", "我 想 學 拉麵 的 做法", 3);
    for (const r of [ramen, game, note]) await h.store.memories.upsert(r);

    let page = await c.memory();
    expect(
      page.items.map((i) => i.record.id),
      "newest first",
    ).toEqual([note.id, game.id, ramen.id]);
    expect(page.items[0]?.record.has_embedding).toBe(true);
    expect(page.items.every((i) => i.text_score === undefined)).toBe(true);
    const listed = await raw(h.base, "GET", "/api/memory", { token: TOKEN });
    const first = (listed.body as { items: Array<Record<string, Record<string, unknown>>> })
      .items[0];
    expect(first).not.toHaveProperty("text_score");
    expect(first).not.toHaveProperty("vector_score");
    expect(first?.record).not.toHaveProperty("tokens");
    expect(first?.record).not.toHaveProperty("embedding");
    expect(first?.record?.scope).toEqual({ type: "global" });

    page = await c.memory({ limit: 2 });
    expect(page.items).toHaveLength(2);
    const before = page.next_cursor;
    expect(before, "more").not.toBeNull();
    expect(Number.isNaN(Date.parse(before ?? ""))).toBe(false);
    page = await c.memory({ before: before ?? "" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.record.id).toBe(ramen.id);

    expect((await c.memory({ kind: "fact" })).items).toHaveLength(1);
    expect((await c.memory({ subject: owen })).items).toHaveLength(1);

    // Search across all scopes (person and global), with scores.
    const hits = await c.memory({ q: "拉麵" });
    expect(hits.items.map((i) => i.record.id).sort()).toEqual([ramen.id, note.id].sort());
    expect(hits.items.every((i) => (i.text_score ?? 0) > 0)).toBe(true);
    const mc = await raw(h.base, "GET", "/api/memory?q=Minecraft", { token: TOKEN });
    const mcItems = (mc.body as { items: Array<Record<string, unknown>> }).items;
    expect(mcItems).toHaveLength(1);
    expect(mcItems[0]?.text_score as number).toBeGreaterThan(0);
    expect(mcItems[0]?.vector_score).toBeNull();

    const updated = await c.updateMemory(ramen.id, {
      content: "Owen 喜歡 豚骨 拉麵,不吃 香菜",
      importance: 0.7,
    });
    expect(updated.content).toBe("Owen 喜歡 豚骨 拉麵,不吃 香菜");
    expect(updated.importance).toBe(0.7);
    expect(updated.has_embedding, "stale vector dropped").toBe(false);
    const stored = await h.store.memories.get(ramen.id);
    expect(stored?.tokens, "re-tokenized").toContain("香菜");
    await audited(h, "memory.update");
    expect(await statusOf(c.updateMemory(ramen.id, { importance: 3 }))).toBe(400);

    await c.deleteMemory(game.id);
    expect(await h.store.memories.get(game.id)).toBeNull();
    const entry = await audited(h, "memory.delete");
    expect(entry.target).toBe(game.id);
    expect((entry.detail as { content: string }).content).toBe("大家 一起 玩 Minecraft");
    const err = await errorOf(c.deleteMemory(game.id));
    expect(err.status).toBe(404);
    expect(err.message).toContain("unknown memory");
  });

  it("roles_assignments_and_mappings", async () => {
    const h = await harness();
    const c = h.client;
    const roles = await c.roles();
    expect(roles[0]?.name).toBe("owner");
    expect(roles.every((r) => r.builtin)).toBe(true);
    expect((await c.role("moderator")).rank).toBe(60);
    expect(await statusOf(c.role("ghost"))).toBe(404);

    const request: AssignRoleRequest = {
      account: account("123"),
      role: "moderator",
      scope: { type: "guild", platform: "discord", guild: "g1" },
    };
    const created = await c.assignRole(request);
    expect(created.granted_by).toBe("api");
    expect(created.role).toBe("moderator");
    expect(await statusOf(c.assignRole(request))).toBe(409);
    expect(await statusOf(c.assignRole({ ...request, role: "ghost" }))).toBe(404);
    expect(await c.assignments()).toHaveLength(1);
    const all = await raw(h.base, "GET", "/api/auth/assignments", { token: TOKEN });
    expect((all.body as Array<{ scope: { type: string } }>)[0]?.scope.type).toBe("guild");
    await audited(h, "role.assign");

    await c.revokeRole(request);
    expect(await c.assignments()).toHaveLength(0);
    expect(await statusOf(c.revokeRole(request))).toBe(404);
    await audited(h, "role.revoke");

    const custom = await c.upsertRole("dj", { rank: 30, grants: ["queue.*"], denies: [] });
    expect(custom.builtin).toBe(false);
    expect(
      await statusOf(c.upsertRole("bad", { rank: 1, grants: ["not a node!"], denies: [] })),
    ).toBe(400);
    expect(await statusOf(c.deleteRole("owner"))).toBe(409);
    await c.deleteRole("dj");
    expect(await statusOf(c.deleteRole("dj"))).toBe(404);

    const mapping: RoleMapping = {
      platform: "discord",
      guild: "g1",
      platform_role: "555",
      role: "trusted",
    };
    await c.setMapping(mapping);
    expect(await c.mappings("discord", "g1")).toEqual([mapping]);
    await audited(h, "role.map");
    const remove = { platform: "discord", guild: "g1", platform_role: "555" };
    await c.removeMapping(remove);
    expect(await statusOf(c.removeMapping(remove))).toBe(404);
    const missing = await raw(h.base, "GET", "/api/auth/mappings", { token: TOKEN });
    expect(missing.status, "platform and guild required").toBe(400);
  });

  it("extensions_and_mcp", async () => {
    const h = await harness();
    const c = h.client;
    const list = await c.extensions();
    expect(list).toHaveLength(1);
    let ext = list[0];
    expect([ext?.id, ext?.name, ext?.version]).toEqual(["demo", "Demo", "0.2.1"]);
    expect(ext?.module).toBe("ext.demo");
    expect([ext?.enabled, ext?.state]).toEqual([true, "running"]);
    expect(ext?.permissions).toEqual(["tools", "events:game.*"]);

    ext = await c.extensionAction("demo", "disable");
    expect([ext.enabled, ext.state]).toEqual([false, "disabled"]);
    expect((await audited(h, "extension.disable")).target).toBe("ext.demo");
    ext = await c.extensionAction("demo", "enable");
    expect(ext.state).toBe("running");
    expect(await statusOf(c.extensionAction("ghost", "enable"))).toBe(404);

    // Module actions are audited too, and `api` still refuses to stop itself.
    await c.moduleAction("ext.demo", "restart");
    await audited(h, "module.restart");
    expect(await statusOf(c.moduleAction("api", "disable"))).toBe(409);

    expect(await c.mcpServers()).toEqual([]);
    expect(await statusOf(c.mcpAction("filesystem", "restart"))).toBe(404);
  });

  it("queue_listing_and_actions", async () => {
    const h = await harness();
    const c = h.client;
    for (const [who, text] of [
      ["1", "唱千本櫻"],
      ["2", "去挖鑽石"],
      ["3", "講笑話"],
    ] as const) {
      h.queue.submit({ requester: account(who), requesterName: `user${who}`, kind: "song", text });
    }
    let state = await c.queue();
    expect(state.paused).toBe(false);
    expect(state.items.map((i) => i.text)).toEqual(["唱千本櫻", "去挖鑽石", "講笑話"]);
    expect(state.items[0]?.author?.display_name).toBe("user1");
    expect(state.items[0]?.kind).toBe("song");

    const last = state.items[2]?.id ?? "";
    state = await c.queueMove(last, 0);
    expect(state.items[0]?.text).toBe("講笑話");
    await audited(h, "queue.move");

    const first = state.items[0]?.id ?? "";
    state = await c.queueSkip(first);
    expect(state.items).toHaveLength(2);
    expect((await audited(h, "queue.skip")).target).toBe(first);
    expect(await statusOf(c.queueSkip(first)), "already skipped").toBe(404);
    expect(await statusOf(c.queueSkip("nope"))).toBe(404);
    // Active items cannot be moved.
    const active = h.queue.next();
    expect(active).not.toBeNull();
    expect(await statusOf(c.queueMove(String(active?.id), 1))).toBe(409);

    expect((await c.queuePause(true)).paused).toBe(true);
    expect(h.queue.isPaused()).toBe(true);
    await audited(h, "queue.pause");
    expect((await c.queuePause(false)).paused).toBe(false);
  });

  it("stage_without_a_node", async () => {
    const h = await harness();
    await h.sup.register(
      new StageLinkModule(),
      { bind: "127.0.0.1:0", token: "stage-token" },
      true,
    );
    await h.sup.enable(StageLinkModule.ID);
    const c = h.client;
    const stage = await c.stage();
    expect(stage.vts.connected || stage.obs.connected).toBe(false);
    expect(stage.node).toBeNull();
    expect(stage.obs.error).toContain("not connected");
    expect(stage.speaking).toBe(false);
    for (const call of [
      c.stageScene("Gaming"),
      c.stageExpression("blush"),
      c.stageStream("start"),
    ]) {
      expect(await statusOf(call)).toBe(409);
    }
  });

  it("stage_reports_scenes_hotkeys_overlay_and_emotions", async () => {
    const emotions = avatarEmotions({
      emotion: { Neutral: "", happy: "a.exp3.json", smug: "<placeholder>", angry: "b.exp3.json" },
    });
    expect(emotions).toEqual(["angry", "happy", "neutral"]);
    // Emotions written as tables (pose params, decals, gestures) count too.
    expect(
      avatarEmotions({ emotion: { sad: { expression: "c.exp3.json", params: {} }, odd: [] } }),
    ).toEqual(["sad"]);
    const h = await harness({}, { emotions });
    const status: StageStatus = {
      ...defaultStageStatus(),
      vts: true,
      obs: true,
      scene: "Talk",
      scenes: ["Talk", "Game"],
      hotkeys: ["Wave", "Blush"],
      overlay_url: "http://127.0.0.1:7884/overlay/",
    };
    const hotkeys: string[] = [];
    const fake = {
      node: () => ["stage-pc", ["vts", "obs"]],
      status: () => ({ ...status }),
      hotkey: async (name: string) => {
        hotkeys.push(name);
        return { ...status };
      },
    };
    h.sup.services.provide("stage.link", StageLinkKey, fake as unknown as StageLink);
    const c = h.client;
    const stage = await c.stage();
    expect(stage.node).toBe("stage-pc");
    expect(stage.scenes).toEqual(["Talk", "Game"]);
    expect(stage.expressions).toEqual(["Wave", "Blush"]);
    expect(stage.overlay_url).toBe("http://127.0.0.1:7884/overlay/");
    expect(stage.emotions).toEqual(["angry", "happy", "neutral"]);
    expect((await c.stageExpression("Blush")).expression).toBe("Blush");
    expect(hotkeys).toEqual(["Blush"]);

    // Lists only while the part is connected.
    status.obs = false;
    status.vts = false;
    const down = await c.stage();
    expect([down.scenes, down.expressions]).toEqual([[], []]);
    expect(down.overlay_url).toBe("http://127.0.0.1:7884/overlay/");

    // Say checks the emotion against the avatar's.
    expect(await statusOf(c.stageSay("哼", "furious"))).toBe(400);
  });

  it("scene_roles_are_read_and_overridden", async () => {
    const h = await harness();
    const roles = new SceneRoles(ScenesConfigSchema.parse({ roles: { ending: "Bye" } }), {
      settings: () => undefined,
      router: () => undefined,
      signal: new AbortController().signal,
    });
    roles.observe(["Just Chatting", "Gameplay", "Bye"]);
    await roles.idle();
    h.sup.services.provide("stage.link", SceneRolesKey, roles);
    const c = h.client;
    const view = await c.sceneRoles();
    expect(view.scenes).toEqual(["Just Chatting", "Gameplay", "Bye"]);
    expect(view.classified_by).toBe("heuristic");
    expect(view.roles.find((r) => r.role === "game")).toMatchObject({
      scene: "Gameplay",
      source: "auto",
    });

    const set = await c.setSceneRole("chat", "Gameplay");
    expect(set.roles.find((r) => r.role === "chat")).toMatchObject({
      scene: "Gameplay",
      source: "panel",
      auto: "Just Chatting",
    });
    await audited(h, "stage.scene_role");
    expect(await statusOf(c.setSceneRole("ending", "Gameplay")), "set in config").toBe(400);
    expect(await statusOf(c.setSceneRole("chat", "Nope"))).toBe(400);
    const cleared = await c.setSceneRole("chat", null);
    expect(cleared.roles.find((r) => r.role === "chat")?.source).toBe("auto");
    expect((await c.classifyScenes()).classified_by).toBe("heuristic");
  });

  it("mcp_servers_report_their_target", async () => {
    const h = await harness();
    const status = h.sup.services.require(McpStatusKey);
    status.insert(newServerStatus("files", "stdio", "tools.mcp.files", "npx -y srv C:/data"));
    const [server] = await h.client.mcpServers();
    expect(server?.target).toBe("npx -y srv C:/data");
  });

  it("voice_sessions_are_named_by_the_platform", async () => {
    const h = await harness();
    let asked = 0;
    const sink: PlatformSink = {
      platform: "discord",
      send: async () => ({ context: voiceContext(), id: "1" }),
      react: async () => {},
      typing: async () => {},
      describe: async (context) => {
        asked += 1;
        return context.channel === "vc1" ? "Miyoria / 雜談" : null;
      },
    };
    const sinks = new PlatformSinks();
    sinks.register(sink);
    h.sup.services.provide("kernel", PlatformSinksKey, sinks);
    h.sup.bus.publish("voice", {
      type: "voice_joined",
      data: { context: voiceContext(), participants: [] },
    });
    const state = await waitFor(async () => {
      const s = await h.client.voice();
      return s.sessions.length === 1 ? s : null;
    });
    expect(state.sessions[0]?.label).toBe("Miyoria / 雜談");
    await h.client.voice();
    expect(asked, "cached").toBe(1);
  });

  it("voice_monitor_and_say", async () => {
    const h = await harness();
    const c = h.client;
    expect((await c.voice()).sessions).toEqual([]);
    expect(await statusOf(c.stageSay("哼")), "not in voice yet").toBe(409);

    h.sup.bus.publish("voice", {
      type: "voice_joined",
      data: {
        context: voiceContext(),
        participants: [
          {
            account: account("5678"),
            display_name: "Mika",
            is_self: false,
            muted: false,
            deafened: false,
          },
        ],
      },
    });
    h.sup.bus.publish("voice", {
      type: "custom",
      data: {
        topic: "voice.latency",
        payload: { stage: "asr", context: { ...voiceContext() }, asr_ms: 210 },
      },
    });
    const state = await waitFor(async () => {
      const s = await c.voice();
      return s.sessions[0]?.latency.asr.samples === 1 ? s : null;
    });
    const session = state.sessions[0];
    expect(session?.context).toEqual(voiceContext());
    expect(session?.participants[0]?.display_name).toBe("Mika");
    expect(session?.latency.asr.p50_ms).toBe(210);
    expect(session?.latency.tts_first_audio.samples).toBe(0);

    const said = await c.stageSay("哼,才不是特地為你唱的。", "embarrassed");
    expect(said.turn, "a turn id").not.toBeNull();
    const spoken = await h.sink.next();
    expect(spoken.context).toEqual(voiceContext());
    expect(spoken.text).toBe("哼,才不是特地為你唱的。");
    expect(spoken.turn).toBe(said.turn);
    await audited(h, "stage.say");
    // It went through the gate as the panel.
    const gate = (await h.store.audit.recent(100, "panel:api")).find(
      (e) => e.action === "gate.speak",
    );
    expect(gate?.ok).toBe(true);
    expect(gate?.detail).toMatchObject({ principal: { kind: "panel", actor: "api" } });
    expect(await statusOf(c.stageSay("   "))).toBe(400);
  });

  it("serves_the_panel_without_a_token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-panel-"));
    dirs.push(dir);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Miyoria</title>");
    writeFileSync(join(dir, "assets/app-1a2b.js"), "console.log(1)");
    writeFileSync(join(dir, "favicon.svg"), "<svg/>");
    const h = await harness({ panel_dir: dir });

    const index = await raw(h.base, "GET", "/");
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(index.headers.get("content-type")).toMatch(/^text\/html/);
    expect(index.text).toContain("Miyoria");

    const asset = await raw(h.base, "GET", "/assets/app-1a2b.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const icon = await raw(h.base, "GET", "/favicon.svg");
    expect(icon.headers.get("cache-control")).toBe("no-cache");

    expect((await raw(h.base, "GET", "/nope.txt")).status).toBe(404);
    expect((await raw(h.base, "GET", "/..%2F..%2Fpackage.json")).status).not.toBe(200);

    // The API keeps its JSON fallback and token check.
    const missing = await raw(h.base, "GET", "/api/nope", { token: TOKEN });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "no such endpoint" });
    expect((await raw(h.base, "GET", "/api/queue")).status).toBe(401);
  });
});
