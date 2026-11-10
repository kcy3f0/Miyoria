// Party games (`@miyoria/party`) as the panel can see them. The module does not expose its table
// to the API, but every game tells her what happens in it as an observation of the EventLog
// (source `game.party.<game>`, attention key `party:<session>:<what>`), and the end of a game is
// the note `party:<session>:end`. So a session is read back from those lines: running while it has
// no end note and was heard from lately, finished once it has one.

import type { LogEvent } from "@/api/types";

export const PARTY_GAMES: Record<string, string> = { soup: "海龜湯", song: "猜歌", chain: "接龍", quiz: "問答" };
export const PARTY_SOURCES = Object.keys(PARTY_GAMES).map((g) => `game.party.${g}`);

/** A session with no word for this long, and no end note, is not counted as running (it was cut off). */
export const RUNNING_WINDOW_MS = 30 * 60_000;

export interface PartyLine {
  at: string;
  summary: string;
}

export interface PartySession {
  id: string;
  game: string;
  title: string;
  context: LogEvent["context"];
  startedAt: string;
  lastAt: string;
  /** What the game said about itself, oldest first (the end note included). */
  lines: PartyLine[];
  /** The end note's text (final scores and the game's last words); `null` while it runs. */
  result: string | null;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

/** Sessions found in `events` (any order), newest activity first. */
export function partySessions(events: LogEvent[]): PartySession[] {
  const byId = new Map<string, PartySession>();
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const e of sorted) {
    if (e.kind !== "observation" || !e.source.startsWith("game.party.")) continue;
    const o = rec(rec(e.body).observation);
    const key = typeof o.attention_key === "string" ? /^party:([^:]+):(.+)$/.exec(o.attention_key) : null;
    const summary = typeof o.summary === "string" ? o.summary : null;
    if (key === null || summary === null) continue;
    const game = e.source.slice("game.party.".length);
    let s = byId.get(key[1] as string);
    if (s === undefined) {
      s = { id: key[1] as string, game, title: PARTY_GAMES[game] ?? game, context: e.context, startedAt: e.at, lastAt: e.at, lines: [], result: null };
      byId.set(s.id, s);
    }
    s.lastAt = e.at;
    s.lines.push({ at: e.at, summary });
    if (key[2] === "end") s.result = summary;
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

export const isRunning = (s: PartySession, now: number): boolean => s.result === null && now - Date.parse(s.lastAt) < RUNNING_WINDOW_MS;
