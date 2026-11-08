// The sponsor board (docs/design/economy.md §13): people who chose to be on it, ranked by what they
// spent on her lately. Opt-in, off by default, never a balance; a person's linked accounts are one
// wallet, and any account of theirs that opted in puts the person on.

import { type AccountRef, accountRefString, safeName, toTimestamp } from "@miyoria/types";
import type { EconomyService } from "./economy.js";
import type { BoardLine } from "./types.js";

/**
 * Ledger reasons that are spent on her: food, letters, expressions, a message on the screen, a
 * dedication, and a deal's escrow once it was released to her (`deal_escrow` counts only then).
 * Rows that were refunded do not count. Song tickets and card things are not gifts to her.
 */
export const BOARD_REASONS: readonly string[] = [
  "feed",
  "letter",
  "expression",
  "screen_message",
  "dedication",
  "deal_escrow",
];

/** Places the board shows at most. */
export const MAX_BOARD = 50;
const DEFAULT_BOARD = 20;
const DAY_MS = 86_400_000;
/** People on the board, and people who spent anything, read at most. */
const MAX_OPTED = 500;
const MAX_SPENDERS = 5_000;

/** The board, biggest spender first; people who spent nothing in the window are not listed. */
export async function sponsorBoard(e: EconomyService, limit = DEFAULT_BOARD): Promise<BoardLine[]> {
  const places = Math.min(Math.max(Math.trunc(limit) || DEFAULT_BOARD, 1), MAX_BOARD);
  const ledger = e.ledger();
  const opted = await ledger.boardAccounts(e.profile, MAX_OPTED);
  if (opted.length === 0) return [];
  const since = toTimestamp(e.now() - e.config.board_days * DAY_MS);
  const spent = await ledger.spent(e.profile, BOARD_REASONS, since, MAX_SPENDERS);
  const by = new Map(spent.map((s) => [accountRefString(s.account), s.spent]));
  const seen = new Set<string>();
  const people: { name: string; spent: number }[] = [];
  for (const account of opted) {
    // Known and not blocked, like anywhere else: a blocked person is off the board.
    const who = await e.member(account);
    if (!who || seen.has(who.person.id)) continue;
    seen.add(who.person.id);
    const total = who.wallet.reduce((n, a) => n + (by.get(accountRefString(a)) ?? 0), 0);
    if (total > 0) people.push({ name: safeName(who.name), spent: total });
  }
  people.sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name));
  let rank = 0;
  let last = -1;
  return people.slice(0, places).map((p, i) => {
    if (p.spent !== last) {
      rank = i + 1;
      last = p.spent;
    }
    return { rank, name: p.name, spent: p.spent };
  });
}

/** Puts a member's whole wallet on the board or off it; `false` for a stranger. */
export async function setBoard(
  e: EconomyService,
  account: AccountRef,
  on: boolean,
): Promise<boolean> {
  const who = await e.member(account);
  if (!who) return false;
  await e.ledger().setOnBoard(e.profile, who.wallet, on);
  e.record(who, "economy.board", { on });
  return true;
}
