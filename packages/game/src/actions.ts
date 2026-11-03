// Capabilities of the game director: `game.start`, `game.stop`, `game.goal` (commands and her
// tools) and `game.act` (the director's own adapter actions, and her in-game chat lines). All go
// through the gate, so game chat can never turn straight into an action.
//
// `game.start` is the whole "go play" flow: it checks that the game is running (starts it with
// the adapter's `launch` action when the adapter can, and refuses with the reason so she can tell
// the owner when that fails), starts the session (the stage's scene director then
// switches OBS to the game scene), sets a first goal when given one and, when asked to, also goes
// live with `stream.start` (its own gate decision, for the same principal).
//
// With the ActivityManager (module `activity`) `game.start` / `game.stop` are its `start` / `stop`
// transitions: one start at a time (no second preflight, no "已經在玩" race between the panel and
// a turn), her tool answers at once ("開始了,task 7") instead of holding the `act:game` lane for
// the whole launch, a stop cancels a launch in progress, and `stream: true` is an `ensure_live`
// of its own.
//
// `game.act` starts one task on the game's executor (v2 §3.8: the adapter's `TaskExecutor`,
// found in `TaskExecutorsKey`): the director passes the task id and budget and returns once it is
// accepted (its end arrives as `game.<id>.task.done|failed`); other callers (game chat, the
// launch) wait for the end. Either way the outcome carries a failure code (`GameTaskError`),
// never a "失敗" prefix to look for. There are no raw adapter tools any more.

import {
  type ActuatorRegistry,
  type Capability,
  CapabilityError,
  defineCapability,
  deniedText,
} from "@miyoria/actions";
import {
  ActivityManagerKey,
  type ActivityRequest,
  actLane,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  MAX_TASK_BUDGET_S,
  newId,
  type Principal,
  type TaskSpec,
} from "@miyoria/types";
import { z } from "zod";
import { GAME_CHAT_MAX, sanitizeGameChat } from "./chat-text.js";
import type { Placement } from "./director.js";
import type { GameControl } from "./module.js";
import { budgetFor, codeOf, GameTaskError, gameExecutor, offersGoal, runTask } from "./tasks.js";

export const GAME_ACT = "game.act";

const GAME_LANE = actLane("game");

const StartArgs = z.object({
  game: z.string().trim().toLowerCase().min(1).nullish(),
  where: z.enum(["auto", "voice", "here", "stream"]).nullish(),
  /** First goal (a sentence). */
  goal: z.string().trim().min(1).max(200).nullish(),
  /** Also go live (Discord Go Live, OBS follows). */
  stream: z.boolean().nullish(),
});
const GoalArgs = z.object({
  text: z.string().trim().min(1).max(200),
  /** Who set it (shown as `(X 指定的)`); defaults from the principal. */
  by: z.string().trim().min(1).max(64).nullish(),
});
const NoArgs = z.object({});
const ActArgs = z.object({
  game: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  /** `{action, args}`: the goal and its arguments. */
  call: z.record(z.string(), z.unknown()),
  /** The task id and budget (the director picks them); missing: a new id, the goal's budget. */
  task: z
    .object({
      id: z.string().min(1).max(64),
      budget_s: z.number().positive().max(MAX_TASK_BUDGET_S),
    })
    .nullish(),
  /**
   * `false`: return once the executor accepted the task (the director; the end comes as task
   * events). Default: wait for the end and answer with it.
   */
  wait: z.boolean().nullish(),
});
type StartArgs = z.output<typeof StartArgs>;
type GoalArgs = z.output<typeof GoalArgs>;
type ActArgs = z.output<typeof ActArgs>;

function byOf(principal: Principal, by: string | null | undefined): string {
  if (by) return by;
  return principal.kind === "self" ? "她自己" : principal.kind === "user" ? "聊天室" : "指令";
}

/**
 * The act call with its chat line made safe: one short line that never starts with a command
 * character. Other actions are passed on as they are.
 */
export function safeActCall(call: Record<string, unknown>): Record<string, unknown> {
  if (call.action !== "chat") return call;
  const args = isJsonObject(call.args as JsonValue) ? (call.args as Record<string, unknown>) : {};
  const raw = typeof args.message === "string" ? args.message : "";
  const message = sanitizeGameChat(raw, GAME_CHAT_MAX);
  if (message === "") throw new CapabilityError("nothing left to say in game chat after filtering");
  return { ...call, args: { ...args, message } };
}

export interface GameCapabilityOptions {
  control: GameControl;
  defaultGame: string;
  /** Permission nodes of `start` / `stop` / `goal` (from `[modules.game] permissions`). */
  permissions: { start: string; stop: string; goal: string };
  /** One control call to the executor (`task.start` acceptance), `tool_timeout_secs`. */
  toolTimeoutMs: number;
  /** Budget of a task whose goal suggests none (`task_budget_secs`) and the cap (`max_goal_secs`). */
  taskBudgetSecs?: number;
  maxBudgetSecs?: number;
  /** For `game.start {stream: true}` (goes live through the gate). */
  actuators?: ActuatorRegistry | null;
  /** She is streaming (Go Live or OBS) right now. */
  live?: () => boolean;
}

/** The guild to go live in for `principal`: her voice channel's, else where she was asked. */
function liveGuild(o: GameCapabilityOptions, principal: Principal): string | null {
  const here = principal.context;
  const voice = o.control.voiceContext(here?.platform ?? null) ?? o.control.voiceContext();
  return voice?.scope ?? (here?.kind !== "dm" ? (here?.scope ?? null) : null);
}

/** `stream.start` for the same principal, in the guild of her voice channel. */
async function goLive(
  o: GameCapabilityOptions,
  principal: Principal,
  turn: string | null,
  signal: AbortSignal,
): Promise<string> {
  if (!o.actuators) return "沒辦法開台(行動閘門沒有啟用)。";
  const guild = liveGuild(o, principal);
  if (guild === null) return "沒有開台:不知道要在哪個伺服器開。";
  const outcome = await o.actuators.invoke(
    {
      principal,
      capability: "stream.start",
      args: { guild },
      why: "開始玩遊戲,順便開台",
      turn,
    },
    { signal },
  );
  switch (outcome.status) {
    case "done":
      return "也開台了。";
    case "denied":
      return `沒有開台:${deniedText(outcome.decision.stage)}(${outcome.decision.reason})`;
    case "failed":
      return `開台失敗:${outcome.error}`;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      description:
        `開始玩遊戲(例如 Minecraft;導演迴路會自己決定目標與動作,直播畫面會切到遊戲場景)。只有被要求玩遊戲時才用;只是要開直播 / 開台請用 stream_start,不要用這個。game 省略 = ${o.defaultGame}。` +
        "遊戲沒開時會自己開(要等一兩分鐘);開不起來會失敗並說原因,那就跟大家說、請擁有者看一下。goal 可以給第一個目標;stream = true 會順便開台(Go Live)。",
      properties: {
        game: { type: "string", description: `遊戲 id,例如 ${o.defaultGame}` },
        where: {
          type: "string",
          enum: ["auto", "voice", "here", "stream"],
          description: "實況送到哪裡,通常省略(auto)",
        },
        goal: { type: "string", description: "第一個目標,一句話(可省略)" },
        stream: { type: "boolean", description: "也開台(你想讓大家看你玩的時候)" },
      },
    },
    lane: () => GAME_LANE,
    activity(args, principal) {
      if (principal.context === null) return null;
      const out: ActivityRequest[] = [
        {
          type: "start",
          activity: "game",
          target: args.game ?? o.defaultGame,
          goal: args.goal ?? null,
        },
      ];
      const guild = args.stream === true ? liveGuild(o, principal) : null;
      if (guild !== null) {
        const platform = principal.context.platform;
        out.push({ type: "ensure_live", platform, guild, source: null });
      }
      return out;
    },
    async execute(args, ctx) {
      const here = ctx.principal.context;
      if (here === null) throw new CapabilityError("no context to play in");
      const account = ctx.principal.requester ?? { platform: here.platform, id: "self" };
      const placement: Placement = args.where ?? "auto";
      // Run by the ActivityManager, its task id is the launch task's id too (one id end to end).
      let text = await o.control.start(
        args.game ?? o.defaultGame,
        here,
        account,
        placement,
        ctx.signal,
        ctx.task ?? null,
      );
      if (args.goal) text += await o.control.goal(args.goal, byOf(ctx.principal, null));
      // Run by the ActivityManager, going live is a transition of its own (`ensure_live`).
      if (ctx.task) return text;
      if (args.stream === true) {
        text += await goLive(o, ctx.principal, ctx.request.turn, ctx.signal);
      } else if (o.live && !o.live()) {
        text += "(現在沒有在直播;想讓大家看的話可以開台。)";
      }
      return text;
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
    activity: () => [{ type: "stop", activity: "game" }],
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
      const by = byOf(ctx.principal, args.by);
      // The game is still starting (her `game_start` answered at once): the goal waits for it.
      const activity = ctx.services.get(ActivityManagerKey)?.snapshot().activity;
      if (activity?.type === "game" && activity.phase === "starting") {
        return o.control.pendingGoal(args.text, by);
      }
      return o.control.goal(args.text, by);
    },
  });

  const act = defineCapability<ActArgs>({
    name: GAME_ACT,
    summary: "在遊戲裡做一個高階動作",
    risk: "low",
    args: ActArgs,
    permission: null,
    async execute(args, ctx) {
      const executor = gameExecutor(ctx.services, args.game);
      if (!executor) {
        throw new GameTaskError(
          "precondition",
          `${args.game} 的遊戲 adapter 沒有在執行(沒有任務執行器)`,
        );
      }
      const call = safeActCall(args.call);
      const goal = typeof call.action === "string" ? call.action : "";
      if (!offersGoal(executor.info, goal)) {
        throw new GameTaskError("invalid", `沒有「${goal}」這個動作`);
      }
      const goalArgs = isJsonObject(call.args as JsonValue) ? (call.args as JsonObject) : {};
      const spec: TaskSpec = {
        id: args.task?.id ?? newId(),
        goal,
        args: goalArgs,
        budget_s:
          args.task?.budget_s ??
          budgetFor(executor.info, goal, o.taskBudgetSecs ?? 240, o.maxBudgetSecs ?? 600),
      };
      if (args.wait === false) {
        // Accepted is all the caller waits for; giving up aborts the start (and cancels it).
        const deadline = AbortSignal.timeout(Math.max(o.toolTimeoutMs, 1));
        try {
          await executor.start(spec, AbortSignal.any([ctx.signal, deadline]));
        } catch (error) {
          const code = deadline.aborted && !ctx.signal.aborted ? "timeout" : codeOf(error);
          throw new GameTaskError(code, `沒辦法開始 ${goal}:${errorText(error)}`, { cause: error });
        }
        return { text: `開始了(task ${spec.id})`, data: { task: spec.id } };
      }
      const end = await runTask(executor, spec, ctx.signal);
      if (end.type === "failed") throw new GameTaskError(end.code, end.detail);
      return { text: end.detail === "" ? "好了" : end.detail, data: { task: spec.id } };
    },
  });

  return [start, stop, goal, act] as Capability[];
}
