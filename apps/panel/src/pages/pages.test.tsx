import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Envelope, ModuleInfo } from "../api/types";
import { ConnectionProvider, STORAGE_TOKEN } from "../app/connection";
import { EventStore } from "../app/events-store";
import { mockFetch, renderPage } from "../test/render";
import { EventsPage } from "./Events";
import { ModulesPage } from "./Modules";
import { PeoplePage } from "./People";
import { PersonaPage } from "./Persona";
import { TokenGate } from "./TokenGate";

const mod = (id: string, over: Partial<ModuleInfo> = {}): ModuleInfo => ({
  id,
  name: id.toUpperCase(),
  description: `${id} module`,
  enabled: true,
  state: "running",
  reason: null,
  recent_restarts: 0,
  ...over,
});

describe("ModulesPage", () => {
  it("confirms before disabling and posts the action", async () => {
    const modules = [mod("api"), mod("voice", { state: "failed", reason: "TTS worker unreachable" }), mod("memory", { enabled: false, state: "disabled" })];
    const fetch = mockFetch((method, url) => {
      if (method === "GET" && url.pathname === "/api/modules") return { body: modules };
      if (method === "POST" && url.pathname === "/api/modules/voice/disable") return { body: { ...modules[1], enabled: false, state: "disabled" } };
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(<ModulesPage />);

    expect(await screen.findByText("VOICE")).toBeInTheDocument();
    expect(screen.getByText("原因:TTS worker unreachable")).toBeInTheDocument();

    // The API module cannot stop itself.
    const apiRow = screen.getByText("API").closest("li") as HTMLElement;
    expect(within(apiRow).getByRole("button", { name: /停用/ })).toBeDisabled();

    const voiceRow = screen.getByText("VOICE").closest("li") as HTMLElement;
    await user.click(within(voiceRow).getByRole("button", { name: "停用" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("停用「VOICE」?")).toBeInTheDocument();
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "停用" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u, init]) => init?.method === "POST" && String(u) === "/api/modules/voice/disable")).toBe(true));
    expect(await screen.findByText(/已停用 VOICE/)).toBeInTheDocument();
  });

  it("filters to modules that need attention", async () => {
    mockFetch(() => ({ body: [mod("agent"), mod("voice", { state: "degraded" })] }));
    const user = userEvent.setup();
    renderPage(<ModulesPage />);
    await screen.findByText("AGENT");
    await user.click(screen.getByRole("radio", { name: /需要注意/ }));
    expect(screen.queryByText("AGENT")).not.toBeInTheDocument();
    expect(screen.getByText("VOICE")).toBeInTheDocument();
  });

  it("shows a retryable error when the Core is unreachable", async () => {
    mockFetch(() => ({ status: 503, body: { error: "supervisor is not available" } }));
    renderPage(<ModulesPage />);
    expect(await screen.findByText("服務未啟動")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
  });
});

describe("PersonaPage", () => {
  it("shows a diff before saving and saves the trimmed body", async () => {
    let saved: unknown;
    const fetch = mockFetch((method, url, body) => {
      if (url.pathname === "/api/persona") return { body: [{ key: "style", body: "short\ncasual" }] };
      if (url.pathname === "/api/persona/style/history") return { body: [] };
      if (method === "PUT" && url.pathname === "/api/persona/style") {
        saved = body;
        return { body: { key: "style", version: 1 } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(<PersonaPage />);

    const editor = await screen.findByLabelText("style 內容");
    expect(screen.getByRole("button", { name: "檢視變更" })).toBeDisabled();
    await user.clear(editor);
    await user.type(editor, "short\ntsundere  ");
    await user.click(screen.getByRole("button", { name: "檢視變更" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("+1")).toBeInTheDocument();
    expect(within(dialog).getByText("tsundere")).toBeInTheDocument();
    expect(within(dialog).getByText("casual")).toBeInTheDocument();
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(saved).toEqual({ body: "short\ntsundere", edited_by: "panel" }));
    expect(await screen.findByText(/已儲存「style」v1/)).toBeInTheDocument();
  });

  it("explains an empty history", async () => {
    mockFetch((_m, url) => {
      if (url.pathname === "/api/persona") return { body: [{ key: "identity", body: "x" }] };
      if (url.pathname.endsWith("/history")) return { body: [] };
      return undefined;
    });
    renderPage(<PersonaPage />);
    expect(await screen.findByText("還沒有修改過")).toBeInTheDocument();
  });
});

const envelope = (i: number, event: Envelope["event"]): Envelope => ({
  id: `E${String(i).padStart(3, "0")}`,
  ts: new Date(Date.UTC(2026, 10, 1, 10, 0, i)).toISOString(),
  source: "agent",
  causation: null,
  correlation: null,
  event,
});
const ctx = { platform: "discord", scope: "1", channel: "42", kind: "channel" as const };

describe("EventsPage", () => {
  it("filters by topic, pauses, and opens the JSON drawer", async () => {
    mockFetch(() => undefined);
    const store = new EventStore(0);
    const user = userEvent.setup();
    renderPage(<EventsPage />, { store });
    expect(await screen.findByText("尚未連線")).toBeInTheDocument();

    act(() => {
      store.push(envelope(1, { type: "agent_turn_completed", data: { turn: "T", context: ctx, text: "哼,拉麵啦" } }));
      store.push(envelope(2, { type: "custom", data: { topic: "voice.latency", payload: { stage: "asr", asr_ms: 200 } } }));
      store.flush();
    });
    expect(screen.getByText("她說:哼,拉麵啦")).toBeInTheDocument();
    expect(screen.getByText("voice.latency")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "voice.*" }));
    expect(screen.queryByText("她說:哼,拉麵啦")).not.toBeInTheDocument();
    expect(screen.getByText("voice.latency")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "voice.*" }));

    await user.click(screen.getByRole("button", { name: "暫停" }));
    act(() => {
      store.push(envelope(3, { type: "agent_turn_completed", data: { turn: "T", context: ctx, text: "新的一句" } }));
      store.flush();
    });
    expect(screen.queryByText("她說:新的一句")).not.toBeInTheDocument();
    expect(screen.getByText(/暫停期間收到 1 則新事件/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "繼續" }));
    expect(screen.getByText("她說:新的一句")).toBeInTheDocument();

    await user.click(screen.getByText("她說:新的一句"));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("E003")).toBeInTheDocument();
    expect(within(drawer).getByLabelText("Envelope").textContent).toContain('"agent_turn_completed"');
  });
});

describe("planned pages", () => {
  it("render a clear 'not provided' state on 404", async () => {
    mockFetch(() => undefined);
    renderPage(<PeoplePage />);
    expect(await screen.findByText("尚未提供(core 版本較舊)")).toBeInTheDocument();
    expect(screen.getByText("GET /api/people")).toBeInTheDocument();
  });

  it("render real data when the endpoint exists", async () => {
    mockFetch((_m, url) =>
      url.pathname === "/api/people"
        ? {
            body: {
              items: [
                {
                  person: { id: "P1", display_name: "Owen", created_at: "2026-01-01T00:00:00Z", accounts: [{ account: { platform: "discord", id: "1" }, display_name: "Owen", first_seen: "2026-01-01T00:00:00Z", last_seen: "2026-11-01T00:00:00Z" }] },
                  relationship: null,
                  label: "朋友",
                  blocked: false,
                },
              ],
              next_cursor: null,
            },
          }
        : undefined,
    );
    renderPage(<PeoplePage />);
    expect(await screen.findByRole("link", { name: "Owen" })).toBeInTheDocument();
    expect(screen.getByText("朋友")).toBeInTheDocument();
  });
});

describe("TokenGate", () => {
  it("rejects a bad token and stores a good one", async () => {
    let good = false;
    mockFetch((_m, url) => {
      if (url.pathname === "/api/health") return { body: { status: "ok", version: "0.3.0" } };
      if (url.pathname === "/api/modules") return good ? { body: [] } : { status: 401, body: { error: "missing or invalid bearer token" } };
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <ConnectionProvider initial={{ baseUrl: "", token: "" }}>
        <TokenGate />
      </ConnectionProvider>,
    );

    await user.click(screen.getByRole("button", { name: "連線" }));
    expect(await screen.findByText("請輸入 token。")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Admin token"), "wrong");
    await user.click(screen.getByRole("button", { name: "連線" }));
    expect(await screen.findByText("Core 拒絕了這個 token。")).toBeInTheDocument();
    expect(screen.getByLabelText("Admin token")).toHaveAttribute("aria-invalid", "true");

    good = true;
    await user.click(screen.getByRole("button", { name: "連線" }));
    await waitFor(() => expect(window.localStorage.getItem(STORAGE_TOKEN)).toBe("wrong"));
  });
});
