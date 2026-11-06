// The game capabilities as her tools: each calls the game control through the gate.

import { ActuatorRegistry } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { type ToolContext, ToolRegistry } from "@miyoria/tools";
import {
  type AccountRef,
  AuthorizerKey,
  BaseAuthorizer,
  type ContextKey,
  Principals,
  type Subject,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { gameCapabilities } from "../src/actions.js";
import type { GameControl, Placement } from "../src/index.js";
import { GameError } from "../src/index.js";
import { FakeExecutor, FakeExecutors } from "./fake-executor.js";

const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OWEN: AccountRef = { platform: "discord", id: "7" };

class Grants extends BaseAuthorizer {
  constructor(readonly nodes: Set<string>) {
    super();
  }

  allowsSubject(_subject: Subject, node: string): boolean {
    return this.nodes.has(node);
  }
}

function setup(nodes: string[]) {
  const calls: string[] = [];
  const control = {
    async start(game: string, context: ContextKey, account: AccountRef, placement: Placement) {
      calls.push(`start ${game} ${context.channel} ${account.id} ${placement}`);
      return "她開始玩 Minecraft 了";
    },
    async stop() {
      calls.push("stop");
      throw new GameError("她目前沒有在玩遊戲。");
    },
    async goal(text: string, by: string) {
      calls.push(`goal ${text} ${by}`);
      return `已設定新目標:${text}`;
    },
    session() {
      return null;
    },
  } as unknown as GameControl;
  const services = new ServiceRegistry();
  services.provide("test", AuthorizerKey, new Grants(new Set(nodes)));
  const tools = new ToolRegistry();
  const registry = new ActuatorRegistry({ services, tools, builtins: false });
  for (const c of gameCapabilities({
    control,
    defaultGame: "minecraft",
    permissions: { start: "game.start", stop: "game.stop", goal: "game.goal" },
    toolTimeoutMs: 1000,
  })) {
    registry.register(c);
  }
  const ctx: ToolContext = {
    turn: "01JC0000000000000000000000",
    context: CTX,
    account: OWEN,
    principal: Principals.user(OWEN, CTX),
    message: { context: CTX, id: "m" },
    priority: "direct",
    signal: new AbortController().signal,
  };
  return { calls, tools, registry, ctx, services };
}

describe("game capabilities", () => {
  it("tools start, stop and steer the game through the gate", async () => {
    const s = setup(["game.start", "game.goal"]);
    expect(s.tools.names()).toEqual(["game_goal", "game_start", "game_stop"]);
    expect(await s.tools.get("game_start")?.call(s.ctx, {})).toBe("她開始玩 Minecraft 了");
    expect(await s.tools.get("game_goal")?.call(s.ctx, { text: "去挖鐵礦" })).toContain("去挖鐵礦");
    // Not allowed to ask for a stop; refused before the control is called.
    await expect(s.tools.get("game_stop")?.call(s.ctx, {})).rejects.toThrow(/not allowed/);
    expect(s.calls).toEqual(["start minecraft c1 7 auto", "goal 去挖鐵礦 聊天室"]);
    // On her own the permission is not needed; the director's refusal comes back as an error.
    await expect(s.tools.get("game_stop")?.call(s.ctx, { on_own: true })).rejects.toThrow(
      "她目前沒有在玩遊戲。",
    );
    expect(s.calls.at(-1)).toBe("stop");
  });

  it("game.act is the director's, not a tool", async () => {
    const s = setup([]);
    expect(s.registry.get("game.act")?.tool).toBeUndefined();
    const out = await s.registry.invoke({
      principal: Principals.director(CTX),
      capability: "game.act",
      args: { game: "minecraft", call: { action: "stop", args: {} } },
      why: null,
      turn: null,
    });
    expect(out.status).toBe("failed");
    expect(out.status === "failed" && out.error).toContain("沒有任務執行器");
  });

  it("game.act starts one task; waiting answers with its end and its code", async () => {
    const s = setup([]);
    const published: unknown[] = [];
    const exec = new FakeExecutor((e) => published.push(e));
    new FakeExecutors(exec).provide(s.services);
    const act = (args: Record<string, unknown>, signal?: AbortSignal) =>
      s.registry.invoke(
        {
          principal: Principals.director(CTX),
          capability: "game.act",
          args: { game: "minecraft", ...args } as never,
          why: null,
          turn: null,
        },
        signal ? { signal } : {},
      );

    // The director: its own id and budget, back once accepted.
    const started = await act({
      call: { action: "mine", args: { block: "stone" } },
      task: { id: "01T1", budget_s: 42 },
      wait: false,
    });
    expect(started).toMatchObject({ status: "done", result: { data: { task: "01T1" } } });
    expect(exec.starts.at(-1)).toEqual({
      id: "01T1",
      goal: "mine",
      args: { block: "stone" },
      budget_s: 42,
    });
    expect(exec.running.has("01T1")).toBe(true);

    // Waiting (game chat): the end's detail, or the failure with its code; the goal's budget.
    const said = await act({ call: { action: "chat", args: { message: "/kill 哈囉" } } });
    expect(said).toMatchObject({ status: "done", result: { text: "好" } });
    expect(exec.starts.at(-1)).toMatchObject({
      goal: "chat",
      args: { message: "kill 哈囉" },
      budget_s: 10,
    });
    exec.autoEnd = () => ({ type: "failed", code: "unreachable", detail: "找不到路" });
    const failed = await act({ call: { action: "goto", args: { x: 1 } } });
    expect(failed.status).toBe("failed");
    expect(failed.status === "failed" && failed.error).toBe("找不到路");
    expect(failed.status === "failed" && (failed.cause as { code?: string }).code).toBe(
      "unreachable",
    );
    expect(exec.starts.at(-1)?.budget_s).toBe(240);

    // Unknown goals never reach the executor.
    const unknown = await act({ call: { action: "fly", args: {} } });
    expect(unknown.status === "failed" && (unknown.cause as { code?: string }).code).toBe(
      "invalid",
    );

    // Cancel propagates: aborting a waiting call cancels its task.
    exec.autoEnd = () => null;
    const controller = new AbortController();
    const waiting = act({ call: { action: "goto", args: { x: 2 } } }, controller.signal);
    await new Promise((r) => setTimeout(r, 5));
    const id = exec.last().id;
    controller.abort(new Error("turn cancelled"));
    await waiting.catch(() => undefined);
    expect(exec.cancels).toContain(id);
    expect(exec.running.has(id)).toBe(false);
  });
});
