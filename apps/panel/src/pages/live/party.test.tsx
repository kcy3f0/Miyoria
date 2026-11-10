import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LogEvent } from "@/api/types";
import { isRunning, partySessions } from "@/lib/party";
import { mockFetch, renderRoute } from "@/test/render";

const VOICE = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" } as const;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function note(id: string, game: string, session: string, what: string, summary: string, at: string): LogEvent {
  return {
    id,
    at,
    kind: "observation",
    source: `game.party.${game}`,
    cause: null,
    context: VOICE,
    person: null,
    body: { observation: { summary, attention_key: `party:${session}:${what}` } },
  };
}

const EVENTS: LogEvent[] = [
  note("e4", "soup", "S2", "round", "海龜湯:第二題開始,大家可以問是非題", ago(60_000)),
  note("e3", "soup", "S2", "start", "海龜湯開始了", ago(300_000)),
  note("e2", "quiz", "S1", "end", "「問答」結束了(題目答完了)。\n最後分數:Owen 30、你 10", ago(3_600_000)),
  note("e1", "quiz", "S1", "start", "問答開始了", ago(4_000_000)),
];

describe("派對遊戲 (read back from the event log)", () => {
  it("groups the notes of a session and tells a running one from a finished one", () => {
    const sessions = partySessions(EVENTS);
    expect(sessions.map((s) => [s.id, s.title, s.lines.length, s.result !== null])).toEqual([
      ["S2", "海龜湯", 2, false],
      ["S1", "問答", 2, true],
    ]);
    const now = Date.now();
    expect(isRunning(sessions[0] as never, now)).toBe(true);
    expect(isRunning(sessions[1] as never, now)).toBe(false);
    // Cut off without an end note: not counted as running forever.
    expect(isRunning({ ...(sessions[0] as never), lastAt: ago(2 * 3_600_000) }, now)).toBe(false);
  });

  it("ignores lines that are not party notes", () => {
    const stray: LogEvent = { ...(EVENTS[0] as LogEvent), source: "game.minecraft" };
    expect(partySessions([stray])).toEqual([]);
    expect(partySessions([{ ...(EVENTS[0] as LogEvent), body: { observation: { summary: "x", attention_key: "other" } } }])).toEqual([]);
  });

  it("shows the running game per voice channel and the recent results on 直播", async () => {
    mockFetch((_m, u) => {
      if (u.pathname === "/api/facts/events") {
        expect(u.searchParams.get("source")).toContain("game.party.soup");
        expect(u.searchParams.get("kind")).toBe("observation");
        return { body: EVENTS };
      }
      return undefined;
    });
    renderRoute("/live");
    const card = await screen.findByRole("region", { name: "派對遊戲" });
    const running = await within(card).findByRole("list", { name: "進行中的遊戲" });
    expect(within(running).getByText("海龜湯")).toBeInTheDocument();
    expect(running).toHaveTextContent("第二題開始");
    const results = within(card).getByRole("region", { name: "最近的結果" });
    expect(results).toHaveTextContent("最後分數:Owen 30、你 10");
  });

  it("has empty, off and error states", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/facts/events" ? { body: [] } : undefined));
    const a = renderRoute("/live");
    expect(await screen.findByText("現在沒有人在玩")).toBeInTheDocument();
    a.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/facts/events" ? { status: 503, body: { error: "event log is not available" } } : undefined));
    const b = renderRoute("/live");
    expect(await screen.findByText("事件紀錄(facts 模組)沒有啟動")).toBeInTheDocument();
    b.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/facts/events" ? { status: 500, body: { error: "boom" } } : undefined));
    renderRoute("/live");
    const card = await screen.findByRole("region", { name: "派對遊戲" });
    expect(await within(card).findByRole("alert")).toHaveTextContent("boom");
  });
});
