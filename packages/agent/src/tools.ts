// Built-in tools. The interface lives in `@miyoria/tools`.

import type { ModuleContext } from "@miyoria/kernel";
import type { Tool, ToolContext, ToolSpec } from "@miyoria/tools";
import { ActionSinkKey, isJsonObject, type JsonValue, newAction, textLane } from "@miyoria/types";
import { charCount } from "./util.js";

/** Longest emoji (or custom emoji reference such as `name:123`) `react` accepts. */
const MAX_EMOJI_LEN = 64;

export class ToolArgumentError extends Error {
  override readonly name = "ToolArgumentError";
}

/** Built-in `react`: adds an emoji reaction to the triggering message. */
export class ReactTool implements Tool {
  static readonly NAME = "react";

  readonly spec: ToolSpec = {
    name: ReactTool.NAME,
    description:
      "對觸發這次對話的那則訊息加上一個 emoji 反應。只想表達情緒、不需要多說話時可以只按反應然後輸出 <silence/>。",
    parameters: {
      type: "object",
      properties: {
        emoji: {
          type: "string",
          description: "一個 emoji,例如 👍、😤、🐋",
        },
      },
      required: ["emoji"],
    },
  };

  readonly #ctx: ModuleContext;

  constructor(ctx: ModuleContext) {
    this.#ctx = ctx;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const raw = isJsonObject(args) ? args.emoji : undefined;
    const emoji = typeof raw === "string" ? raw.trim() : "";
    if (emoji === "" || charCount(emoji) > MAX_EMOJI_LEN) {
      throw new ToolArgumentError("`emoji` must be a single emoji");
    }
    const sink = this.#ctx.services.require(ActionSinkKey);
    const action = newAction(
      textLane(ctx.context),
      ctx.priority,
      { type: "react", message: ctx.message, emoji },
      { turn: ctx.turn },
    );
    await sink.submit(action);
    return `reacted with ${emoji}`;
  }
}
