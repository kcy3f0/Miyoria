// Route groups added for the admin panel: a real supervisor running the `api` module, in-memory
// stores, the real auth service and request queue, and fakes for the services of packages that
// are ported separately (`tests/routes.rs`).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService, AuthServiceKey } from "@miyoria/auth";
import { ExtensionCatalog, ExtensionCatalogKey, ExtensionManifest } from "@miyoria/ext-host";
import { Supervisor, SupervisorKey } from "@miyoria/kernel";
import { LlmRouter, LlmRouterKey } from "@miyoria/llm";
import { McpStatus, McpStatusKey } from "@miyoria/mcp";
import { tokenString } from "@miyoria/memory";
import { RequestQueue, RequestQueueKey } from "@miyoria/queue";
import { Social, SocialKey, socialConfig } from "@miyoria/social";
import { StageLinkModule } from "@miyoria/stage";
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
} from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  type JsonValue,
  newId,
  type PersonId,
  VoiceSinkKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiClient, ApiModule, type AssignRoleRequest } from "../src/index.js";
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

async function harness(apiConfig: Record<string, JsonValue> = {}): Promise<Harness> {
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

  const api = new ApiModule({ env: () => undefined });
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
