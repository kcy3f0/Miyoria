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
import { messageKey, noSpeaker, reasonOf, refusal, speakerOf } from "./tools.js";
import { EconomyError } from "./types.js";
import type { PredictionView } from "./v2-types.js";

const NOT_ON_OWN = "不要設 on_own。";
const AGENCY = "economy.agency";
const OWN = "這是你自己的決定:用 on_own: true 呼叫。";

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

// ---- collection and achievements -------------------------------------------------------------

const RARITY_WORD: Record<string, string> = { N: "N", R: "R", SR: "SR", SSR: "SSR" };

/** `economy.collection` (tool `check_collection`): the speaker's album, the odds, their titles. */
export function collectionCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<NoArgs>({
    name: "economy.collection",
    summary: "查說話的人的收藏冊、抽收藏的機率和稱號",
    risk: "low",
    args: NoArgs,
    permission: null,
    tool: {
      name: "check_collection",
      description:
        `有人問他集到了什麼、收藏冊、稀有度和機率、抽收藏要多少${cur}、有什麼稱號和成就的時候用這個,` +
        "不要自己猜。只看正在跟你說話的人自己的。稀有度只是一個標籤,不代表你比較喜歡他。" +
        NOT_ON_OWN,
      properties: {},
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(_args, ctx) {
      const who = speakerOf(ctx);
      const [album, achieved] = await Promise.all([
        economy.v2.album(who.account),
        economy.v2.achievements(who.account),
      ]);
      const series = album.series.map(
        (s) => `${s.label} ${s.owned_distinct}/${s.total}${s.complete ? "(集齊)" : ""}`,
      );
      const odds = album.odds.map((o) => `${RARITY_WORD[o.rarity]} ${o.percent}%`).join("、");
      const titles = achieved.titles.length === 0 ? "還沒有" : achieved.titles.join("、");
      return {
        text:
          `收藏冊:${series.join("、")}。抽一次 ${album.price} ${cur},今天抽了 ${album.draws_today}/${album.draws_per_day}。` +
          `機率:${odds}${album.pity > 0 ? `;連續 ${album.pity} 次沒有 SR 以上就一定出 SR(已經 ${album.since_best} 次)` : ""}。` +
          `稱號:${titles}。`,
        data: {
          series: album.series.map((s) => ({
            id: s.id,
            owned: s.owned_distinct,
            total: s.total,
            complete: s.complete,
          })),
          odds: album.odds.map((o) => ({ rarity: o.rarity, percent: o.percent })),
          price: album.price,
          titles: achieved.titles,
        },
      };
    },
  }) as Capability;
}

/** `economy.draw` (tool `draw_collectible`): a draw for the speaker, in text only. */
export function drawCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<NoArgs>({
    name: "economy.draw",
    summary: `幫說話的人抽一次收藏(${economy.config.draw_price} ${cur})`,
    risk: "medium",
    args: NoArgs,
    permission: null,
    limits: { per_day: 1_000, per_person_per_day: 20, cooldown_ms: 0 },
    tool: {
      name: "draw_collectible",
      description:
        `對方明確要抽一次收藏(花 ${economy.config.draw_price} ${cur})的時候用。只有文字頻道裡對方本人說了才用,` +
        "不要自己提議、不要勸他抽。結果是機率決定的,稀有度不代表你比較喜歡他。" +
        NOT_ON_OWN,
      properties: {},
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(_args, ctx) {
      const who = speakerOf(ctx);
      if (who.voice) {
        return refusal(
          "沒有抽",
          "unconfirmed",
          "語音裡可能聽錯,不能直接花錢;請對方在文字頻道用 /me draw",
        );
      }
      return answering("沒有抽成", async (): Promise<Answer> => {
        const r = await economy.v2.draw(
          who.account,
          messageKey(who.message.context, who.message.id),
        );
        const line = `${r.item.series}「${r.item.label}」(${r.item.rarity})${r.new ? ",新的一個" : ",重複的"}`;
        return {
          text: `抽到了${line},花 ${r.charged} ${cur},現在有 ${r.balance}。`,
          data: {
            done: true,
            item: r.item.label,
            rarity: r.item.rarity,
            new: r.new,
            charged: r.charged,
            balance: r.balance,
          },
          receipt: receipt(
            "🎴 抽收藏",
            `${someone(who.account)} 抽到了 ${line}`,
            `−${r.charged} ${cur} · 現在有 ${r.balance}`,
          ),
        };
      });
    },
  }) as Capability;
}

// ---- predictions -----------------------------------------------------------------------------

/** One prediction as a line she can read out. */
function predictionLine(p: PredictionView, cur: string): string {
  const options = p.options
    .map((o, i) => `${i + 1}. ${o.label}(${o.staked} ${cur},${o.backers} 人)`)
    .join("、");
  const state =
    p.status === "open"
      ? "還在收"
      : p.status === "closed"
        ? "已截止,還沒公布結果"
        : p.status === "resolved"
          ? `結果:${p.winner}`
          : "取消了";
  const mine = p.my_bet
    ? `;他押了 ${p.my_bet.amount} 在「${p.my_bet.option}」${
        p.my_bet.outcome === "open"
          ? ""
          : `(${{ won: "猜中", lost: "沒猜中", refunded: "已退回" }[p.my_bet.outcome]})`
      }`
    : "";
  return `[${p.id}]「${p.question}」${state}:${options}${mine}`;
}

/** `economy.predictions` (tool `check_predictions`): what is open to stake on. */
export function predictionsCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<NoArgs>({
    name: "economy.predictions",
    summary: "查現在能押的預測",
    risk: "low",
    args: NoArgs,
    permission: null,
    tool: {
      name: "check_predictions",
      description:
        `有人問現在有什麼預測、能押什麼的時候用。預測是押${cur}猜一件事的結果,猜中的人平分大家押的,` +
        `不是你給的獎勵。只會顯示正在跟你說話的人自己押了什麼。${NOT_ON_OWN}`,
      properties: {},
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(_args, ctx) {
      const who = speakerOf(ctx);
      const list = await economy.v2.predictions(who.account);
      if (list.length === 0) return { text: "現在沒有預測。", data: { predictions: [] } };
      return {
        text: list.map((p) => predictionLine(p, cur)).join("\n"),
        data: {
          predictions: list.map((p) => ({
            id: p.id,
            question: p.question,
            status: p.status,
            options: p.options.map((o) => o.label),
          })),
        },
      };
    },
  }) as Capability;
}

const BetArgs = z.strictObject({
  prediction: z.string().trim().min(1).max(32),
  option: z.string().trim().min(1).max(24),
  amount: z.number().int().min(1).max(1_000),
});
type BetArgs = z.output<typeof BetArgs>;

/** `economy.place_bet` (tool `place_bet`): a stake for the speaker, in text only. */
export function placeBetCapability(economy: EconomyService): Capability {
  const c = economy.config;
  const cur = c.currency;
  return defineCapability<BetArgs>({
    name: "economy.place_bet",
    summary: `幫說話的人在預測上押${cur}`,
    risk: "medium",
    args: BetArgs,
    permission: null,
    limits: { per_day: 1_000, per_person_per_day: 20, cooldown_ms: 0 },
    tool: {
      name: "place_bet",
      description:
        `對方明確說要押某個預測的某個選項、押多少${cur}時用(每個預測一人一注,最多 ${c.bet_max},` +
        "一天最多 " +
        `${c.bet_daily_max})。只有文字頻道裡對方本人說了才用,不要勸他押、不要幫他選。` +
        `prediction 是預測的代號,option 是選項的號碼(1 開始)或名字。${NOT_ON_OWN}`,
      properties: {
        prediction: { type: "string", description: "預測的代號(check_predictions 給的)" },
        option: { type: "string", description: "選項的號碼或名字" },
        amount: { type: "integer", minimum: 1, description: `押多少${cur}` },
      },
      required: ["prediction", "option", "amount"],
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(args, ctx) {
      const who = speakerOf(ctx);
      if (who.voice) {
        return refusal(
          "沒有押",
          "unconfirmed",
          "語音裡可能聽錯,不能直接花錢;請對方在文字頻道用 /me bet",
        );
      }
      return answering("沒有押成", async (): Promise<Answer> => {
        const r = await economy.v2.placeBet(
          who.account,
          args.prediction,
          args.option,
          args.amount,
          messageKey(who.message.context, who.message.id),
        );
        return {
          text: `押好了:「${r.question}」押「${r.option}」${r.amount} ${cur},現在有 ${r.balance}。`,
          data: { done: true, option: r.option, amount: r.amount, balance: r.balance },
          receipt: receipt(
            "🎯 預測",
            `${someone(who.account)} 押了「${r.option}」`,
            `「${r.question}」· −${r.amount} ${cur} · 現在有 ${r.balance}`,
          ),
        };
      });
    },
  }) as Capability;
}

const OpenArgs = z.strictObject({
  question: z.string().trim().min(1).max(80),
  options: z.array(z.string().trim().min(1).max(24)).min(2).max(4),
  minutes: z.number().int().min(1),
});
type OpenArgs = z.output<typeof OpenArgs>;

/** `economy.open_prediction` (tool `open_prediction`): hers to decide, behind `economy.agency`. */
export function openPredictionCapability(economy: EconomyService): Capability {
  const c = economy.config;
  const cur = c.currency;
  return defineCapability<OpenArgs>({
    name: "economy.open_prediction",
    summary: `開一個大家押${cur}猜結果的預測`,
    risk: "medium",
    args: OpenArgs,
    permission: AGENCY,
    limits: { per_day: 10, per_person_per_day: 10, cooldown_ms: 0 },
    tool: {
      name: "open_prediction",
      description:
        `開一個預測讓大家押${cur}猜:你這場遊戲會怎麼樣、一件之後一定看得出結果的事。` +
        `猜中的人平分大家押的${cur}(不是你出錢),沒人猜中就全部退回。題目最多 80 字,` +
        `2 到 4 個選項、每個最多 24 字,截止最久 ${c.prediction_max_minutes} 分鐘,` +
        `同時最多 ${c.predictions_open} 個。結果要由你公布(resolve_prediction),要是公布不了,` +
        `超過一天沒人公布會自動取消退回。${OWN}`,
      properties: {
        question: { type: "string", maxLength: 80, description: "要猜什麼" },
        options: {
          type: "array",
          items: { type: "string", maxLength: 24 },
          minItems: 2,
          maxItems: 4,
          description: "選項",
        },
        minutes: {
          type: "integer",
          minimum: 1,
          maximum: c.prediction_max_minutes,
          description: "幾分鐘後截止",
        },
      },
      required: ["question", "options", "minutes"],
    },
    async execute(args) {
      return answering("沒有開成", async (): Promise<Answer> => {
        const p = await economy.v2.openPrediction(args);
        return {
          text: `開好了:[${p.id}]「${p.question}」,選項 ${p.options.map((o) => o.label).join("、")},${args.minutes} 分鐘後截止。`,
          data: { done: true, id: p.id },
        };
      });
    },
  }) as Capability;
}

const ResolveArgs = z.strictObject({
  prediction: z.string().trim().min(1).max(32),
  option: z.string().trim().min(1).max(24),
});
type ResolveArgs = z.output<typeof ResolveArgs>;

/** `economy.resolve_prediction` (tool `resolve_prediction`): she calls the result. */
export function resolvePredictionCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<ResolveArgs>({
    name: "economy.resolve_prediction",
    summary: "公布預測的結果,猜中的人平分",
    risk: "medium",
    args: ResolveArgs,
    permission: AGENCY,
    limits: { per_day: 30, per_person_per_day: 30, cooldown_ms: 0 },
    tool: {
      name: "resolve_prediction",
      description:
        `預測的結果已經看得出來時公布:option 是贏的選項的號碼或名字。猜中的人平分大家押的${cur},` +
        `沒人猜中全部退回。要誠實:這是結果,不是你想讓誰贏。${OWN}`,
      properties: {
        prediction: { type: "string", description: "預測的代號" },
        option: { type: "string", description: "贏的選項的號碼或名字" },
      },
      required: ["prediction", "option"],
    },
    async execute(args) {
      return answering("沒有公布", async (): Promise<Answer> => {
        const r = await economy.v2.resolvePrediction(args.prediction, args.option);
        const text = r.refunded
          ? `沒有人猜中,${r.pool} ${cur}全部退回了。`
          : `公布了:「${r.winner}」,${r.winners} 個人猜中,分走 ${r.pool} ${cur}。`;
        return {
          text,
          data: { done: true, winner: r.winner, winners: r.winners, pool: r.pool },
          receipt: receipt(
            "🎯 預測結果",
            r.refunded ? "沒有人猜中,押的都退回了" : `結果:「${r.winner}」,${r.winners} 個人猜中`,
            `${r.pool} ${cur}`,
          ),
        };
      });
    },
  }) as Capability;
}

const CancelArgs = z.strictObject({ prediction: z.string().trim().min(1).max(32) });
type CancelArgs = z.output<typeof CancelArgs>;

/** `economy.cancel_prediction` (tool `cancel_prediction`): she calls one off. */
export function cancelPredictionCapability(economy: EconomyService): Capability {
  return defineCapability<CancelArgs>({
    name: "economy.cancel_prediction",
    summary: "取消一個預測,押的全部退回",
    risk: "medium",
    args: CancelArgs,
    permission: AGENCY,
    limits: { per_day: 30, per_person_per_day: 30, cooldown_ms: 0 },
    tool: {
      name: "cancel_prediction",
      description: `預測辦不下去(結果看不出來、題目有問題)時取消,大家押的全部退回。${OWN}`,
      properties: { prediction: { type: "string", description: "預測的代號" } },
      required: ["prediction"],
    },
    async execute(args) {
      return answering("沒有取消", async (): Promise<Answer> => {
        const r = await economy.v2.cancelPrediction(args.prediction);
        return {
          text: `取消了,${r.pool} ${economy.config.currency}退回去了。`,
          data: { done: true, pool: r.pool },
        };
      });
    },
  }) as Capability;
}

/** Every tool of economy 2.0. */
export function v2Capabilities(economy: EconomyService): Capability[] {
  return [
    questsCapability(economy),
    completeQuestCapability(economy),
    collectionCapability(economy),
    drawCapability(economy),
    predictionsCapability(economy),
    placeBetCapability(economy),
    openPredictionCapability(economy),
    resolvePredictionCapability(economy),
    cancelPredictionCapability(economy),
  ];
}
