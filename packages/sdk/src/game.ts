// Game adapter interface (docs/ARCHITECTURE.md §12.3) and its mapping onto
// tools and events: `game.<id>.observe`, `game.<id>.act`, events
// `game.<id>.<type>`, plus a prompt section from `describe().prompt`.
//
// The `game.<id>.*` namespace belongs to the extension whose manifest has
// kind `game-adapter` and `game = "<id>"`; the host refuses game topics and
// tools from anyone else (docs/protocols/extension-rpc.md, "Game adapters").
//
// The two tools are raw adapter controls (launch, quit, game chat): the host
// keeps them out of the chat turns' tool list and only the game director's
// capabilities (behind the gate) call them.

import type { ExtensionContext } from "./extension.js";
import { isValidTopic } from "./topics.js";
import type { JsonSchema } from "./types.js";

export interface GameActionSpec {
  /** e.g. `"goto"`, `"mine"`, `"chat"`. */
  name: string;
  description: string;
  /** JSON Schema of the action arguments. */
  parameters?: JsonSchema;
}

export interface GameInfo {
  /** Short id used in tool and topic names: `[a-z0-9_-]+`, e.g. `"minecraft"`. */
  id: string;
  /** Display name, e.g. `"Minecraft"`. */
  name: string;
  actions: GameActionSpec[];
  /** Prompt fragment added while the adapter is registered. */
  prompt?: string;
  /**
   * How to play (progression, rules of thumb), appended to the act tool's description so the
   * game's decision loop sees it; chat turns that do not get the tool do not pay for it.
   */
  guide?: string;
}

export interface GameObservation {
  /** Structured state (health, position, inventory, ...). */
  state: Record<string, unknown>;
  /** Short text summary for the model. */
  summary: string;
  /** Optional screenshot for multimodal models (not sent through tools yet). */
  screenshot?: { mime: string; data: string };
}

export interface GameAction {
  name: string;
  args?: Record<string, unknown>;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}

export interface GameEvent {
  /** Topic suffix, e.g. `"death"`, `"chat"`, `"player.joined"`. */
  type: string;
  data?: unknown;
  /** Worth live commentary. */
  important?: boolean;
}

export interface GameAdapter {
  describe(): GameInfo;
  /** `signal`: aborted when the host stops waiting (see `ToolCallContext.signal`). */
  observe(signal?: AbortSignal): Promise<GameObservation>;
  /**
   * `signal`: aborted when the host stops waiting (the director's step timed out); stop the
   * action rather than finish it late.
   */
  act(action: GameAction, signal?: AbortSignal): Promise<ActionResult>;
  events(): AsyncIterable<GameEvent>;
}

/** Handle returned by `ctx.game.registerAdapter`. */
export interface RegisteredAdapter {
  info: GameInfo;
  /** Resolves when the adapter's event stream ends. */
  done: Promise<void>;
}

const GAME_ID = /^[a-z0-9_-]{1,32}$/;

/** JSON Schema of the `game.<id>.act` tool arguments. */
export function actToolSchema(info: GameInfo): JsonSchema {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: info.actions.map((a) => a.name) },
      args: { type: "object", description: "動作參數,依動作而定" },
    },
    required: ["action"],
  };
}

/** Description of the `game.<id>.act` tool: the actions, then the adapter's guide if any. */
export function describeActions(info: GameInfo): string {
  const lines = info.actions.map((a) => {
    const params = a.parameters ? ` 參數:${JSON.stringify(a.parameters)}` : "";
    return `- ${a.name}:${a.description}${params}`;
  });
  const guide = info.guide?.trim() ? `\n\n${info.guide.trim()}` : "";
  return `在 ${info.name} 裡做一個高階動作。可用動作:\n${lines.join("\n")}${guide}`;
}

/** Text the model sees for an observation. */
export function formatObservation(obs: GameObservation): string {
  return `${obs.summary}\n\n狀態:${JSON.stringify(obs.state)}`;
}

/** Text the model sees for an action result. */
export function formatActionResult(result: ActionResult): string {
  const head = result.ok ? "成功" : "失敗";
  const message = result.message ? `:${result.message}` : "";
  const data = result.data === undefined ? "" : `\n${JSON.stringify(result.data)}`;
  return `${head}${message}${data}`;
}

/** Implementation of `ctx.game.registerAdapter`. */
export async function registerGameAdapter(
  ctx: ExtensionContext,
  adapter: GameAdapter,
): Promise<RegisteredAdapter> {
  const info = adapter.describe();
  if (!GAME_ID.test(info.id)) throw new Error(`invalid game id "${info.id}"`);
  if (ctx.game.id !== info.id) {
    throw new Error(
      ctx.game.id === undefined
        ? `game adapter "${info.id}" needs kind = ["game-adapter", ...] and game = "${info.id}" in miyoria.extension.toml`
        : `game adapter id "${info.id}" does not match the manifest game "${ctx.game.id}"`,
    );
  }
  const base = `game.${info.id}`;

  await ctx.tools.register({
    name: `${base}.observe`,
    description: `查看 ${info.name} 現在的狀態`,
    parameters: { type: "object", properties: {} },
    run: async (_args, call) => formatObservation(await adapter.observe(call.signal)),
  });
  await ctx.tools.register({
    name: `${base}.act`,
    description: describeActions(info),
    parameters: actToolSchema(info),
    run: async (args, call) => {
      const action: GameAction = {
        name: String(args.action),
        args: (args.args as Record<string, unknown> | undefined) ?? {},
      };
      if (!info.actions.some((a) => a.name === action.name)) {
        return formatActionResult({ ok: false, message: `沒有「${action.name}」這個動作` });
      }
      return formatActionResult(await adapter.act(action, call.signal));
    },
  });
  if (info.prompt) {
    const prompt = info.prompt;
    await ctx.prompt.register(base, () => [{ title: info.name, body: prompt, order: 50 }]);
  }

  const done = (async () => {
    for await (const event of adapter.events()) {
      const topic = `${base}.${event.type}`;
      if (!isValidTopic(topic)) {
        ctx.log.warn("game event with an invalid type skipped", { type: event.type });
        continue;
      }
      try {
        await ctx.events.publish(topic, event);
      } catch (error) {
        ctx.log.warn("publishing a game event failed", { topic, error: String(error) });
      }
    }
  })().catch((error: unknown) => {
    ctx.log.error("game event stream failed", { game: info.id, error: String(error) });
  });
  return { info, done };
}
