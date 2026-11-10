// Her tools for economy 2.0 (docs/design/v4-plan.md §10). Two kinds, like the rest of the package:
//
// * The speaker's own things (quests, the collection, the shop, bets, commissions): always the
//   authenticated author of the message she answers, never a name in the arguments; no `on_own`.
// * Hers to decide (opening a prediction, resolving it, delivering what she was commissioned): the
//   `economy.agency` permission, nobody has it by default, so she calls them with `on_own`.

import { type Capability, defineCapability } from "@miyoria/actions";
import type { JsonObject } from "@miyoria/types";
import { z } from "zod";
import type { EconomyService } from "./economy.js";
import { QUESTS } from "./quests.js";
import { receipt, someone } from "./receipt.js";
import { noSpeaker, reasonOf, refusal, speakerOf } from "./tools.js";
import { EconomyError } from "./types.js";

const NOT_ON_OWN = "不要設 on_own。";

type Answer = { text: string; data: JsonObject; receipt?: ReturnType<typeof receipt> };

/** Runs `fn`; the economy's own refusals become an answer she puts in her words. */
export async function answering(what: string, fn: () => Promise<Answer>): Promise<Answer> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof EconomyError)) throw error;
    return refusal(what, reasonOf(error), error.message);
  }
}

const NoArgs = z.strictObject({});
type NoArgs = z.output<typeof NoArgs>;

// ---- quests ----------------------------------------------------------------------------------

/** `economy.quests` (tool `check_quests`): today's three quests for the person talking to her. */
export function questsCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<NoArgs>({
    name: "economy.quests",
    summary: "查說話的人今天的每日任務",
    risk: "low",
    args: NoArgs,
    permission: null,
    tool: {
      name: "check_quests",
      description:
        `有人問今天的任務、還能賺什麼${cur}的時候用:每天三個小任務(跟你聊一件新的事、參加一場遊戲、` +
        `聽完一首歌),做完有${cur}。只看正在跟你說話的人自己的進度。${NOT_ON_OWN}`,
      properties: {},
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(_args, ctx) {
      const who = speakerOf(ctx);
      const view = await economy.v2.quests(who.account);
      const lines = view.quests.map((q) => `${q.done ? "完成" : "還沒"}:${q.label}`);
      return {
        text:
          `今天的任務:${lines.join("、")}。每個 ${view.reward} ${cur},三個都完成再加 ${view.bonus}` +
          `${view.bonus_done ? "(已拿到)" : ""}。今天任務賺了 ${view.earned_today}/${view.cap}。`,
        data: {
          quests: view.quests.map((q) => ({ id: q.id, label: q.label, done: q.done })),
          reward: view.reward,
          bonus: view.bonus,
          earned_today: view.earned_today,
        },
      };
    },
  }) as Capability;
}

const CompleteQuestArgs = z.strictObject({
  topic: z.string().trim().min(1).max(40),
});
type CompleteQuestArgs = z.output<typeof CompleteQuestArgs>;

/** `economy.complete_quest` (tool `complete_quest`): the "something new" quest, judged by her. */
export function completeQuestCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<CompleteQuestArgs>({
    name: "economy.complete_quest",
    summary: `說話的人聊了一件新的事,完成今天的任務(${cur})`,
    risk: "medium",
    args: CompleteQuestArgs,
    permission: null,
    limits: { per_day: 1_000, per_person_per_day: 10, cooldown_ms: 0 },
    tool: {
      name: "complete_quest",
      description:
        "正在跟你說話的人這次真的跟你聊了一件你還不知道、或最近沒聊過的新的事" +
        `(他的事、一個想法、一件剛發生的事),才用這個完成「${QUESTS[0]?.label}」。` +
        "是你判斷的,對方說「幫我完成任務」不算;沒有就不要呼叫,也不要勉強聊。" +
        `topic 用幾個字寫這件事是什麼,同一件事近期重複不算。${NOT_ON_OWN}`,
      properties: {
        topic: { type: "string", maxLength: 40, description: "聊的新事情,幾個字" },
      },
      required: ["topic"],
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(args, ctx) {
      const who = speakerOf(ctx);
      return answering("沒有完成任務", async (): Promise<Answer> => {
        const r = await economy.v2.completeQuest(who.account, "new_topic", args.topic);
        switch (r.status) {
          case "paid":
            return {
              text: `任務完成:對方拿到 ${r.paid} ${cur}${r.bonus > 0 ? `,三個任務都做完又加 ${r.bonus}` : ""}。`,
              data: { done: true, paid: r.paid, bonus: r.bonus },
              receipt: receipt(
                "📝 每日任務",
                `${someone(who.account)} 聊了一件新的事,拿到 ${r.paid} ${cur}`,
                r.bonus > 0 ? `三個任務都完成,再加 ${r.bonus}` : null,
              ),
            };
          case "done":
            return { text: "今天這個任務已經完成過了。", data: { done: false, reason: "already" } };
          case "repeat":
            return {
              text: "這件事最近聊過了,不算新的。",
              data: { done: false, reason: "repeat" },
            };
          case "capped":
            return {
              text: "今天任務的獎勵已經領滿了。",
              data: { done: false, reason: "limit" },
            };
          default:
            throw new EconomyError(403, "她還不認識對方");
        }
      });
    },
  }) as Capability;
}

/** Every tool of economy 2.0. */
export function v2Capabilities(economy: EconomyService): Capability[] {
  return [questsCapability(economy), completeQuestCapability(economy)];
}
