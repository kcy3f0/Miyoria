// The Discord side of economy 2.0 (docs/design/v4-plan.md §10): `/me quests` and the rest. Same
// rules as commands.ts: neutral cards, a stranger gets the plain line, the answer to anything that
// moves coins is only for whoever pressed it, and every spend carries a fresh key.

import {
  type CardBlock,
  type CommandRegistry,
  type CommandReply,
  cardReply,
  commandSpec,
  type Invocation,
  notice,
} from "@miyoria/commands";
import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import { STRANGER, WALLET_NODE } from "./economy.js";
import { EconomyError } from "./types.js";
import { type Economy2, Economy2Key } from "./v2-types.js";

const log = getLogger("economy.commands.v2");

export const V2_PATHS = ["me quests"] as const;

const UNAVAILABLE = "錢包現在打不開";

class Handler2 {
  constructor(readonly services: ServiceLookup) {}

  /** An answer: refusals are plain information, not errors. */
  async guard(run: (e: Economy2) => Promise<CommandReply>): Promise<CommandReply> {
    const e = this.services.get(Economy2Key);
    if (!e) return notice("warn", UNAVAILABLE);
    try {
      return await run(e);
    } catch (error) {
      if (error instanceof EconomyError) {
        return error.status === 503 ? notice("warn", error.message) : notice("info", error.message);
      }
      log.warn({ error: errorMessage(error) }, "an economy 2.0 command failed");
      return notice("warn", UNAVAILABLE);
    }
  }

  quests(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const view = await e.quests(inv.invoker);
      if (view.quests.length === 0) return notice("info", STRANGER);
      const lines = view.quests.map((q) => `${q.done ? "✅" : "⬜"} ${q.label}`);
      const blocks: CardBlock[] = [
        { type: "text", text: lines.join("\n") },
        {
          type: "muted",
          text: `每個 ${view.reward}，三個都完成再加 ${view.bonus}${view.bonus_done ? "（已拿到）" : ""}；今天任務賺了 ${view.earned_today} / ${view.cap}。「聊一件新的事」由她判斷。`,
        },
      ];
      return cardReply(blocks, { accent: "neutral", title: "今天的任務" });
    });
  }
}

export function unregisterV2(registry: CommandRegistry): void {
  for (const path of V2_PATHS) registry.unregister(path);
}

export function registerV2(registry: CommandRegistry, services: ServiceLookup): void {
  const handler = new Handler2(services);
  registry.register(
    commandSpec("me quests", "今天的三個小任務：聊新的事、玩遊戲、聽完一首歌", {
      permission: WALLET_NODE,
    }),
    (inv) => handler.quests(inv),
  );
}
