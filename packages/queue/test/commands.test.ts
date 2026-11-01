import {
  type ArgValue,
  CommandRegistry,
  CommandRegistryKey,
  type CommandReply,
  CommandsModule,
  Invocation,
  Permissions,
  parseAccount,
  splitPath,
} from "@miyoria/commands";
import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import type { ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  QueueConfigSchema,
  QueueModule,
  RequestQueue,
  RequestQueueKey,
  registerCommands,
  tallies,
} from "../src/index.js";

function inv(path: string, who: string, args: Record<string, ArgValue> = {}): Invocation {
  const context: ContextKey = { platform: "discord", scope: "1", channel: "2", kind: "channel" };
  return new Invocation({
    path: splitPath(path),
    args,
    invoker: parseAccount(`discord:${who}`),
    invoker_display_name: `user${who}`,
    context,
    invoker_is_guild_admin: false,
  });
}

function setup(overrides: Record<string, unknown> = {}): [RequestQueue, CommandRegistry] {
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
  const queue = new RequestQueue(QueueConfigSchema.parse(overrides));
  registerCommands(registry, queue);
  return [queue, registry];
}

function run(
  reg: CommandRegistry,
  path: string,
  who: string,
  args: Record<string, ArgValue> = {},
): Promise<CommandReply> {
  return reg.dispatch(inv(path, who, args));
}

describe("queue commands", () => {
  it("request_and_queue_commands", async () => {
    const [queue, reg] = setup();

    const r = await run(reg, "request", "5", { text: "唱一首歌", kind: "song" });
    expect(r.text).toBe("收到啦,#1 排第 1 個。");
    expect(r.ephemeral).toBe(false);
    const item = queue.get(1);
    expect([item?.kind, item?.requester_name]).toEqual(["song", "user5"]);
    expect(item?.context).not.toBeNull();

    await run(reg, "request", "5", { text: "再來一首" });
    const full = await run(reg, "request", "5", { text: "第三首" });
    expect(full.ephemeral).toBe(true);
    expect(full.text).toContain("先等等");
    const empty = await run(reg, "request", "6", { text: "  " });
    expect(empty.text).toContain("內容");

    let list = await run(reg, "queue list", "6");
    expect(list.ephemeral).toBe(true);
    expect(list.text).toContain("#1 [song] user5:唱一首歌");
    expect(list.text).toContain("#2 [chat]");

    // Next / done / skip default to the active item.
    const next = await run(reg, "queue next", "1");
    expect(next.text).toContain("輪到 #1");
    list = await run(reg, "queue list", "6");
    expect(list.text).toContain("進行中 #1");
    expect((await run(reg, "queue done", "1")).text).toContain("#1 完成");
    expect((await run(reg, "queue done", "1")).text).toContain("要指定編號");
    const skipped = await run(reg, "queue skip", "1", { id: 2 });
    expect(skipped.text).toContain("跳過 #2");
    const missing = await run(reg, "queue remove", "1", { id: 2 });
    expect(missing.text.includes("找不到 #2") || missing.text.includes("不能")).toBe(true);

    await run(reg, "request", "7", { text: "a" });
    await run(reg, "request", "8", { text: "b" });
    const rm = await run(reg, "queue remove", "1", { id: 3 });
    expect(rm.text).toContain("移除 #3");
    const pr = await run(reg, "queue priority", "1", { id: 4, priority: 9 });
    expect(pr.text).toContain("#4 優先度設成 9");
    expect(queue.get(4)?.priority).toBe(9);

    const up = await run(reg, "queue upvote", "9", { id: 4 });
    expect(up.text).toContain("1 票");

    expect((await run(reg, "queue pause", "1")).text).toContain("暫停");
    expect(queue.isPaused()).toBe(true);
    expect((await run(reg, "queue next", "1")).text).toContain("暫停中");
    list = await run(reg, "queue list", "1");
    expect(list.text.startsWith("佇列(暫停中)")).toBe(true);
    expect((await run(reg, "queue resume", "1")).text).toContain("繼續");
    expect(queue.isPaused()).toBe(false);

    expect((await run(reg, "queue clear", "1")).text).toContain("清掉 1 個");
    expect((await run(reg, "queue list", "1")).text).toContain("空的");
  });

  it("queue_next_on_an_empty_queue_says_so", async () => {
    const [, reg] = setup();
    expect((await run(reg, "queue next", "1")).text).toBe("沒有人在排隊。");
  });

  it("long_text_is_ellipsized_in_listings", async () => {
    const [, reg] = setup();
    await run(reg, "request", "5", { text: "字".repeat(40) });
    const list = await run(reg, "queue list", "5");
    expect(list.text).toContain(`${"字".repeat(30)}…`);
  });

  it("vote_commands", async () => {
    const [queue, reg] = setup();

    expect((await run(reg, "vote", "5", { option: "左" })).text).toContain("沒有在投票");
    const started = await run(reg, "queue vote start", "1", { options: "左, 右，上", seconds: 30 });
    expect(started.ephemeral).toBe(false);
    expect(started.text).toContain("30 秒");
    expect(started.text).toContain("1. 左 / 2. 右 / 3. 上");
    const again = await run(reg, "queue vote start", "1", { options: "a,b", seconds: 30 });
    expect(again.text).toContain("已經有投票");

    let list = await run(reg, "queue list", "5");
    expect(list.text).toContain("投票中:左 0 / 右 0 / 上 0");

    expect((await run(reg, "vote", "5", { option: "右" })).text).toContain("投給「右」");
    expect((await run(reg, "vote", "6", { option: "3" })).text).toContain("投給「上」");
    expect((await run(reg, "vote", "5", { option: "上" })).text).toContain("投給「上」");
    expect((await run(reg, "vote", "7", { option: "下" })).text).toContain("沒有「下」");
    expect(tallies(queue.voteStatus() as never)).toEqual([0, 0, 2]);

    const end = await run(reg, "queue vote end", "1");
    expect(end.text).toContain("贏的是「上」");
    expect(end.text).toContain("上 2 票");
    const bad = await run(reg, "queue vote start", "1", { options: "only", seconds: 30 });
    expect(bad.text).toContain("投票設定不對");
    const neg = await run(reg, "queue vote start", "1", { options: "a,b", seconds: -3 });
    expect(neg.text).toContain("秒數");

    // The winner is waiting in the queue.
    list = await run(reg, "queue list", "1");
    expect(list.text).toContain("[vote]");
    expect(list.text).toContain("上");
  });

  it("vote_end_without_ballots_says_nobody_voted", async () => {
    const [, reg] = setup();
    await run(reg, "queue vote start", "1", { options: "a、b", seconds: 30 });
    const end = await run(reg, "queue vote end", "1");
    expect(end.text).toBe("投票結束:a 0 票 / b 0 票。沒有人投,算了。");
  });

  it("configurable_permissions", async () => {
    const [queue, reg] = setup({ permissions: { manage: "admin.queue.manage" } });
    await run(reg, "request", "5", { text: "x" });
    const cases: Array<[string, Record<string, ArgValue>]> = [
      ["queue clear", {}],
      ["queue pause", {}],
      ["queue skip", { id: 1 }],
      ["queue vote start", { options: "a,b", seconds: 9 }],
    ];
    for (const [path, args] of cases) {
      const denied = await run(reg, path, "5", args);
      expect(denied.ephemeral, path).toBe(true);
      expect(denied.text, path).toContain("權限");
    }
    expect(queue.isPaused()).toBe(false);
    expect(queue.list()).toHaveLength(1);
    expect(queue.voteStatus()).toBeNull();
    // Viewers may still request and vote; an owner may manage.
    expect((await run(reg, "queue list", "5")).text).toContain("#1");
    expect((await run(reg, "queue clear", "1")).text).toContain("清掉 1 個");
  });

  it("command_paths_are_valid_and_nonconflicting", () => {
    const [, reg] = setup();
    const names = reg.specs().map((s) => s.path.join(" "));
    for (const expected of [
      "request",
      "vote",
      "queue list",
      "queue next",
      "queue done",
      "queue skip",
      "queue remove",
      "queue clear",
      "queue pause",
      "queue resume",
      "queue priority",
      "queue upvote",
      "queue vote start",
      "queue vote end",
    ]) {
      expect(names, expected).toContain(expected);
    }
    expect(reg.groupDescription("queue")).toBe("請求佇列");
    expect(reg.groupDescription("queue vote")).toBe("投票模式");
  });
});

describe("QueueModule", () => {
  it("module_wires_commands_events_and_persistence", async () => {
    const sup = new Supervisor();
    const store = new MemorySettingsStore();
    sup.services.provide("app", SettingsStoreKey, store);
    await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
    await sup.register(new QueueModule(), { persist_debounce_ms: 30, tick_ms: 10 }, true);
    const sub = sup.bus.subscribe("queue.*");
    await sup.startAll();

    const registry = sup.services.require(CommandRegistryKey);
    const queue = sup.services.require(RequestQueueKey);
    const reply = await run(registry, "request", "5", { text: "挖鑽石", kind: "game_goal" });
    expect(reply.text).toContain("#1");

    const env = await sub.recv();
    expect(env?.source).toBe("queue");
    expect(env?.event.type).toBe("custom");
    if (env?.event.type === "custom") {
      expect(env.event.data.topic).toBe("queue.changed");
      const payload = env.event.data.payload as { items: Array<{ kind: string }> };
      expect(payload.items[0]?.kind).toBe("game_goal");
    }
    queue.next();
    let sawActivation = false;
    for (let i = 0; i < 2; i++) {
      const e = await sub.recv();
      if (e?.event.type === "custom" && e.event.data.topic === "queue.item_activated") {
        sawActivation = true;
      }
    }
    expect(sawActivation).toBe(true);

    // Restarting the module keeps the queue (snapshot restore) and the commands.
    await sup.restart("queue");
    const revived = sup.services.require(RequestQueueKey);
    expect(revived).not.toBe(queue);
    expect(revived.current()?.text).toBe("挖鑽石");
    const registry2 = sup.services.require(CommandRegistryKey);
    expect((await run(registry2, "queue list", "5")).text).toContain("進行中 #1");

    // Disabling it removes the commands again.
    await sup.disable("queue");
    expect(sup.services.get(RequestQueueKey)).toBeUndefined();
    expect(registry2.get(["request"])).toBeUndefined();
    expect(await store.get("_global", "queue:state")).not.toBeNull();
    await sup.stopAll();
  });

  it("module_starts_without_optional_services", async () => {
    const sup = new Supervisor();
    await sup.register(new QueueModule(), null, true);
    await sup.startAll();
    const queue = sup.services.require(RequestQueueKey);
    expect(queue.list()).toEqual([]);
    expect(sup.list().find((s) => s.id === "queue")?.state).toBe("running");
    await sup.stopAll();
  });

  it("module_manifest", () => {
    const m = new QueueModule().manifest;
    expect(m.id).toBe("queue");
    expect(m.optional).toEqual(["commands", "social"]);
    expect(m.requires).toEqual([]);
  });
});
