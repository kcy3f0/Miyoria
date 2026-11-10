// Economy 2.0 (docs/design/v4-plan.md §10) as one object the service owns: every desk below shares
// the service's ledger, its turns and its caps. Nothing here changes a balance without a ledger row.

import type { CoinEntry } from "@miyoria/store";
import type { EconomyConfig } from "./config.js";
import type { EconomyService } from "./economy.js";
import { PlayDesk } from "./play.js";

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
    default:
      return null;
  }
}

export class V2 {
  readonly play: PlayDesk;

  constructor(readonly e: EconomyService) {
    this.play = new PlayDesk(e);
  }
}
