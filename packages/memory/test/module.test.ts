// The module under a supervisor: services, registrations, commands and event-driven
// consolidation (Rust `tests/module.rs`).

import {
  type ArgValue,
  CommandRegistryKey,
  CommandsModule,
  type InvocationData,
} from "@miyoria/commands";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  ServiceRegistry,
  Supervisor,
} from "@miyoria/kernel";
import { type LlmRouter, LlmRouterKey, MockProvider } from "@miyoria/llm";
import {
  logEntryFromIncoming,
  type MemoryKind,
  MemoryRecordStoreKey,
  type MemoryScope,
  MessageLogKey,
  PeopleStoreKey,
  SettingsStoreKey,
} from "@miyoria/store";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type ContextKey,
  FollowupSourceKey,
  type IncomingMessage,
  type JsonValue,
  type PersonId,
  PromptContributors,
  PromptContributorsKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  embeddingConfig,
  MemoryEngine,
  MemoryEngineKey,
  MemoryModule,
  memoryFilter,
  PATHS,
} from "../src/index.js";
import {
  type Areas,
  acct,
  closeAll,
  dmCtx,
  guildCtx,
  openAreas,
  profile,
  router,
} from "./helpers.js";

class LlmStub implements Module {
  readonly manifest = defineManifest("llm", "LLM stub");
  constructor(readonly router: LlmRouter) {}

  async start(ctx: ModuleContext): Promise<void> {
    ctx.provide(LlmRouterKey, this.router);
  }
}

interface Harness {
  sup: Supervisor;
  store: Areas;
  contributors: PromptContributors;
  tools: ToolRegistry;
}

const sups: Supervisor[] = [];

async function harness(llm: MockProvider, config: JsonValue): Promise<Harness> {
  const services = new ServiceRegistry();
  const sup = new Supervisor({ services });
  sups.push(sup);
  const store = await openAreas("fake");
  services.provide("app", MemoryRecordStoreKey, store.memories);
  services.provide("app", MessageLogKey, store.messages);
  services.provide("app", PeopleStoreKey, store.people);
  services.provide("app", SettingsStoreKey, store.settings);
  const contributors = new PromptContributors();
  services.provide("app", PromptContributorsKey, contributors);
  const tools = new ToolRegistry();
  services.provide("app", ToolRegistryKey, tools);

  await sup.register(new LlmStub(router(llm)), null, true);
  await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
  await sup.register(new MemoryModule(profile(), embeddingConfig()), config, true);
  await sup.startAll();
  return { sup, store, contributors, tools };
}

function inv(
  path: string,
  invoker: string,
  context: ContextKey,
  args: [string, string][] = [],
): InvocationData {
  return {
    path: path.split(" "),
    args: Object.fromEntries(args) as Record<string, ArgValue>,
    invoker: acct(invoker),
    invoker_display_name: invoker,
    context,
    invoker_is_guild_admin: false,
  };
}

function engine(h: Harness): MemoryEngine {
  return h.sup.services.require(MemoryEngineKey);
}

async function run(h: Harness, invocation: InvocationData): Promise<string> {
  const reg = h.sup.services.require(CommandRegistryKey);
  const reply = await reg.dispatch(invocation);
  expect(reply.ephemeral).toBe(true);
  return reply.text;
}

async function add(
  h: Harness,
  kind: MemoryKind,
  scope: MemoryScope,
  subjects: PersonId[],
  content: string,
): Promise<void> {
  await engine(h).store(
    {
      kind,
      scope,
      subjects,
      content,
      importance: 0.5,
      confidence: 0.8,
      source_context: null,
      due: null,
    },
    toTimestamp(Date.now()),
  );
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const sup of sups.splice(0)) await sup.stopAll();
  await closeAll();
});

describe("module", () => {
  it("registers_services_and_unregisters_on_stop", async () => {
    const h = await harness(new MockProvider("sum").reply("{}"), { tick_secs: 1 });
    expect(h.sup.services.get(FollowupSourceKey)).toBeDefined();
    expect(h.sup.services.get(MemoryEngineKey)).toBeInstanceOf(MemoryEngine);
    expect(h.contributors.all()).toHaveLength(1);
    expect(h.contributors.all()[0]?.key).toBe("memory");
    expect(h.tools.names()).toEqual(["recall", "remember"]);
    const reg = h.sup.services.require(CommandRegistryKey);
    for (const path of PATHS) {
      const spec = reg.get(path.split(" "));
      if (!spec) throw new Error(`${path} not registered`);
      expect(spec.permission.startsWith("memory.self.")).toBe(true);
      expect(spec.ephemeral).toBe(true);
    }
    const memoryStatus = h.sup.list().find((m) => m.id === "memory");
    expect(memoryStatus?.state).toBe("running");

    await h.sup.disable("memory");
    expect(h.contributors.all()).toEqual([]);
    expect(h.tools.isEmpty).toBe(true);
    expect(reg.get(["memory", "show"])).toBeUndefined();
    expect(h.sup.services.get(FollowupSourceKey)).toBeUndefined();

    // Restarting the commands module re-registers the commands.
    await h.sup.enable("memory");
    await h.sup.restart("commands");
    const fresh = h.sup.services.require(CommandRegistryKey);
    expect(fresh).not.toBe(reg);
    const deadline = Date.now() + 5000;
    while (fresh.get(["memory", "show"]) === undefined) {
      expect(Date.now() < deadline, "not re-registered").toBe(true);
      await pause(50);
    }
  });

  it("memory_commands_show_forget_export", async () => {
    const h = await harness(new MockProvider("sum").reply("{}"), {});
    const owenAcct = acct("2");
    const owen = await h.store.people.upsertAccount(owenAcct, "Owen");
    const amy = await h.store.people.upsertAccount(acct("3"), "Amy");
    const g1: MemoryScope = { type: "guild", platform: "discord", guild: "g1" };
    const dmScope: MemoryScope = { type: "dm", account: owenAcct };
    await add(h, "fact", g1, [owen], "Owen 喜歡拉麵");
    await add(h, "fact", dmScope, [owen], "Owen 下週要看牙醫");
    await add(h, "fact", { type: "person", person: owen }, [owen], "Owen 希望被叫歐文");
    await add(h, "fact", g1, [amy], "Amy 養貓");

    const guild = guildCtx("g1", "c1");
    const dm = dmCtx("d-owen");

    let shown = await run(h, inv("memory show", "2", guild));
    expect(shown).toContain("拉麵");
    expect(shown).toContain("歐文");
    expect(shown, "DM memory shown in a guild").not.toContain("牙醫");
    expect(shown).not.toContain("Amy");
    shown = await run(h, inv("memory show", "2", dm));
    expect(shown).toContain("牙醫");
    expect(shown, "guild memory shown in a DM").not.toContain("拉麵");
    const otherGuild = await run(h, inv("memory show", "2", guildCtx("g2", "c1")));
    expect(otherGuild).toContain("歐文");
    expect(otherGuild).not.toContain("拉麵");

    const exported = await run(h, inv("memory export", "2", guild));
    const jsonText = exported.replace(/^```json\n/, "").replace(/\n```$/, "");
    const items = JSON.parse(jsonText) as { kind: string; created_at: string }[];
    expect(items, exported).toHaveLength(2);
    expect(items.every((i) => i.kind === "fact")).toBe(true);
    expect(items[0]?.created_at).toMatch(/\+00:00$/);

    // Someone else's memories need memory.admin.*.
    const denied = await run(h, inv("memory show", "3", guild, [["user", "<@2>"]]));
    expect(denied).toContain("管理員");
    const asAdmin = { ...inv("memory show", "3", guild, [["user", "<@2>"]]) };
    asAdmin.invoker_is_guild_admin = true;
    expect(await run(h, asAdmin)).toContain("拉麵");
    const owner = await run(h, inv("memory show", "1", guild, [["user", "discord:2"]]));
    expect(owner).toContain("拉麵");
    expect(owner).not.toContain("牙醫");
    const bad = await run(h, inv("memory show", "1", guild, [["user", "a b"]]));
    expect(bad).toContain("使用者");

    // Forget by keyword (everywhere, including the DM), then everything.
    const forgot = await run(h, inv("memory forget", "2", guild, [["target", "牙醫"]]));
    expect(forgot).toContain("1");
    const none = await run(h, inv("memory forget", "2", guild, [["target", "火星"]]));
    expect(none).toContain("不記得");
    const all = await run(h, inv("memory forget", "2", dm, [["target", "all"]]));
    expect(all).toContain("全部忘掉");
    const e = engine(h);
    expect(await e.memoriesOf(owen, owenAcct, true)).toEqual([]);
    expect(await e.memoriesOf(amy, acct("3"), false), "Amy's memories untouched").toHaveLength(1);
    const empty = await run(h, inv("memory show", "2", guild));
    expect(empty).toContain("還沒記得");
  });

  it("consolidates_after_enough_messages", async () => {
    const reply = `{"facts": [{"subject_name": "Owen", "statement": "Owen 養了一隻叫麻糬的貓", "importance": 0.7, "confidence": 0.9, "global": false}]}`;
    const llm = new MockProvider("sum").reply(reply);
    const h = await harness(llm, {
      tick_secs: 1,
      consolidate_every_messages: 2,
      consolidate_idle_secs: 3600,
    });
    const owen = acct("2");
    await h.store.people.upsertAccount(owen, "Owen");
    const ctx = guildCtx("g1", "c1");
    for (const [i, text] of ["我家有貓", "牠叫麻糬"].entries()) {
      const msg: IncomingMessage = {
        id: { context: ctx, id: `m${i}` },
        author: { account: owen, display_name: "Owen", is_bot: false },
        text,
        mentions_self: false,
        reply_to_self: false,
        attachments: [],
        ts: toTimestamp(Date.now() + i),
      };
      // The recorder would append it; do it here.
      await h.store.messages.append(logEntryFromIncoming(profile(), msg, false));
      h.sup.bus.publish("test", { type: "platform_message_created", data: msg });
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      const records = await engine(h).memoriesOf(null, owen, false);
      const all = await h.store.memories.list(profile(), memoryFilter(10));
      const first = all[0];
      if (first) {
        expect(first.content).toContain("麻糬");
        expect(first.scope).toEqual({ type: "guild", platform: "discord", guild: "g1" });
        expect(records, "no DM-scoped records").toEqual([]);
        break;
      }
      expect(Date.now() < deadline, "not consolidated").toBe(true);
      await pause(100);
    }
    expect(llm.requests()).toHaveLength(1);
    const user = llm.requests()[0]?.messages[1]?.content ?? "";
    expect(user).toContain("我家有貓");
    expect(user).toContain("牠叫麻糬");
  });

  it("is degraded without a message log and fails without a record store", async () => {
    const services = new ServiceRegistry();
    const sup = new Supervisor({ services });
    sups.push(sup);
    const store = await openAreas("fake");
    services.provide("app", MemoryRecordStoreKey, store.memories);
    await sup.register(new LlmStub(router(new MockProvider("sum").reply("{}"))), null, true);
    const module = new MemoryModule(profile());
    await sup.register(module, { forgetting: { enabled: false } }, true);
    await sup.startAll();
    expect(await module.health()).toEqual({
      status: "degraded",
      reason: "no message log: consolidation is off",
    });

    const bare = new Supervisor();
    sups.push(bare);
    await bare.register(new LlmStub(router(new MockProvider("sum").reply("{}"))), null, true);
    await bare.register(new MemoryModule(profile()), null, true);
    await bare.startAll();
    const status = bare.list().find((m) => m.id === "memory");
    expect(status?.state).not.toBe("running");
  });
});
