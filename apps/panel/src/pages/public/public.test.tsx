import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { IssuedCard, MemberSession, MemberView, PublicSongs, PublicStatus, SessionInfo } from "@/api/types";
import { App } from "@/app/App";
import { STORAGE_BASE_URL, STORAGE_TOKEN } from "@/app/connection";
import { createAppRouter } from "@/app/router";
import { writeStorage } from "@/lib/storage";
import { mockFetch } from "@/test/render";

const STATUS: PublicStatus = {
  state: "singing",
  live: true,
  in_voice: true,
  game: null,
  today: { songs_sung: 3, hours_live: 1.5, hours_in_voice: 2 },
  days: [
    { date: "2026-11-06", songs_sung: 4, hours_live: 2, hours_in_voice: 3 },
    { date: "2026-11-07", songs_sung: 0, hours_live: 0, hours_in_voice: 0 },
    { date: "2026-11-08", songs_sung: 3, hours_live: 1.5, hours_in_voice: 2 },
  ],
};

const SONGS: PublicSongs = {
  playing: { title: "夜に駆ける", artist: "YOASOBI", duration_s: 261 },
  upcoming: [
    { title: "群青", artist: "YOASOBI", duration_s: 248, ready: true },
    { title: null, artist: null, duration_s: null, ready: false },
  ],
  recent: [{ title: "アイドル", artist: "YOASOBI", duration_s: 213 }],
};

const ME: MemberView = {
  card: {
    call_name: "小愛",
    relationship: "好朋友",
    affinity: "很好",
    trust: "信任",
    familiarity: "熟",
    public_feeling: "妳總是記得跟我打招呼。",
  },
  memories: [{ text: "小愛喜歡貓", kind: "fact", date: "2026-11-07" }],
  songs: [{ title: "群青", artist: "YOASOBI", state: "ready", requested_at: "2026-11-07T12:00:00Z" }],
  activity: [
    { date: "2026-11-07", text: 5, voice: 2 },
    { date: "2026-11-08", text: 1, voice: 0 },
  ],
  can_request_song: true,
  forget: { removes: "會刪除:關於你的記憶", keeps: "不會刪除:聊天紀錄" },
};

const STRANGER: MemberView = {
  card: {
    call_name: null,
    relationship: null,
    affinity: null,
    trust: null,
    familiarity: null,
    public_feeling: null,
  },
  memories: [],
  songs: [],
  can_request_song: false,
  forget: ME.forget,
};

const USER: MemberSession = { name: "Alice", avatar_url: null };

interface Options {
  discord?: boolean;
  publicOn?: boolean;
  member?: MemberSession | null;
  me?: MemberView;
  session?: SessionInfo | null;
  noCard?: boolean;
}

const CARD: IssuedCard = {
  serial: "MYR-AB12-CD34-EF56",
  issued_at: "2026-11-08T03:00:00Z",
  name: "Alice",
  avatar_url: null,
  number: 1,
  call_name: "小愛",
  relationship: "好朋友",
  affinity: "很好",
  trust: "信任",
  familiarity: "熟",
  public_feeling: "妳總是記得跟我打招呼。",
  pose: "blush",
};

function core(o: Options = {}) {
  const posts: { path: string; body: unknown }[] = [];
  let latest: IssuedCard | null = o.noCard ? null : CARD;
  const fn = mockFetch((method, url, body) => {
    const path = url.pathname;
    if (method === "POST") posts.push({ path, body });
    if (path === "/api/auth/methods") return { body: { token: true, discord: o.discord ?? true } };
    if (path === "/api/auth/session") {
      return o.session ? { body: o.session } : { status: 401, body: { error: "no" } };
    }
    if (path === "/api/auth/logout") return { status: 204 };
    if (path.startsWith("/api/public/") && o.publicOn === false) return undefined;
    if (path === "/api/public/status") return { body: STATUS };
    if (path === "/api/public/songs") return { body: SONGS };
    if (path === "/api/member/session") {
      return o.member ? { body: o.member } : { status: 401, body: { error: "not logged in" } };
    }
    if (path === "/api/member/me") return { body: o.me ?? ME };
    if (path === "/api/member/forget") {
      return { body: { deleted: 2, about: 2, derived: 0, unverified: 0 } };
    }
    if (path === "/api/member/songs") return { body: { accepted: true } };
    if (path === "/api/member/card" && method === "POST") {
      latest = { ...CARD, serial: "MYR-NEW0-0000-0002", number: 2 };
      return { body: latest };
    }
    if (path === "/api/member/card") return { body: { latest, today: latest ? latest.number : 0, per_day: 5 } };
    if (path === `/api/public/card/${CARD.serial}`) return { body: CARD };
    if (path.startsWith("/api/public/card/")) return { status: 404, body: { error: "這張卡不存在或已經作廢" } };
    return undefined;
  });
  return { fn, posts };
}

const paths = (fn: ReturnType<typeof mockFetch>) =>
  fn.mock.calls.map(([input]) => new URL(String(input), "http://panel.test").pathname);

const renderApp = () =>
  render(<App router={createAppRouter(createMemoryHistory({ initialEntries: ["/"] }))} />);

afterEach(() => {
  window.history.replaceState(null, "", "/");
  writeStorage(STORAGE_TOKEN, null);
  writeStorage(STORAGE_BASE_URL, null);
});

describe("an anonymous visitor", () => {
  it("gets the login screen, Discord first, and nothing of hers", async () => {
    core();
    renderApp();
    const link = await screen.findByRole("link", { name: "使用 Discord 登入" });
    expect(link).toHaveAttribute("href", "/api/auth/oauth/login?next=%2F%23%2F");
    expect(screen.queryByLabelText("Admin token")).toBeNull();
    expect(screen.queryByRole("region", { name: "現在" })).toBeNull();
    expect(screen.queryByText("她眼中的你")).toBeNull();
    for (const name of ["總覽", "直播", "內心", "權限", "資料", "設定", "緊急停止"]) {
      expect(screen.queryByText(name)).toBeNull();
    }
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("calls nothing but the routes that say who is asking", async () => {
    const { fn } = core();
    renderApp();
    await screen.findByRole("link", { name: "使用 Discord 登入" });
    expect([...new Set(paths(fn))].sort()).toEqual([
      "/api/auth/methods",
      "/api/auth/session",
      "/api/member/session",
      "/api/public/status",
    ]);
  });

  it("can open the token form, for the owner", async () => {
    core();
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "管理員用 token 登入" }));
    expect(await screen.findByLabelText("Admin token")).toBeInTheDocument();
  });

  it("gets the token form at once when the Core has no public side", async () => {
    core({ publicOn: false });
    renderApp();
    expect(await screen.findByLabelText("Admin token")).toBeInTheDocument();
  });

  it("reaches the token form at #/login", async () => {
    window.history.replaceState(null, "", "/#/login");
    core();
    renderApp();
    expect(await screen.findByLabelText("Admin token")).toBeInTheDocument();
  });

  it("gets the token form when Discord login is off", async () => {
    core({ discord: false });
    renderApp();
    expect(await screen.findByLabelText("Admin token")).toBeInTheDocument();
  });

  it("sees why a Discord login failed, on the login screen", async () => {
    window.history.replaceState(null, "", "/#/login?error=cancelled");
    core();
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent("已取消 Discord 授權");
    expect(screen.getByRole("link", { name: "使用 Discord 登入" })).toBeInTheDocument();
  });
});

describe("a member", () => {
  it("sees her view of them, in words", async () => {
    core({ member: USER });
    renderApp();
    const view = await screen.findByRole("region", { name: "她眼中的你" });
    expect(await within(view).findByText("小愛")).toBeInTheDocument();
    expect(within(view).getByText("好朋友")).toBeInTheDocument();
    expect(within(view).getByText("很好")).toBeInTheDocument();
    expect(within(view).getByText("妳總是記得跟我打招呼。")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "一起的回憶" })).toHaveTextContent("小愛喜歡貓");
    expect(screen.getByRole("region", { name: "你點的歌" })).toHaveTextContent("群青");
    expect(within(view).getByRole("heading", { name: "Alice" })).toBeInTheDocument();
  });

  it("sees how much they talked to her and what she did, as charts", async () => {
    core({ member: USER });
    renderApp();
    const talk = await screen.findByRole("region", { name: "你和她說的話" });
    expect(await within(talk).findByText("8")).toBeInTheDocument();
    expect(within(talk).getByText("近 2 天,有 2 天說過話")).toBeInTheDocument();
    const her = await screen.findByRole("region", { name: "她這兩週" });
    expect(await within(her).findByText("7")).toBeInTheDocument();
    await userEvent.click(within(her).getByRole("radio", { name: "直播" }));
    expect(within(her).getByText("3.5")).toBeInTheDocument();
  });

  it("sees what she is doing and today's numbers", async () => {
    core({ member: USER });
    renderApp();
    const now = await screen.findByRole("region", { name: "現在" });
    expect(await within(now).findByText("她在唱歌")).toBeInTheDocument();
    expect(within(now).getByText("3 首")).toBeInTheDocument();
    const songs = screen.getByRole("region", { name: "歌單" });
    expect(await within(songs).findByText("歌名還不知道")).toBeInTheDocument();
  });

  it("never touches an admin route", async () => {
    const { fn } = core({ member: USER });
    renderApp();
    await screen.findByRole("region", { name: "她眼中的你" });
    const seen = new Set(paths(fn));
    seen.delete("/api/auth/session");
    seen.delete("/api/auth/methods");
    expect([...seen].filter((p) => !/^\/api\/(public|member)\//.test(p))).toEqual([]);
  });

  it("links to their data", async () => {
    core({ member: USER });
    renderApp();
    const link = await screen.findByRole("link", { name: "下載我的資料" });
    expect(link).toHaveAttribute("href", "/api/member/export");
  });

  it("is asked before forgetting, and told what stays", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "請她忘記我" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("不會刪除:聊天紀錄");
    expect(posts).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "全部忘記" }));
    await waitFor(() => {
      expect(posts).toEqual([{ path: "/api/member/forget", body: { confirm: true } }]);
    });
    expect(await screen.findByText("已讓她忘記關於你的 2 件事")).toBeInTheDocument();
  });

  it("can back out of forgetting", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "請她忘記我" }));
    await userEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(posts).toEqual([]);
  });

  it("requests a song with nothing but the query", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    await userEvent.type(await screen.findByLabelText("歌名或 YouTube 連結"), "群青");
    await userEvent.click(screen.getByRole("button", { name: "點歌" }));
    await waitFor(() => {
      expect(posts).toEqual([{ path: "/api/member/songs", body: { query: "群青" } }]);
    });
  });

  it("logs out to the public page", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "登出" }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain("/api/auth/logout"));
  });
});

describe("someone she has nothing to show for", () => {
  it("sees the normal page, with one plain line and no form", async () => {
    core({ member: USER, me: STRANGER });
    renderApp();
    const view = await screen.findByRole("region", { name: "她眼中的你" });
    expect(await within(view).findByText("她還不認識你")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "一起的回憶" })).toHaveTextContent("還沒有一起的回憶");
    expect(screen.queryByLabelText("歌名或 YouTube 連結")).toBeNull();
    expect(document.body.textContent).not.toMatch(/封鎖|blocked/i);
  });
});

describe("an admin", () => {
  it("still gets the admin panel, not the public site", async () => {
    core({
      session: { method: "token", user: null, permissions: { write: true } },
    });
    writeStorage(STORAGE_TOKEN, "t0ken");
    renderApp();
    await waitFor(() => expect(screen.queryByRole("region", { name: "歌單" })).toBeNull());
    await waitFor(() => expect(document.querySelector('[data-slot="stage"]')).not.toBeNull());
  });
  it("as a Discord admin, has a page of their own at #/me and a way back", async () => {
    core({
      session: { method: "discord", user: { id: "1", name: "Alice", avatar_url: null }, permissions: { write: true } },
      member: USER,
    });
    window.history.replaceState(null, "", "/#/me");
    renderApp();
    expect(await screen.findByRole("heading", { name: "Alice" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "回到管理面板" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "她眼中的你" })).toBeNull());
  });
});

describe("a card she gives", () => {
  it("is on their page, and they can draw a new one", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    const section = await screen.findByRole("region", { name: "她給你的卡" });
    expect(await within(section).findByRole("img", { name: /MYR-AB12-CD34-EF56/ })).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: /抽一張新卡/ }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain("/api/member/card"));
    expect(posts.find((p) => p.path === "/api/member/card")?.body).toEqual({});
    expect(await within(section).findByRole("img", { name: /MYR-NEW0-0000-0002/ })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "下載" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "分享" })).toBeInTheDocument();
  });

  it("says plainly when there is none yet", async () => {
    core({ member: USER, noCard: true });
    renderApp();
    const section = await screen.findByRole("region", { name: "她給你的卡" });
    expect(await within(section).findByText("還沒有卡,抽一張看看她怎麼看你")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "下載" })).toBeNull();
  });

  it("can be checked by anyone from its code, without logging in", async () => {
    const { fn } = core();
    window.history.replaceState(null, "", `/#/card/${CARD.serial}`);
    renderApp();
    expect(await screen.findByText("這張卡是真的")).toBeInTheDocument();
    expect(screen.getByText(/發給 Alice 的第 1 張卡/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /好朋友/ })).toBeInTheDocument();
    expect(paths(fn)).toContain(`/api/public/card/${CARD.serial}`);
    expect(screen.queryByRole("link", { name: "使用 Discord 登入" })).toBeNull();
  });

  it("says a made-up or revoked code is not a card", async () => {
    core();
    window.history.replaceState(null, "", "/#/card/MYR-0000-0000-0000");
    renderApp();
    expect(await screen.findByText("這張卡不存在或已經作廢")).toBeInTheDocument();
  });
});