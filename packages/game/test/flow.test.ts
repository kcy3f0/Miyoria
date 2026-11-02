// "去玩 Minecraft" end to end with a fake adapter: the start checks that the game runs, starts
// the session (published for the stage's scene director), sets the first goal, goes live
// through the gate when asked, and the director acts as `director`. In-game chat lines are
// sanitized on the way to the adapter.

import {
  ActuatorRegistry,
  ActuatorRegistryKey,
  defineCapability,
  type GateDecision,
} from "@miyoria/actions";
import { Supervisor } from "@miyoria/kernel";
import { LlmRouter, LlmRouterKey, MockProvider, parseModelRef } from "@miyoria/llm";
import { type Tool, type ToolContext, ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  type ContextKey,
  type Event,
  type JsonValue,
  type Principal,
  Principals,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  GameChatKey,
  GameControlKey,
  GameModule,
  SESSION_TOPIC,
  safeActCall,
} from "../src/index.js";

const TEXT: ContextKey = { platform: "discord", scope: "g1", channel: "text1", kind: "channel" };
const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "voice1", kind: "voice" };
const OWEN: AccountRef = { platform: "discord", id: "7" };

const READY = '血量 20/20\n\n狀態:{"connected":true,"in_game":true,"busy":false}';
const MENU = '還在主選單。\n\n狀態:{"connected":true,"in_game":false}';
const DOWN = '沒有連上 Minecraft。\n\n狀態:{"connected":false}';

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5);
}

class Flow {
  readonly sup = new Supervisor();
  readonly tools = new ToolRegistry();
  readonly registry: ActuatorRegistry;
  readonly gate: GateDecision[] = [];
  readonly events: Event[] = [];
  readonly streams: { principal: Principal; args: JsonValue }[] = [];
  readonly acts: { args: JsonValue; principal: Principal | undefined }[] = [];
  observeText = READY;

  private constructor() {
    this.registry = new ActuatorRegistry({
      services: this.sup.services,
      tools: this.tools,
      builtins: false,
      publish: (e) => {
        if (e.type === "custom" && e.data.topic === "gate.decision") {
          this.gate.push(e.data.payload as unknown as GateDecision);
        }
      },
    });
    const observe: Tool = {
      spec: { name: "game_minecraft_observe", description: "看", parameters: { type: "object" } },
      call: async () => this.observeText,
    };
    const act: Tool = {
      spec: {
        name: "game_minecraft_act",
        description: "在 Minecraft 裡做一個高階動作。可用動作:\n- mine:挖\n- chat:說話",
        parameters: { type: "object" },
      },
      call: async (ctx: ToolContext, args) => {
        this.acts.push({ args, principal: ctx.principal });
        return "成功:好";
      },
    };
    this.tools.register(observe);
    this.tools.register(act);
    // Go Live, faked: the real one is the voice module's.
    this.registry.register(
      defineCapability({
        name: "stream.start",
        summary: "開始 Go Live 直播",
        risk: "medium",
        args: z.object({ guild: z.string().nullish() }),
        permission: "voice.golive",
        scope: (args: { guild?: string | null }) => args.guild ?? null,
        execute: async (args, ctx) => {
          this.streams.push({ principal: ctx.principal, args: args as JsonValue });
          return "Go Live started";
        },
      }),
    );
    const sub = this.sup.bus.subscribe("*");
    void (async () => {
      for await (const env of sub) this.events.push(env.event);
    })();
  }

  static async create(): Promise<Flow> {
    const f = new Flow();
    const llm = new MockProvider("mock");
    for (let i = 0; i < 10; i++) {
      llm.reply(
        JSON.stringify({
          goal: "挖鐵礦",
          goal_status: "working",
          action: { name: "mine", args: { block: "iron_ore" } },
          commentary: null,
        }),
      );
    }
    const router = new LlmRouter(
      new Map([[llm.name, llm]]),
      new Map([["game", [parseModelRef("mock:m")]]]),
    );
    const services = f.sup.services;
    services.provide("app", ActuatorRegistryKey, f.registry);
    services.provide("app", ToolRegistryKey, f.tools);
    services.provide("app", LlmRouterKey, router);
    await f.sup.register(new GameModule("DeepSeek醬", "傲嬌"), null, true);
    await f.sup.startAll();
    return f;
  }

  async publish(event: Event): Promise<void> {
    this.sup.bus.publish("test", event);
    await settle();
  }

  /** Her `game_start` tool, as she decided on her own in `context`. */
  async startTool(args: JsonValue, context: ContextKey = TEXT): Promise<string> {
    const tool = this.tools.get("game_start");
    if (!tool) throw new Error("no game_start tool");
    const principal = Principals.self(context, OWEN);
    const out = await tool.call(
      {
        turn: "01JC0000000000000000000000",
        context,
        account: OWEN,
        principal,
        message: { context, id: "m" },
        priority: "direct",
        signal: new AbortController().signal,
      },
      { ...(args as object), on_own: true },
    );
    await settle();
    return out;
  }

  sessions(): JsonValue[] {
    return this.events.flatMap((e) =>
      e.type === "custom" && e.data.topic === SESSION_TOPIC ? [e.data.payload] : [],
    );
  }

  async stop(): Promise<void> {
    const done = this.sup.stopAll();
    await vi.advanceTimersByTimeAsync(10);
    await done;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 2, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("去玩 Minecraft", () => {
  it("refuses when the game is not running, so she can tell the owner", async () => {
    const f = await Flow.create();
    f.observeText = DOWN;
    await expect(f.startTool({})).rejects.toThrow(/還沒開.*請擁有者先在直播機開遊戲/);
    expect(f.sup.services.require(GameControlKey)).toBeDefined();
    expect(f.sessions()).toEqual([]);
    expect(f.acts).toEqual([]);
    await f.stop();
  });

  it("starts from the main menu with a note", async () => {
    const f = await Flow.create();
    f.observeText = MENU;
    const text = await f.startTool({});
    expect(text).toContain("她開始玩 Minecraft 了");
    expect(text).toContain("還在主選單");
    expect(text).toContain("現在沒有在直播");
    await f.stop();
  });

  it("starts, sets the goal, goes live through the gate and plays as the director", async () => {
    const f = await Flow.create();
    await f.publish({ type: "voice_joined", data: { context: VOICE, participants: [] } });
    const text = await f.startTool({ goal: "去挖鐵礦", stream: true });
    expect(text).toContain("她開始玩 Minecraft 了，實況會在語音頻道進行。");
    expect(text).toContain("已設定新目標：去挖鐵礦");
    expect(text).toContain("也開台了");

    // The session is published (the stage's scene director switches to the game scene).
    expect(f.sessions()).toEqual([
      { state: "started", game: "minecraft", game_name: "Minecraft", context: VOICE },
    ]);
    // Go Live ran for the same principal, in the guild of her voice channel.
    expect(f.streams).toHaveLength(1);
    expect(f.streams[0]?.principal.kind).toBe("self");
    expect(f.streams[0]?.args).toEqual({ guild: "g1" });

    // The director's first action goes through the gate as `director`.
    await vi.advanceTimersByTimeAsync(100);
    expect(f.acts.length).toBeGreaterThan(0);
    expect(f.acts[0]?.principal?.kind).toBe("director");
    const kinds = f.gate.map((d) => [d.capability, d.principal.kind, d.allowed]);
    expect(kinds).toContainEqual(["game.start", "self", true]);
    expect(kinds).toContainEqual(["stream.start", "self", true]);
    expect(kinds).toContainEqual(["game.act", "director", true]);

    // Stopping publishes the end of the session.
    expect(await f.sup.services.require(GameControlKey).stop()).toContain("已停止");
    expect(f.sessions().at(-1)).toMatchObject({ state: "stopped", game: "minecraft" });
    await f.stop();
  });

  it("does not go live when the gate refuses it", async () => {
    const f = await Flow.create();
    f.registry.configure({ ...f.registry.config, forbidden: ["stream.*"] });
    await f.publish({ type: "voice_joined", data: { context: VOICE, participants: [] } });
    const text = await f.startTool({ stream: true });
    expect(text).toContain("她開始玩 Minecraft 了");
    expect(text).toContain("沒有開台");
    expect(f.streams).toEqual([]);
    await f.stop();
  });

  it("leaves player chat to the game chat conversation", async () => {
    const f = await Flow.create();
    let handled = true;
    f.sup.services.provide("chat", GameChatKey, { handles: () => handled });
    // In voice, where her commentary goes.
    await f.publish({ type: "voice_joined", data: { context: VOICE, participants: [] } });
    await f.startTool({});
    await vi.advanceTimersByTimeAsync(100);
    const hints = () =>
      f.events.flatMap((e) => (e.type === "agent_initiative" ? [e.data.hint] : []));
    const before = hints().length;
    const chat = (message: string, system = false) =>
      f.publish({
        type: "custom",
        data: {
          topic: "game.minecraft.chat",
          payload: {
            type: "chat",
            data: { sender: "Steve", message, system, text: `Steve 在遊戲裡說:${message}` },
            important: true,
          },
        },
      });
    await chat("妳好");
    expect(hints().length, "no commentary on player chat").toBe(before);
    // Without `game.chat` the director reacts to it as before.
    handled = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await chat("哈囉");
    expect(hints().at(-1)).toContain("Steve 在遊戲裡說:哈囉");
    await f.stop();
  });

  it("chat lines reach the adapter as one short line without a command prefix", async () => {
    expect(safeActCall({ action: "chat", args: { message: "/kill @a\n第二行" } })).toEqual({
      action: "chat",
      args: { message: "kill @a 第二行" },
    });
    expect(() => safeActCall({ action: "chat", args: { message: "///" } })).toThrow(/nothing/);
    // Other actions pass unchanged.
    const mine = { action: "mine", args: { block: "iron_ore" } };
    expect(safeActCall(mine)).toBe(mine);

    const f = await Flow.create();
    const out = await f.registry.invoke({
      principal: Principals.director(TEXT),
      capability: "game.act",
      args: { game: "minecraft", call: { action: "chat", args: { message: "#goto 0 0 §c好" } } },
      why: null,
      turn: null,
    });
    expect(out.status).toBe("done");
    expect(f.acts.at(-1)?.args).toEqual({ action: "chat", args: { message: "goto 0 0 好" } });
    await f.stop();
  });
});
