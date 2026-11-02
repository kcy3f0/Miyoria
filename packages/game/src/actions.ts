// Capabilities of the game director: `game.start`, `game.stop`, `game.goal` (commands and her
// tools) and `game.act` (the director's own adapter actions). All go through the gate, so game
// chat can never turn straight into an action.

import { type Capability, CapabilityError, defineCapability } from "@miyoria/actions";
import { withTimeout } from "@miyoria/kernel";
import type { ToolRegistry } from "@miyoria/tools";
import { actLane, type JsonValue, newId, type Principal } from "@miyoria/types";
import { z } from "zod";
import type { Placement } from "./director.js";
import type { GameControl } from "./module.js";

export const GAME_ACT = "game.act";

const GAME_LANE = actLane("game");

const StartArgs = z.object({
  game: z.string().trim().toLowerCase().min(1).nullish(),
  where: z.enum(["auto", "voice", "here", "stream"]).nullish(),
});
const GoalArgs = z.object({
  text: z.string().trim().min(1).max(200),
  /** Who set it (shown as `(X 指定的)`); defaults from the principal. */
  by: z.string().trim().min(1).max(64).nullish(),
});
const NoArgs = z.object({});
const ActArgs = z.object({
  game: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  call: z.record(z.string(), z.unknown()),
});
type StartArgs = z.output<typeof StartArgs>;
type GoalArgs = z.output<typeof GoalArgs>;
type ActArgs = z.output<typeof ActArgs>;

function byOf(principal: Principal, by: string | null | undefined): string {
  if (by) return by;
  return principal.kind === "self" ? "她自己" : principal.kind === "user" ? "聊天室" : "指令";
}

export interface GameCapabilityOptions {
  control: GameControl;
  defaultGame: string;
  /** Permission nodes of `start` / `stop` / `goal` (from `[modules.game] permissions`). */
  permissions: { start: string; stop: string; goal: string };
  toolTimeoutMs: number;
  tools: () => ToolRegistry | undefined;
}

export function gameCapabilities(o: GameCapabilityOptions): Capability[] {
  const start = defineCapability<StartArgs>({
    name: "game.start",
    summary: "開始玩遊戲",
    risk: "medium",
    args: StartArgs,
    permission: o.permissions.start,
    tool: {
      name: "game_start",
      description: `開始直播玩遊戲(導演迴路會自己決定目標與動作)。game 省略 = ${o.defaultGame}。`,
      properties: {
        game: { type: "string", description: `遊戲 id,例如 ${o.defaultGame}` },
        where: {
          type: "string",
          enum: ["auto", "voice", "here", "stream"],
          description: "實況送到哪裡,通常省略(auto)",
        },
      },
    },
    lane: () => GAME_LANE,
    async execute(args, ctx) {
      const here = ctx.principal.context;
      if (here === null) throw new CapabilityError("no context to play in");
      const account = ctx.principal.requester ?? { platform: here.platform, id: "self" };
      const placement: Placement = args.where ?? "auto";
      return o.control.start(args.game ?? o.defaultGame, here, account, placement);
    },
  });

  const stop = defineCapability<z.output<typeof NoArgs>>({
    name: "game.stop",
    summary: "停止玩遊戲",
    risk: "medium",
    args: NoArgs,
    permission: o.permissions.stop,
    tool: {
      name: "game_stop",
      description: "停止正在玩的遊戲。",
      properties: {},
    },
    lane: () => GAME_LANE,
    async execute() {
      return o.control.stop();
    },
  });

  const goal = defineCapability<GoalArgs>({
    name: "game.goal",
    summary: "指定遊戲目標",
    risk: "medium",
    args: GoalArgs,
    permission: o.permissions.goal,
    tool: {
      name: "game_goal",
      description: "指定你接下來在遊戲裡要做的事(例如「去挖鐵礦」)。只有在玩遊戲時有用。",
      properties: { text: { type: "string", description: "目標,一句話" } },
      required: ["text"],
    },
    lane: () => GAME_LANE,
    async execute(args, ctx) {
      return o.control.goal(args.text, byOf(ctx.principal, args.by));
    },
  });

  const act = defineCapability<ActArgs>({
    name: GAME_ACT,
    summary: "在遊戲裡做一個高階動作",
    risk: "low",
    args: ActArgs,
    permission: null,
    async execute(args, ctx) {
      const name = `game_${args.game}_act`;
      const tool = o.tools()?.get(name);
      if (!tool) throw new CapabilityError(`tool \`${name}\` is not registered`);
      const context = ctx.principal.context;
      if (context === null) throw new CapabilityError("no game context");
      const result = await withTimeout(
        tool.call(
          {
            turn: ctx.request.turn ?? newId(),
            context,
            account: ctx.principal.requester ?? { platform: context.platform, id: "game" },
            principal: ctx.principal,
            message: { context, id: "game" },
            priority: "initiative",
            signal: ctx.signal,
          },
          args.call as JsonValue,
        ),
        o.toolTimeoutMs,
      );
      if (result === undefined) throw new CapabilityError(`tool \`${name}\` timed out`);
      return result;
    },
  });

  return [start, stop, goal, act] as Capability[];
}
