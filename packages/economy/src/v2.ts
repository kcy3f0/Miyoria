// Economy 2.0 (docs/design/v4-plan.md §10) as one object the service owns: every desk below shares
// the service's ledger, its turns and its caps. Nothing here changes a balance without a ledger row.

import { errorMessage } from "@miyoria/kernel";
import type { CoinEntry } from "@miyoria/store";
import type { AccountRef } from "@miyoria/types";
import type { EconomyConfig } from "./config.js";
import type { EconomyService, Member } from "./economy.js";
import { PlayDesk } from "./play.js";
import { QuestDesk } from "./quests.js";
import type { Economy2, QuestId, QuestResult, QuestsView } from "./v2-types.js";

const ACTIVITY_LABEL: Readonly<Record<string, string>> = {
  game_join: "加入遊戲",
  game_finish: "玩完一場遊戲",
  game_win: "贏了遊戲",
  sing_along: "跟她一起唱",
  headpat: "摸摸她",
  web_reaction: "網頁上的互動",
  prediction_join: "參加預測",
};

/** What a ledger row of economy 2.0 reads as in a wallet; `null` for reasons it does not own. */
export function labelV2(r: CoinEntry, _config: EconomyConfig): string | null {
  switch (r.reason) {
    case "play":
      return (r.ref !== null && ACTIVITY_LABEL[r.ref]) || "一起玩";
    case "quest":
      return r.ref === "all" ? "今天的任務全部完成" : "每日任務";
    default:
      return null;
  }
}

export class V2 implements Economy2 {
  readonly play: PlayDesk;
  readonly quest: QuestDesk;

  constructor(readonly e: EconomyService) {
    this.play = new PlayDesk(e);
    this.quest = new QuestDesk(e);
  }

  get currency(): string {
    return this.e.config.currency;
  }

  /** What may have become true after coins were earned: milestones. Never throws. */
  async afterEarn(_who: Member): Promise<void> {}

  /** A quest done for someone already known; a failure is logged, never thrown at the caller. */
  async questDone(who: Member, quest: QuestId): Promise<void> {
    try {
      await this.quest.complete(who, quest);
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error), quest }, "cannot tick a quest");
    }
  }

  quests(account: AccountRef): Promise<QuestsView> {
    return this.quest.view(account);
  }

  completeQuest(account: AccountRef, quest: QuestId, topic?: string): Promise<QuestResult> {
    return this.quest.completeFor(account, quest, topic);
  }
}
