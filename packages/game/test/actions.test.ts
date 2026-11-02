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
    tools: () => undefined,
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
  return { calls, tools, registry, ctx };
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
    expect(out.status === "failed" && out.error).toContain("game_minecraft_act");
  });
});
