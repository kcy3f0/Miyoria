import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleInfo, SessionInfo } from "../api/types";
import { type Handler, mockFetch } from "../test/render";
import { App } from "./App";
import { writeStorage } from "../lib/storage";
import { STORAGE_BASE_URL, STORAGE_TOKEN } from "./connection";
import { createAppRouter } from "./router";
import { LOGIN_ERRORS, READ_ONLY_HINT } from "./session";

const discordUser = (write: boolean): SessionInfo => ({
  method: "discord",
  user: { id: "111", name: "Owen", avatar_url: "https://cdn.discordapp.com/avatars/111/abc.png?size=64" },
  permissions: { write },
});

const mod: ModuleInfo = {
  id: "voice",
  name: "VOICE",
  description: "voice module",
  enabled: true,
  state: "running",
  reason: null,
  recent_restarts: 0,
};

/** Answers the auth routes; `extra` handles everything else. */
function core(opts: { discord: boolean; session?: SessionInfo | null; extra?: Handler }) {
  return mockFetch((method, url, body) => {
    if (url.pathname === "/api/auth/methods") return { body: { token: true, discord: opts.discord } };
    if (url.pathname === "/api/auth/session")
      return opts.session ? { body: opts.session } : { status: 401, body: { error: "missing or invalid bearer token" } };
    if (url.pathname === "/api/health") return { body: { status: "ok", version: "0.4.0" } };
    return opts.extra?.(method, url, body);
  });
}

const renderApp = (path = "/") => render(<App router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))} />);

afterEach(() => {
  window.history.replaceState(null, "", "/");
  // Storage keeps an in-memory copy too; clear both.
  writeStorage(STORAGE_TOKEN, null);
  writeStorage(STORAGE_BASE_URL, null);
});

describe("login screen", () => {
  it("offers Discord first and keeps the token form", async () => {
    window.history.replaceState(null, "", "/#/people");
    core({ discord: true });
    renderApp();
    const link = await screen.findByRole("link", { name: "使用 Discord 登入" });
    expect(link).toHaveAttribute("href", "/api/auth/oauth/login?next=%2F%23%2Fpeople");
    expect(screen.getByLabelText("Admin token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "用 token 連線" })).not.toHaveClass("btn--primary");
  });

  it("shows only the token form when the Core has no Discord login", async () => {
    core({ discord: false });
    renderApp();
    expect(await screen.findByRole("button", { name: "連線" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "使用 Discord 登入" })).not.toBeInTheDocument();
  });

  it("hides Discord when the API lives on another origin (cookies would not reach it)", async () => {
    window.localStorage.setItem("miyoria.panel.baseUrl", "http://elsewhere.test:7878");
    core({ discord: true });
    renderApp();
    expect(await screen.findByRole("button", { name: "連線" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "使用 Discord 登入" })).not.toBeInTheDocument();
  });

  it.each(Object.entries(LOGIN_ERRORS))("explains the `%s` error and cleans the URL", async (code, message) => {
    window.history.replaceState(null, "", `/#/login?error=${code}`);
    core({ discord: true });
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(window.location.hash).toBe("#/");
  });

  it("falls back to a generic message for unknown codes", async () => {
    window.history.replaceState(null, "", "/#/login?error=weird");
    core({ discord: true });
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent("登入失敗,請再試一次。");
  });

  it("signs in with a token and rechecks the session", async () => {
    let token = "";
    const fetch = mockFetch((_m, url, _b) => {
      const auth = new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("Authorization");
      token = auth ?? "";
      if (url.pathname === "/api/auth/methods") return { body: { token: true, discord: true } };
      if (url.pathname === "/api/health") return { body: { status: "ok", version: "0.4.0" } };
      if (url.pathname === "/api/auth/session")
        return token === "Bearer s3cret" ? { body: { method: "token", user: null, permissions: { write: true } } } : { status: 401, body: { error: "no" } };
      if (url.pathname === "/api/modules") return token === "Bearer s3cret" ? { body: [] } : { status: 401, body: { error: "no" } };
      return undefined;
    });
    const user = userEvent.setup();
    renderApp("/modules");
    await user.type(await screen.findByLabelText("Admin token"), "s3cret");
    await user.click(screen.getByRole("button", { name: "用 token 連線" }));
    expect(await screen.findByRole("heading", { name: "子系統" })).toBeInTheDocument();
    expect(window.localStorage.getItem(STORAGE_TOKEN)).toBe("s3cret");
    expect(screen.getByRole("button", { name: "登出(清除 token)" })).toBeInTheDocument();
  });
});

describe("Discord session", () => {
  it("shows the user, and disables changes for read-only accounts", async () => {
    core({ discord: true, session: discordUser(false), extra: (_m, url) => (url.pathname === "/api/modules" ? { body: [mod] } : undefined) });
    renderApp("/modules");
    const row = (await screen.findByText("VOICE")).closest("li") as HTMLElement;
    const restart = within(row).getByRole("button", { name: /重新啟動/ });
    expect(restart).toBeDisabled();
    expect(restart).toHaveAttribute("title", READ_ONLY_HINT);
    const rail = screen.getByRole("complementary", { name: "主選單" });
    expect(within(rail).getByText("Owen")).toBeInTheDocument();
    expect(within(rail).getByText("唯讀")).toBeInTheDocument();
    expect(rail.querySelector("img.rail__avatar")).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("lets writers change things, with the CSRF header and no bearer token", async () => {
    const fetch = core({
      discord: true,
      session: discordUser(true),
      extra: (method, url) => {
        if (url.pathname === "/api/modules") return { body: [mod] };
        if (method === "POST" && url.pathname === "/api/modules/voice/restart") return { body: mod };
        return undefined;
      },
    });
    const user = userEvent.setup();
    renderApp("/modules");
    const row = (await screen.findByText("VOICE")).closest("li") as HTMLElement;
    expect(screen.queryByText("唯讀")).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /重新啟動/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "重新啟動" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u, init]) => init?.method === "POST" && String(u) === "/api/modules/voice/restart")).toBe(true));
    const [, init] = fetch.mock.calls.find(([u]) => String(u) === "/api/modules/voice/restart") ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Miyoria-Request"]).toBe("1");
    expect(headers.Authorization).toBeUndefined();
    expect(init?.credentials).toBe("same-origin");
  });

  it("logs out through the Core and returns to the login screen", async () => {
    let loggedIn = true;
    const fetch = mockFetch((method, url) => {
      if (url.pathname === "/api/auth/methods") return { body: { token: true, discord: true } };
      if (url.pathname === "/api/auth/session") return loggedIn ? { body: discordUser(true) } : { status: 401, body: { error: "session expired or invalid" } };
      if (method === "POST" && url.pathname === "/api/auth/logout") {
        loggedIn = false;
        return { status: 204 };
      }
      if (url.pathname === "/api/modules") return { body: [] };
      return undefined;
    });
    const user = userEvent.setup();
    renderApp("/modules");
    await user.click(await screen.findByRole("button", { name: "登出" }));
    expect(await screen.findByRole("link", { name: "使用 Discord 登入" })).toBeInTheDocument();
    expect(fetch.mock.calls.some(([u, init]) => String(u) === "/api/auth/logout" && init?.method === "POST")).toBe(true);
  });

  it("goes back to the login screen when the session ends mid-use", async () => {
    let modulesCalls = 0;
    core({
      discord: true,
      session: discordUser(true),
      extra: (_m, url) => {
        if (url.pathname !== "/api/modules") return undefined;
        modulesCalls += 1;
        return { status: 401, body: { error: "this account no longer has panel access" } };
      },
    });
    renderApp("/modules");
    expect(await screen.findByText("登入已過期或權限已變更,請重新登入。")).toBeInTheDocument();
    expect(modulesCalls).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "使用 Discord 登入" })).toBeInTheDocument();
  });
});
