import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/actions";
import {
  type ArgValue,
  CommandRegistry,
  CommandRegistryKey,
  Invocation,
  Permissions,
} from "@miyoria/commands";
import { Supervisor } from "@miyoria/kernel";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  LlmRouter,
  LlmRouterKey,
  MockProvider,
  parseModelRef,
} from "@miyoria/llm";
import { RequestQueue, RequestQueueKey } from "@miyoria/queue";
import { type Tool, ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  type ContextKey,
  type Event,
  type JsonValue,
  PromptContributors,
  PromptContributorsKey,
  type PromptRequest,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DECISION_TOPIC,
  GameControl,
  GameControlKey,
  GameError,
  GameHandle,
  GameHandleKey,
  GameModule,
  type GameStatus,
} from "../src/index.js";

// ----- fakes -----

const IDLE = '血量 20/20\n位置 (0, 64, 0)\n\n狀態:{"connected":true,"in_game":true,"busy":false}';
const BUSY =
  '血量 20/20\n位置 (5, 64, 5)\nBaritone 執行中(Mine)\n\n狀態:{"connected":true,"in_game":true,"busy":true}';

/** Replies computed from the request's user message. */
class FnProvider implements ChatProvider {
  readonly name = "fn";
  readonly requests: ChatRequest[] = [];

  constructor(private readonly reply: (user: string) => string) {}

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const text = this.reply(request.messages.at(-1)?.content ?? "");
    return (async function* () {
      yield { type: "text_delta" as const, text };
      yield { type: "done" as const, finish_reason: "stop", usage: null };
    })();
  }
}

function decision(goal: string, action: JsonValue, commentary: string | null = null): string {
  return JSON.stringify({ goal, goal_status: "working", action, commentary });
}

function textCtx(): ContextKey {
  return { platform: "discord", scope: "g1", channel: "text1", kind: "channel" };
}

function voiceCtx(): ContextKey {
  return { platform: "discord", scope: "g1", channel: "voice1", kind: "voice" };
}

function owner(): AccountRef {
  return { platform: "discord", id: "1" };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5);
}

async function secs(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(n * 1000);
  await settle();
}

type Log<T> = { items: T[]; take(): T[] };

function collect<T>(sub: AsyncIterable<unknown>, pick: (event: Event) => T | null): Log<T> {
  const items: T[] = [];
  void (async () => {
    for await (const env of sub as AsyncIterable<{ event: Event }>) {
      const v = pick(env.event);
      if (v !== null) items.push(v);
    }
  })();
  return { items, take: () => items.splice(0, items.length) };
}

class Harness {
  readonly sup = new Supervisor();
  observeText = IDLE;
  observeCalls = 0;
  actCalls: JsonValue[] = [];
  actContexts: ContextKey[] = [];
  actReply = "成功:開始了";
  readonly tools = new ToolRegistry();
  readonly commands = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
  readonly prompts = new PromptContributors();
  readonly queue: RequestQueue;
  readonly hintLog: Log<string>;
  readonly nudgeLog: Log<Record<string, JsonValue>>;
  readonly traceLog: Log<Record<string, JsonValue>>;

  private constructor() {
    const observe: Tool = {
      spec: {
        name: "game_minecraft_observe",
        description: "查看 Minecraft 現在的狀態",
        parameters: { type: "object", properties: {} },
      },
      call: async () => {
        this.observeCalls += 1;
        return this.observeText;
      },
    };
    const act: Tool = {
      spec: {
        name: "game_minecraft_act",
        description:
          "在 Minecraft 裡做一個高階動作。可用動作:\n- goto:走\n- mine:挖\n- get:取得\n- chat:說話",
        parameters: { type: "object", properties: { action: { type: "string" } } },
      },
      call: async (ctx, args) => {
        this.actCalls.push(args);
        this.actContexts.push(ctx.context);
        return this.actReply;
      },
    };
    this.tools.register(observe);
    this.tools.register(act);
    this.queue = new RequestQueue(undefined, {
      publisher: (event) => this.sup.bus.publish("queue", event),
    });
    this.hintLog = collect(this.sup.bus.subscribe("agent.initiative"), (e) => {
      if (e.type !== "agent_initiative") return null;
      expect(e.data.reason).toBe("game");
      return e.data.hint;
    });
    this.nudgeLog = collect(this.sup.bus.subscribe("mood.nudge"), (e) =>
      e.type === "custom" ? (e.data.payload as Record<string, JsonValue>) : null,
    );
    this.traceLog = collect(this.sup.bus.subscribe(DECISION_TOPIC), (e) =>
      e.type === "custom" ? (e.data.payload as Record<string, JsonValue>) : null,
    );
  }

  static async create(
    provider: ChatProvider,
    config: JsonValue | null = null,
    actuators: ((h: Harness) => ActuatorRegistry) | null = null,
  ): Promise<Harness> {
    const h = new Harness();
    const router = new LlmRouter(
      new Map([[provider.name, provider]]),
      new Map([["game", [parseModelRef(`${provider.name}:m`)]]]),
    );
    const services = h.sup.services;
    if (actuators) services.provide("app", ActuatorRegistryKey, actuators(h));
    services.provide("app", ToolRegistryKey, h.tools);
    services.provide("app", CommandRegistryKey, h.commands);
    services.provide("app", RequestQueueKey, h.queue);
    services.provide("app", PromptContributorsKey, h.prompts);
    services.provide("app", LlmRouterKey, router);
    await h.sup.register(new GameModule("DeepSeek醬", "傲嬌的鯨魚女孩,嘴硬心軟。"), config, true);
    await h.sup.startAll();
    return h;
  }

  async stop(): Promise<void> {
    const done = this.sup.stopAll();
    await vi.advanceTimersByTimeAsync(10);
    await done;
  }

  async command(
    path: string,
    args: Record<string, ArgValue> = {},
    context: ContextKey = textCtx(),
  ): Promise<string> {
    const inv = Invocation.create(path, owner(), context);
    inv.invoker_display_name = "Owen";
    for (const [k, v] of Object.entries(args)) inv.withArg(k, v);
    const reply = await this.commands.dispatch(inv);
    await settle();
    return reply.text;
  }

  start(): Promise<string> {
    return this.command("game start", { where: "here" });
  }

  async publish(event: Event): Promise<void> {
    this.sup.bus.publish("test", event);
    await settle();
  }

  async gameEvent(
    kind: string,
    text: string,
    important: boolean,
    extra: Record<string, JsonValue> = {},
  ): Promise<void> {
    await this.publish({
      type: "custom",
      data: {
        topic: `game.minecraft.${kind}`,
        payload: { type: kind, data: { text, ...extra }, important },
      },
    });
  }

  acts(): Array<Record<string, JsonValue>> {
    return this.actCalls as Array<Record<string, JsonValue>>;
  }

  actNames(): JsonValue[] {
    return this.acts().map((a) => a.action ?? "");
  }

  status(): GameStatus | null {
    return this.sup.services.require(GameHandleKey).status();
  }

  hints(): string[] {
    return this.hintLog.take();
  }

  nudges(): Array<Record<string, JsonValue>> {
    return this.nudgeLog.take();
  }

  submit(text: string, who: string, kind = "game_goal"): number {
    return this.queue.submit({
      requester: { platform: "discord", id: who },
      requesterName: who,
      kind,
      text,
    }).item.id;
  }
}

function promptRequest(): PromptRequest {
  return {
    profile: "p",
    turn: "t",
    context: textCtx(),
    participants: [],
    speakers: [],
    query: "你在幹嘛",
    recent: [],
    voice: false,
    now: new Date().toISOString(),
  } as unknown as PromptRequest;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2025, 2, 10, 4, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

// ----- tests -----

describe("game director", () => {
  it("decide_loop_keeps_the_goal_while_the_bot_works", async () => {
    const llm = new MockProvider("mock")
      .reply(decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }))
      .reply(decision("砍樹", { name: "mine", args: { block: "oak_log" } }));
    const h = await Harness.create(llm);
    const reply = await h.start();
    expect(reply).toContain("開始玩 Minecraft");

    // First decision right away: the goal action runs.
    expect(h.acts()).toEqual([{ action: "mine", args: { block: "iron_ore" } }]);
    const req = llm.requests()[0] as ChatRequest;
    expect(req.json_mode).toBe(true);
    const session = req.session ?? "";
    expect(session.startsWith("miyoria-") && session.endsWith("-game-minecraft")).toBe(true);
    expect(req.messages[0]?.content).toContain("傲嬌的鯨魚女孩");
    expect(req.messages[0]?.content).toContain("- mine:挖");
    expect(req.messages[1]?.content).toContain("剛開始玩");
    expect(h.status()?.goal?.text).toBe("挖鐵礦");

    // The bot is busy: switching to another goal is refused until the goal is old enough.
    h.observeText = BUSY;
    await secs(20);
    expect(llm.requests()).toHaveLength(2);
    expect(llm.requests()[1]?.messages[1]?.content).toContain("目前目標:挖鐵礦");
    await secs(20);
    expect(llm.requests()).toHaveLength(3);
    expect(h.acts()).toHaveLength(1);
    expect(h.status()?.goal?.text).toBe("挖鐵礦");
    await secs(20);
    expect(llm.requests()).toHaveLength(4);
    expect(h.acts()).toHaveLength(2);
    expect((h.acts()[1]?.args as { block: string } | undefined)?.block).toBe("oak_log");
    expect(h.status()?.goal?.text).toBe("砍樹");

    // Same action again while busy: not re-issued; once idle it is.
    await secs(20);
    expect(h.acts()).toHaveLength(2);
    h.observeText = IDLE;
    await secs(20);
    expect(h.acts()).toHaveLength(3);
    await h.stop();
  });

  it("director_actions_and_commands_go_through_the_gate", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const gate: Record<string, JsonValue>[] = [];
    let registry: ActuatorRegistry | null = null;
    const h = await Harness.create(llm, null, (harness) => {
      registry = new ActuatorRegistry({
        services: harness.sup.services,
        builtins: false,
        publish: (e) => {
          if (e.type === "custom" && e.data.topic === "gate.decision") {
            gate.push(e.data.payload as Record<string, JsonValue>);
          }
        },
      });
      return registry;
    });
    await h.start();
    expect(h.acts()).toHaveLength(1);
    const who = (d: Record<string, JsonValue>) => [
      d.capability,
      (d.principal as Record<string, JsonValue>).kind,
      d.allowed,
    ];
    expect(gate.map(who)).toEqual([
      ["game.start", "command", true],
      ["game.act", "director", true],
    ]);

    // Paused: the director may not act any more; commands still go through.
    await (registry as unknown as ActuatorRegistry).setPaused(true);
    expect(await h.command("game goal", { text: "砍樹" })).toContain("已設定新目標");
    await secs(20);
    expect(h.acts(), "no act while paused").toHaveLength(1);
    const paused = gate.filter((d) => d.capability === "game.act").at(-1);
    expect(paused).toMatchObject({ allowed: false, stage: "pause" });
    expect(gate.some((d) => d.capability === "game.goal" && d.allowed === true)).toBe(true);
    await h.stop();
  });

  it("publishes the decision trace", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }, "開工囉"),
    );
    const h = await Harness.create(llm);
    await h.start();
    const trace = h.traceLog.take();
    expect(trace).toHaveLength(1);
    expect(trace[0]).toEqual({
      game: "minecraft",
      trigger: ["剛開始玩"],
      goal: "挖鐵礦",
      action: 'mine {"block":"iron_ore"}',
      verdict: "Replace",
      commentary: "開工囉",
      busy: false,
    });
    await h.stop();
  });

  it("queue_goals_are_consumed_and_finished", async () => {
    const llm = new FnProvider((user) => {
      if (user.includes("目前目標:沒有")) return decision("閒晃", null);
      if (user.includes("蓋房子") && user.includes("目前目標:蓋房子")) {
        return decision("蓋房子", { name: "goto", args: { x: 1, z: 2 } });
      }
      return decision("挖鑽石", { name: "goto", args: { block: "diamond_ore" } });
    });
    const h = await Harness.create(llm);
    await h.start();
    h.hints();
    expect(h.acts()).toEqual([]);

    const first = h.submit("挖鑽石", "Amy");
    const second = h.submit("蓋房子", "Bob");
    const song = h.submit("唱歌", "Owen", "song");
    expect(h.queue.next()?.id).toBe(first);
    await settle();
    expect(h.queue.next()?.id).toBe(second);
    await settle();
    expect(h.queue.next()?.id).toBe(song);
    await settle();

    // The viewer goal is announced at once and becomes the current goal; the second one waits.
    const hints = h.hints();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("觀眾 Amy 想要你:挖鑽石");
    const status = h.status();
    expect([status?.goal?.text, status?.goal?.queue_item]).toEqual(["挖鑽石", first]);
    expect(status?.backlog).toEqual([`#${second} 蓋房子(Bob)`]);

    // An early decision (min_decide_secs after the first) acts on it.
    await secs(4);
    expect(h.actNames()).toEqual(["goto"]);
    expect(llm.requests.at(-1)?.messages[1]?.content).toContain("觀眾 Amy 的請求");

    // Events right after the action belong to the previous goal.
    await h.gameEvent("goal_reached", "抵達目標了", false);
    expect(h.queue.get(first)?.state).toBe("active");
    await secs(3);
    await h.gameEvent("goal_reached", "抵達目標了", false);
    expect(h.queue.get(first)?.state).toBe("done");
    expect(h.hints().some((x) => x.includes("完成了觀眾 Amy 的請求"))).toBe(true);

    // The next viewer goal took over; failing it skips the queue item.
    expect(h.status()?.goal?.queue_item).toBe(second);
    await secs(4);
    expect(h.acts()).toHaveLength(2);
    expect(h.acts()[1]?.args).toEqual({ x: 1, z: 2 });
    await secs(4);
    await h.gameEvent("goal_failed", "找不到路,目標失敗", false);
    expect(h.queue.get(second)?.state).toBe("skipped");
    expect(h.status()?.goal).toBeNull();
    // Other kinds are left alone.
    expect(h.queue.get(song)?.state).toBe("active");
    await h.stop();
  });

  it("commentary_is_rate_limited_but_deaths_get_through", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null, "吐槽一下天氣"));
    const h = await Harness.create(llm, { decide_secs: 5 });
    await h.start();
    for (let i = 0; i < 6; i++) await secs(5);
    // Decisions at 0, 5, ..., 30; commentary at most every 15 s.
    expect(llm.requests()).toHaveLength(7);
    const hints = h.hints();
    expect(hints).toHaveLength(3);
    expect(hints[0]).toContain("實況:吐槽一下天氣");
    expect(hints[0]).toContain("你正在直播玩 Minecraft");

    // An important event bypasses the regular limit (only the short urgent one applies).
    await secs(1);
    await h.gameEvent("death", "死掉了(苦力怕)", true);
    expect(h.hints()).toEqual([]);
    await secs(3);
    await h.gameEvent("death", "死掉了(苦力怕)", true);
    const urgent = h.hints();
    expect(urgent).toHaveLength(1);
    expect(urgent[0]).toBe("(你正在直播玩 Minecraft)剛剛死掉了(苦力怕)!馬上用一兩句話反應。");
    await h.stop();
  });

  it("death_nudges_mood_and_resets_goals", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const h = await Harness.create(llm);
    await h.start();
    expect(h.status()?.goal?.text).toBe("挖鐵礦");
    h.nudges();

    // Her own goal is dropped on death...
    await secs(1);
    await h.gameEvent("death", "死掉了(岩漿)", true);
    expect(h.status()?.goal).toBeNull();
    const nudges = h.nudges();
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.reason).toBe("game: death");
    expect(Number(nudges[0]?.valence)).toBeLessThan(0);
    // ...and the next (early) decision picks one again.
    await secs(4);
    expect(h.acts()).toHaveLength(2);
    expect(llm.requests().at(-1)?.messages[1]?.content).toContain("死掉了(岩漿)");

    // A commanded goal survives the death and is re-issued.
    const reply = await h.command("game goal", { text: "去挖鐵礦" });
    expect(reply).toContain("已設定新目標");
    await secs(4);
    expect(h.acts()).toHaveLength(3);
    const goal = h.status()?.goal;
    expect(goal?.text).toBe("去挖鐵礦");
    expect(goal?.note).toContain("Owen");
    // While the bot is busy the same action is not repeated...
    h.observeText = BUSY;
    await secs(20);
    expect(h.acts()).toHaveLength(3);
    // ...but after a death the goal starts over, so it is issued again.
    await h.gameEvent("death", "死掉了", true);
    const reset = h.status()?.goal;
    expect([reset?.text, reset?.action]).toEqual(["去挖鐵礦", null]);
    await secs(4);
    expect(h.acts()).toHaveLength(4);
    const again = h.status()?.goal;
    expect(again?.text).toBe("去挖鐵礦");
    expect(again?.action).not.toBeNull();

    // Achievements cheer her up.
    await h.gameEvent("advancement", "達成成就「石器時代」", true);
    expect(h.nudges().some((n) => n.reason === "game: advancement" && Number(n.valence) > 0)).toBe(
      true,
    );
    await h.stop();
  });

  it("stop_ends_the_session", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    expect(await h.command("game stop")).toContain("她目前沒有在玩遊戲");
    expect(await h.command("game status")).toContain("她目前沒有在玩遊戲");
    await h.start();
    expect(await h.start()).toContain("她已經在玩");
    const status = await h.command("game status");
    expect(status).toContain("正在玩：Minecraft");

    // While playing the chat prompt knows about the game.
    const section = await h.prompts.all()[0]?.contribute(promptRequest());
    expect(section?.[0]?.key).toBe("game");
    expect(section?.[0]?.title).toBe("你正在玩的遊戲");
    expect(section?.[0]?.order).toBe(45);
    expect(section?.[0]?.body).toContain("你正在直播玩 Minecraft");
    expect(section?.[0]?.body).toContain("目前沒有特定目標。");
    expect(section?.[0]?.body).toContain("血量 20/20");

    const reply = await h.command("game stop");
    expect(reply).toContain("她已停止玩");
    expect(h.actNames()).toEqual(["stop"]);
    expect(h.status()).toBeNull();
    expect(await h.prompts.all()[0]?.contribute(promptRequest())).toEqual([]);
    const asked = llm.requests().length;
    await secs(60);
    expect(llm.requests()).toHaveLength(asked);

    // Stopping the module removes its commands and prompt.
    await h.stop();
    expect(h.commands.specs()).toEqual([]);
    expect(h.prompts.all()).toEqual([]);
  });

  it("start_checks_the_adapter_and_picks_the_context", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm, {
      stream_context: { platform: "discord", scope: "g2", channel: "stream", kind: "voice" },
    });
    const missing = await h.command("game start", { game: "terraria" });
    expect(missing).toContain("找不到 terraria");

    // Without a voice channel, `auto` falls back to the stream context.
    await h.command("game start");
    expect(h.status()?.context.channel).toBe("stream");
    await h.command("game stop");

    // In a voice channel, `auto` uses it.
    await h.publish({ type: "voice_joined", data: { context: voiceCtx(), participants: [] } });
    await h.command("game start");
    expect(h.status()?.context).toEqual(voiceCtx());
    await h.command("game stop");
    // The final `stop` action runs with the session's context.
    expect(h.actContexts.at(-1)).toEqual(voiceCtx());

    await h.publish({ type: "voice_left", data: { context: voiceCtx(), reason: null } });
    const reply = await h.command("game start", { where: "voice" });
    expect(reply).toContain("不在語音頻道中");
    await h.stop();
  });

  it("no_llm_while_the_game_is_unreachable", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    h.observeText = '沒有連上 Minecraft。\n\n狀態:{"connected":false}';
    await h.start();
    await secs(40);
    expect(h.observeCalls).toBe(3);
    expect(llm.requests()).toEqual([]);
    expect(h.status()?.summary).toContain("沒有連上");

    // Losing the adapter tools shows up as an observation error.
    h.tools.unregister("game_minecraft_observe");
    await secs(20);
    expect(h.status()?.summary).toContain("看不到遊戲");
    await h.stop();
  });

  it("failed_actions_count_against_requested_goals", async () => {
    const llm = new MockProvider("mock").reply(
      decision("蓋房子", { name: "get", args: { item: "oak_planks" } }),
    );
    const h = await Harness.create(llm, { max_attempts: 2 });
    h.actReply = "失敗:沒有安裝 AltoClef";
    await h.start();
    // Her own goal is not adopted when its action fails.
    expect(h.status()?.goal).toBeNull();
    expect(h.status()?.last_action).toContain("失敗");

    await h.command("game goal", { text: "蓋房子" });
    await secs(4);
    expect(h.status()?.goal).not.toBeNull();
    await secs(4);
    expect(h.status()?.goal).toBeNull();
    await h.stop();
  });
});

describe("game director details", () => {
  it("clamps and prefixes the model's mood nudges", async () => {
    const llm = new MockProvider("mock").reply(
      JSON.stringify({
        goal: "x",
        action: null,
        mood_nudge: { valence: 0.9, arousal: -0.5, energy: 0, reason: "賺到了" },
      }),
    );
    const h = await Harness.create(llm);
    await h.start();
    expect(h.nudges()).toEqual([
      { valence: 0.1, arousal: -0.1, energy: 0, reason: "game: 賺到了" },
    ]);
    await h.stop();
  });

  it("an unreadable reply is logged and the loop continues", async () => {
    const llm = new MockProvider("mock").reply("我不知道").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    await h.start();
    expect(llm.requests()).toHaveLength(1);
    expect(h.acts()).toEqual([]);
    await secs(20);
    expect(llm.requests()).toHaveLength(2);
    await h.stop();
  });

  it("gives up a goal that ran too long", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const h = await Harness.create(llm, { max_goal_secs: 30 });
    h.observeText = BUSY;
    await h.start();
    expect(h.status()?.goal?.text).toBe("挖鐵礦");
    await secs(20);
    expect(h.status()?.goal?.text).toBe("挖鐵礦");
    await secs(20);
    // The old goal failed ("太久了,放棄") and the next decision adopted a new one.
    expect(h.status()?.recent).toContain("目標失敗:挖鐵礦(太久了,放棄)");
    await h.stop();
  });

  it("module stop cancels everything in flight", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const h = await Harness.create(llm);
    await h.start();
    const acted = h.acts().length;
    await h.stop();
    await secs(120);
    expect(h.acts()).toHaveLength(acted);
    expect(llm.requests()).toHaveLength(1);
  });

  it("restarting the module drops the old session and keeps services consistent", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    await h.start();
    expect(h.status()).not.toBeNull();
    const restart = h.sup.restart("game");
    await vi.advanceTimersByTimeAsync(10);
    await restart;
    expect(h.status()).toBeNull();
    expect(await h.command("game status")).toContain("她目前沒有在玩遊戲。");
    await h.stop();
  });
});

describe("game status command", () => {
  it("formats the status", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const h = await Harness.create(llm);
    h.observeText = BUSY;
    await h.start();
    const out = await h.command("game status");
    expect(out).toBe(
      [
        "遊戲狀態",
        "正在玩：Minecraft（實況送到 discord:g1:text1）",
        "目標：挖鐵礦（已進行 0 秒）",
        '動作：mine {"block":"iron_ore"}',
        "遊戲 bot：忙碌中",
        "狀況：血量 20/20／位置 (5, 64, 5)／Baritone 執行中(Mine)",
      ].join("\n"),
    );
    await h.stop();
  });
});

describe("GameModule", () => {
  it("provides the handle and control services", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    const handle = h.sup.services.require(GameHandleKey);
    const control = h.sup.services.require(GameControlKey);
    expect(handle).toBeInstanceOf(GameHandle);
    expect(control).toBeInstanceOf(GameControl);
    expect(handle.status()).toBeNull();

    await expect(control.stop()).rejects.toBeInstanceOf(GameError);
    await expect(control.stop()).rejects.toThrow("她目前沒有在玩遊戲。");
    await expect(control.start("terraria", textCtx(), owner())).rejects.toThrow("找不到 terraria");
    expect(await control.start("minecraft", textCtx(), owner())).toContain("實況會在這個頻道進行");
    expect(handle.status()?.context).toEqual(textCtx());
    expect(await control.goal(" 去蓋房子 ", "Panel")).toBe("已設定新目標：去蓋房子。");
    await expect(control.goal("  ", "Panel")).rejects.toThrow("請輸入目標。");
    await settle();
    expect(handle.status()?.goal?.note).toBe("(Panel 指定的)");
    expect(await control.stop()).toContain("她已停止玩 Minecraft。");
    await h.stop();
  });

  it("status JSON keeps the Rust shape", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    await h.start();
    const status = h.status() as GameStatus;
    expect(Object.keys(status).sort()).toEqual(
      [
        "backlog",
        "busy",
        "context",
        "game",
        "game_name",
        "goal",
        "last_action",
        "recent",
        "started_at",
        "summary",
      ].sort(),
    );
    expect(status.game).toBe("minecraft");
    expect(status.game_name).toBe("Minecraft");
    expect(typeof status.started_at).toBe("string");
    await h.stop();
  });

  it("stop lists open viewer requests", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    await h.start();
    const a = h.submit("挖鑽石", "Amy");
    const b = h.submit("蓋房子", "Bob");
    h.queue.next();
    h.queue.next();
    await settle();
    expect(await h.command("game stop")).toBe(
      `她已停止玩 Minecraft。觀眾請求 #${a}、#${b} 尚未完成，已保留在佇列中。`,
    );
    await h.stop();
  });

  it("works without any optional service and manifest matches Rust", async () => {
    const m = new GameModule("A", "B").manifest;
    expect(m.id).toBe("game");
    expect(m.requires).toEqual([]);
    expect(m.optional).toEqual(["llm", "commands", "queue", "extensions"]);

    const sup = new Supervisor();
    await sup.register(new GameModule("A", "B"), null, true);
    await sup.startAll();
    const control = sup.services.require(GameControlKey);
    await expect(control.start("minecraft", textCtx(), owner())).rejects.toThrow(
      "工具系統沒有啟用，無法玩遊戲。",
    );
    const stopping = sup.stopAll();
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
  });

  it("fromProfile uses the display name, persona and profile id", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const profile = {
      id: "deepseek",
      displayName: "DeepSeek醬",
      personaPrompt: () => "傲嬌的鯨魚女孩",
    };
    const sup = new Supervisor();
    const tools = new ToolRegistry();
    tools.register({
      spec: {
        name: "game_minecraft_observe",
        description: "x",
        parameters: { type: "object" },
      },
      call: async () => IDLE,
    });
    tools.register({
      spec: { name: "game_minecraft_act", description: "在 Minecraft 裡做事", parameters: {} },
      call: async () => "成功",
    });
    sup.services.provide("app", ToolRegistryKey, tools);
    sup.services.provide(
      "app",
      LlmRouterKey,
      new LlmRouter(new Map([["mock", llm]]), new Map([["game", [parseModelRef("mock:m")]]])),
    );
    await sup.register(GameModule.fromProfile(profile as never), null, true);
    await sup.startAll();
    await sup.services.require(GameControlKey).start("minecraft", textCtx(), owner());
    await settle();
    const request = llm.requests()[0];
    expect(request?.messages[0]?.content).toContain("你是 DeepSeek醬,正在直播玩 Minecraft");
    expect(request?.messages[0]?.content).toContain("傲嬌的鯨魚女孩");
    expect(request?.session).toBe("miyoria-deepseek-game-minecraft");
    const stopping = sup.stopAll();
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
  });
});
