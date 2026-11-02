import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MindView, PendingApproval, SelfView, Thought, WorldView } from "@/api/types";
import { mockFetch, renderRoute } from "@/test/render";

const SELF: SelfView = {
  at: "2026-11-02T12:00:00.000Z",
  mood: { valence: 0.3, arousal: 0.4, energy: 0.8 },
  boredom: 0.62,
  drives: { social: 0.8, play: 0.5, attention: 0.3, rest: 0.2, curiosity: 0.4 },
  policy: {
    talkativeness: {
      "discord:g1:voice:v1": { level: 0.7, until: null, why: "大家在玩遊戲很熱鬧", set_at: "2026-11-02T11:00:00.000Z" },
      "*": { level: 0.4, until: "2026-11-02T13:00:00.000Z", why: "", set_at: "2026-11-02T11:00:00.000Z" },
    },
    initiative: 0.55,
    initiative_why: "今天想多找人聊",
  },
  agenda: [
    {
      id: "a1",
      text: "等 Owen 上線問他報告結果",
      why: "他昨天說今天會交",
      person: "p1",
      context: null,
      created_at: "2026-11-02T11:00:00.000Z",
      due: null,
      expires_at: null,
      status: "open",
      closed_at: null,
    },
    {
      id: "a2",
      text: "去語音看看",
      why: "",
      person: null,
      context: null,
      created_at: "2026-11-02T10:00:00.000Z",
      due: null,
      expires_at: "2026-11-02T10:30:00.000Z",
      status: "expired",
      closed_at: "2026-11-02T10:30:00.000Z",
    },
  ],
  feelings: [
    { person: "p1", display_name: "Owen", text: "最近常陪我聊天,有點在意他", updated_at: "2026-11-02T11:30:00.000Z", by: "self" },
  ],
};

const WORLD: WorldView = {
  at: "2026-11-02T12:00:00.000Z",
  time: { local: "2026-11-02 20:00", weekday: 1, weekend: false, part_of_day: "晚上", utc_offset_minutes: 480 },
  her: {
    voice: { platform: "discord", scope: "g1", channel: "v1", kind: "voice" },
    voice_name: "雜談",
    golive: null,
    streaming: true,
    scene: "Gaming",
    game: "Minecraft",
  },
  people: [
    {
      account: { platform: "discord", id: "1" },
      person: "p1",
      display_name: "Owen",
      status: "online",
      activities: [
        { type: "playing", name: "Minecraft", details: null, state: null, started_at: null, url: null },
        { type: "listening", name: "Spotify", details: "Song", state: "Artist", started_at: null, url: null },
      ],
      voice: { platform: "discord", guild: "g1", channel: "v1", channel_name: "雜談" },
      online_since: null,
      updated_at: "2026-11-02T11:00:00.000Z",
    },
    {
      account: { platform: "discord", id: "2" },
      person: null,
      display_name: "Bob",
      status: null,
      activities: [],
      voice: { platform: "discord", guild: "g1", channel: "v1", channel_name: "雜談" },
      online_since: null,
      updated_at: "2026-11-02T11:00:00.000Z",
    },
  ],
  voice_channels: [
    {
      platform: "discord",
      guild: "g1",
      channel: "v1",
      name: "雜談",
      members: [
        { account: { platform: "discord", id: "1" }, person: "p1", display_name: "Owen", is_self: false, muted: true, deafened: false, video: false, streaming: true, since: "2026-11-02T11:00:00.000Z" },
        { account: { platform: "discord", id: "7" }, person: null, display_name: "DeepSeek-chan", is_self: true, muted: false, deafened: false, video: false, streaming: false, since: "2026-11-02T11:00:00.000Z" },
      ],
    },
  ],
  channels: [
    {
      context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
      label: "Miyoria / 雜談",
      recent_messages: 12,
      per_minute: 1.2,
      last_at: "2026-11-02T11:59:00.000Z",
      recent_authors: ["Owen", "Bob"],
      topic: ["鯨魚", "minecraft"],
      lively: true,
      her_last_at: null,
    },
  ],
};

const THOUGHT: Thought = {
  id: "t1",
  at: "2026-11-02T11:59:00.000Z",
  triggers: [{ kind: "salient", detail: "Owen 進了語音頻道「雜談」", context: null, at: "2026-11-02T11:59:00.000Z" }],
  thought: "Owen 進語音了耶……就說我剛好路過。",
  changes: ["多話程度 voice 0.80(30 分鐘)"],
  intents: [
    {
      id: "i1",
      capability: "voice.join",
      args: { channel: "v1" },
      why: "想找 Owen 聊天",
      opening: "假裝路過",
      context: { platform: "discord", scope: "g1", channel: "v1", kind: "voice" },
      about: { platform: "discord", id: "1" },
      expires_at: "2026-11-02T12:01:00.000Z",
      status: "done",
      detail: "joined voice channel v1",
      turn: "turn1",
      decisions: [
        { at: "2026-11-02T11:59:01.000Z", capability: "voice.join", allowed: true, stage: "rate", reason: "within limits" },
      ],
      said: "我只是剛好路過喔。",
    },
    {
      id: "i2",
      capability: "chat.dm",
      args: { to: "2" },
      why: "",
      opening: null,
      context: null,
      about: { platform: "discord", id: "2" },
      expires_at: "2026-11-02T12:01:00.000Z",
      status: "denied",
      detail: "the person opted out of DMs from her",
      turn: "turn2",
      decisions: [
        {
          at: "2026-11-02T11:59:01.000Z",
          capability: "chat.dm",
          allowed: false,
          stage: "consent",
          reason: "the person opted out of DMs from her",
        },
      ],
      said: null,
    },
  ],
  tokens: 1500,
  error: null,
  ms: 4200,
};

const APPROVAL: PendingApproval = {
  id: "ap1",
  capability: "tool.propose",
  summary: "寫一個小工具",
  principal: "self",
  args: {},
  why: "想幫大家算分數",
  review: "不確定會不會被濫用",
  requested_at: "2026-11-02T11:58:00.000Z",
  expires_at: "2026-11-02T12:08:00.000Z",
};

function mindView(paused: boolean, approvals: number): MindView {
  return {
    paused,
    running: true,
    accepting: !paused,
    stats: {
      calls_last_hour: 3,
      max_calls_per_hour: 12,
      calls_total: 40,
      tokens_total: 52_000,
      last_at: "2026-11-02T11:59:00.000Z",
      next_heartbeat_at: "2026-11-02T12:10:00.000Z",
      idle_reason: paused ? "paused" : null,
    },
    pending_approvals: approvals,
  };
}

function serve() {

  return mockFetch((_m, url) => {
    if (url.pathname === "/api/self") return { body: SELF };
    if (url.pathname === "/api/world") return { body: WORLD };
    return undefined;
  });
}

describe("Inner", () => {
  it("shows her state, policy and agenda with what she is doing", async () => {
    serve();
    renderRoute("/inner");
    const list = await screen.findByLabelText("她的狀態");
    expect(within(list).getByText("心情")).toBeInTheDocument();
    expect(within(list).getByText("想聊天")).toBeInTheDocument();
    expect(within(list).getByRole("meter", { name: "想聊天 0.80" })).toBeInTheDocument();
    expect(within(list).getByRole("meter", { name: "無聊 0.62" })).toBeInTheDocument();

    const talk = screen.getByRole("table", { name: "多話程度" });
    expect(within(talk).getByText("語音 v1")).toBeInTheDocument();
    expect(within(talk).getByText("所有地方")).toBeInTheDocument();
    expect(within(talk).getByText("大家在玩遊戲很熱鬧")).toBeInTheDocument();
    expect(screen.getByText("今天想多找人聊")).toBeInTheDocument();

    const agenda = screen.getByRole("table", { name: "議程" });
    expect(within(agenda).getByText("等 Owen 上線問他報告結果")).toBeInTheDocument();
    expect(within(agenda).getByText("過期")).toBeInTheDocument();

    expect(await screen.findByText("直播中")).toBeInTheDocument();
    expect(screen.getByText("玩 Minecraft")).toBeInTheDocument();
    expect(screen.getByText("在語音「雜談」")).toBeInTheDocument();
    expect(screen.getByText("星期一 晚上 20:00")).toBeInTheDocument();
  });

  it("lists her feelings and the world on their tabs", async () => {
    serve();
    const user = userEvent.setup();
    renderRoute("/inner");
    await user.click(await screen.findByRole("tab", { name: "感情" }));
    const feelings = await screen.findByRole("table", { name: "感情" });
    expect(within(feelings).getByRole("link", { name: "Owen" })).toHaveAttribute(
      "href",
      "/character?tab=people&person=p1",
    );
    expect(within(feelings).getByText("最近常陪我聊天,有點在意他")).toBeInTheDocument();
    expect(within(feelings).getByText("她")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "世界" }));
    const people = await screen.findByRole("table", { name: "在線的人" });
    const owen = within(people).getByText("Owen").closest("tr") as HTMLElement;
    expect(within(owen).getByText("在線")).toBeInTheDocument();
    expect(within(owen).getByText("玩 Minecraft、聽 Song — Artist")).toBeInTheDocument();
    // No presence for Bob (opted out): a dash.
    const bob = within(people).getByText("Bob").closest("tr") as HTMLElement;
    expect(within(bob).getAllByText("—").length).toBeGreaterThan(0);

    const voice = screen.getByRole("region", { name: "雜談" });
    expect(within(voice).getByText("她")).toBeInTheDocument();
    expect(within(voice).getByLabelText("分享螢幕")).toBeInTheDocument();
    expect(within(voice).getByLabelText("靜音")).toBeInTheDocument();

    const channels = screen.getByRole("table", { name: "文字頻道" });
    expect(within(channels).getByText("Miyoria / 雜談")).toBeInTheDocument();
    expect(within(channels).getByText("熱鬧")).toBeInTheDocument();
    expect(within(channels).getByText("鯨魚、minecraft")).toBeInTheDocument();
  });

  it("says when the modules are not running", async () => {
    mockFetch((_m, url) =>
      url.pathname === "/api/self" || url.pathname === "/api/world"
        ? { status: 503, body: { error: "self module is not available" } }
        : undefined,
    );
    renderRoute("/inner");
    expect(await screen.findByText("服務未啟動")).toBeInTheDocument();
    expect(screen.getByText(/self module is not available/)).toBeInTheDocument();
  });

  it("shows her thoughts with intents and gate outcomes, approvals and the pause switch", async () => {
    let paused = false;
    let pending: PendingApproval[] = [APPROVAL];
    const fetch = mockFetch((method, url) => {
      if (url.pathname === "/api/mind") return { body: mindView(paused, pending.length) };
      if (url.pathname === "/api/mind/thoughts") return { body: [THOUGHT] };
      if (url.pathname === "/api/mind/approvals") return { body: pending };
      if (method === "POST" && url.pathname === "/api/mind/pause") {
        paused = true;
        return { body: mindView(true, pending.length) };
      }
      if (method === "POST" && url.pathname === `/api/mind/approvals/${APPROVAL.id}/approve`) {
        pending = [];
        return { body: [] };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/inner?tab=thoughts");

    const timeline = await screen.findByRole("list", { name: "想法時間軸" });
    expect(within(timeline).getByText("Owen 進語音了耶……就說我剛好路過。")).toBeInTheDocument();
    expect(within(timeline).getByText("周遭變化")).toBeInTheDocument();
    expect(within(timeline).getByText("多話程度 voice 0.80(30 分鐘)")).toBeInTheDocument();
    const intents = within(timeline).getByRole("list", { name: "意圖" });
    expect(within(intents).getByText("voice.join")).toBeInTheDocument();
    expect(within(intents).getByText("完成")).toBeInTheDocument();
    expect(within(intents).getByText("我只是剛好路過喔。")).toBeInTheDocument();
    expect(within(intents).getAllByText("擋下").length, "badge and gate line").toBe(2);
    expect(within(intents).getByText(/對方意願 · the person opted out of DMs/)).toBeInTheDocument();

    const status = await screen.findByLabelText("心智迴圈");
    expect(within(status).getByText("3 / 12")).toBeInTheDocument();
    expect(screen.getByText("運作中")).toBeInTheDocument();

    const approvals = screen.getByRole("table", { name: "等待確認" });
    expect(within(approvals).getByText("寫一個小工具")).toBeInTheDocument();
    expect(within(approvals).getByText("想幫大家算分數")).toBeInTheDocument();
    await user.click(within(approvals).getByRole("button", { name: "允許" }));
    expect(await screen.findByText("沒有等待確認的動作")).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "暫停" }));
    expect(await screen.findByText("已暫停")).toBeInTheDocument();
    const posts = fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([input]) => new URL(String(input), "http://panel.test").pathname);
    expect(posts).toEqual([`/api/mind/approvals/${APPROVAL.id}/approve`, "/api/mind/pause"]);
  });

  it("is in the navigation", async () => {
    serve();
    renderRoute("/inner?tab=world");
    expect(await screen.findByRole("link", { name: "內心" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "在線的人" })).toBeInTheDocument();
  });
});
