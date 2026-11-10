import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberSession } from "@/api/types";
import { ConnectionProvider } from "@/app/connection";
import { mockFetch, testQueryClient } from "@/test/render";
import {
  connectLive,
  initialView,
  type LiveAction,
  type LiveEvent,
  type LiveSnapshot,
  liveReducer,
  parseLiveEvent,
  type SourceLike,
} from "./feed";
import { isLivePath } from "./LivePage";
import { LiveStage, PAT_MS, poseOf } from "./LiveStage";
import { faceOf } from "./Mascot";

const NOW: LiveSnapshot = {
  presence: { place: "in_voice", game: null },
  activity: null,
  speaking: false,
  emotion: { name: "neutral", intensity: 0 },
  line: null,
  pats: { recent: 0, open: true },
};

const MEMBER: MemberSession = { name: "Alice", avatar_url: null } as MemberSession;

/** An `EventSource` the test drives. */
class FakeSource implements SourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  readonly listeners = new Map<string, Array<(ev: MessageEvent<string>) => void>>();
  closed = false;
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  send(event: LiveEvent): void {
    for (const l of this.listeners.get(event.type) ?? []) {
      l(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    }
  }
  fail(closed: boolean): void {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
}
const factory = (url: string) => new FakeSource(url);

afterEach(() => {
  FakeSource.all = [];
  vi.useRealTimers();
});

function Providers({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider initial={{ baseUrl: "", token: "" }}>
      <QueryClientProvider client={testQueryClient()}>{children}</QueryClientProvider>
    </ConnectionProvider>
  );
}

function stage(member: MemberSession | null = MEMBER, loginUrl: string | null = null) {
  const view = render(
    <Providers>
      <LiveStage member={member} loginUrl={loginUrl} source={factory} />
    </Providers>,
  );
  const source = FakeSource.all.at(-1) as FakeSource;
  const send = (event: LiveEvent) => act(() => source.send(event));
  const figure = () => view.container.querySelector("svg.mio") as SVGSVGElement;
  return { ...view, source, send, figure };
}

describe("the feed on the page", () => {
  it("starts from hello and folds every change into it", () => {
    let view = liveReducer(initialView, { type: "speaking", speaking: true });
    expect(view.now).toBeNull(); // nothing before hello
    view = liveReducer(view, { type: "hello", snapshot: NOW });
    expect(view.link).toBe("open");
    view = liveReducer(view, { type: "emotion", emotion: { name: "happy", intensity: 0.7 } });
    view = liveReducer(view, { type: "line", line: { id: 2, text: "嗨", final: false, via: "voice" } });
    view = liveReducer(view, { type: "line", line: { id: 1, text: "舊的", final: true, via: "text" } });
    expect(view.now?.emotion.name).toBe("happy");
    expect(view.now?.line?.text).toBe("嗨");
    view = liveReducer(view, { type: "pat", pats: { recent: 1, open: true } });
    view = liveReducer(view, { type: "pat", pats: { recent: 0, open: true } });
    expect(view.patSeq).toBe(1);
  });

  it("takes only live events off the wire", () => {
    expect(parseLiveEvent("not json")).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ type: "speak", text: "x" }))).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ type: "speaking", speaking: true }))).toEqual({
      type: "speaking",
      speaking: true,
    });
  });

  it("reconnects by itself once the Core turned the stream away, and stops when told", () => {
    vi.useFakeTimers();
    const actions: LiveAction[] = [];
    const ctl = new AbortController();
    connectLive("/api/public/live", (a) => actions.push(a), ctl.signal, factory);
    FakeSource.all[0]?.fail(false); // the browser retries this one itself
    expect(FakeSource.all).toHaveLength(1);
    FakeSource.all[0]?.fail(true);
    expect(actions.at(-1)).toEqual({ type: "link", link: "lost" });
    vi.advanceTimersByTime(3_000);
    expect(FakeSource.all).toHaveLength(2);
    ctl.abort();
    expect(FakeSource.all[1]?.closed).toBe(true);
  });

  it("says it cannot connect where the browser has no EventSource", () => {
    const actions: LiveAction[] = [];
    connectLive("/x", (a) => actions.push(a), new AbortController().signal, null);
    expect(actions).toEqual([{ type: "link", link: "lost" }]);
  });

  it("is the page at /live, and nothing else", () => {
    expect(isLivePath("/live")).toBe(true);
    expect(isLivePath("/live?x=1")).toBe(true);
    expect(isLivePath("/lively")).toBe(false);
    expect(isLivePath("/me")).toBe(false);
  });
});

describe("her figure", () => {
  it("draws every emotion she has with a face of its own, and unknown ones resting", () => {
    expect(faceOf("happy")).toBe("happy");
    expect(faceOf("Embarrassed")).toBe("shy");
    expect(faceOf("smug")).toBe("smug");
    expect(faceOf("whatever")).toBe("neutral");
  });

  it("sleeps while she is away, thinks while she thinks, sings while she sings", () => {
    expect(poseOf(null)).toBe("asleep");
    expect(poseOf({ ...NOW, presence: { place: "offline", game: null } })).toBe("asleep");
    const thinking = { kind: "thinking" as const, label: "思考中…", detail: null, progress: null };
    expect(poseOf({ ...NOW, activity: thinking })).toBe("thinking");
    expect(poseOf({ ...NOW, presence: { place: "singing", game: null } })).toBe("singing");
  });
});

describe("the live stage", () => {
  it("connects, then shows where she is, her face and what she says as it arrives", () => {
    const s = stage();
    expect(screen.getByTestId("live-state")).toHaveTextContent("連線中…");
    expect(s.source.url).toBe("/api/public/live");
    s.send({ type: "hello", snapshot: NOW });
    expect(screen.getByTestId("live-state")).toHaveTextContent("她在語音頻道");
    expect(screen.getByText("她現在沒在說話")).toBeInTheDocument();
    s.send({ type: "emotion", emotion: { name: "embarrassed", intensity: 0.8 } });
    expect(s.figure().dataset.face).toBe("shy");
    s.send({ type: "speaking", speaking: true });
    s.send({ type: "line", line: { id: 1, text: "欸,你回來啦", final: false, via: "voice" } });
    const quote = screen.getByText("欸,你回來啦");
    expect(quote).toHaveAttribute("data-final", "false");
    expect(s.figure().dataset.speaking).toBe("true");
    expect(screen.getByText("她在語音裡說")).toBeInTheDocument();
    s.send({ type: "line", line: { id: 1, text: "欸,你回來啦", final: true, via: "voice" } });
    expect(screen.getByText("欸,你回來啦")).toHaveAttribute("data-final", "true");
  });

  it("lets a line taken back disappear", () => {
    const s = stage();
    s.send({ type: "hello", snapshot: { ...NOW, line: { id: 3, text: "我跟你說", final: false, via: "voice" } } });
    expect(screen.getByText("我跟你說")).toBeInTheDocument();
    s.send({ type: "line", line: { id: 3, text: "", final: true, via: "voice" } });
    expect(screen.queryByText("我跟你說")).toBeNull();
  });

  it("shows what she is busy with, and the song by name", () => {
    const s = stage();
    s.send({
      type: "hello",
      snapshot: {
        ...NOW,
        presence: { place: "singing", game: null },
        activity: { kind: "singing", label: "正在唱", detail: "春日影", progress: null },
      },
    });
    expect(screen.getByTestId("live-state")).toHaveTextContent("她在唱歌正在唱〈春日影〉");
    expect(s.figure().dataset.pose).toBe("singing");
  });

  it("asks a visitor to log in to pat her, and offers no pat", () => {
    stage(null, "/api/auth/oauth/login?next=%2Flive");
    expect(screen.queryByRole("button", { name: /摸摸頭/ })).toBeNull();
    expect(screen.getByRole("link", { name: /登入後摸摸她/ })).toHaveAttribute(
      "href",
      "/api/auth/oauth/login?next=%2Flive",
    );
  });

  it("closes the hand while pats are off", () => {
    const s = stage();
    s.send({ type: "hello", snapshot: { ...NOW, pats: { recent: 0, open: false } } });
    expect(screen.getByRole("button", { name: /摸摸頭/ })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("摸頭還沒開放");
  });

  it("reacts to a pat at once, then sends it", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    mockFetch((method, url, body) => {
      calls.push({ method, path: url.pathname, body });
      return { body: { pats: { recent: 1, open: true } } };
    });
    const s = stage();
    s.send({ type: "hello", snapshot: NOW });
    await userEvent.click(screen.getByRole("button", { name: /摸摸頭/ }));
    expect(s.figure().dataset.patting).toBe("true");
    expect(s.figure().dataset.face).toBe("happy");
    expect(s.figure().querySelectorAll("[data-heart]")).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("她感覺到了"));
    expect(calls).toEqual([{ method: "POST", path: "/api/member/live/pat", body: {} }]);
    // Her own pat coming back through the feed does not count twice.
    s.send({ type: "pat", pats: { recent: 1, open: true } });
    expect(s.figure().querySelectorAll("[data-heart]")).toHaveLength(1);
    expect(screen.getByText("這一分鐘 1 次摸頭")).toBeInTheDocument();
  });

  it("says so in words when she has been patted too fast", async () => {
    mockFetch(() => ({ status: 429, body: { error: "too many requests" } }));
    const s = stage();
    s.send({ type: "hello", snapshot: NOW });
    await userEvent.click(screen.getByRole("button", { name: /摸摸頭/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("摸太快了"));
  });

  it("shows somebody else's pat too, and lets go of it after a moment", () => {
    vi.useFakeTimers();
    const s = stage();
    s.send({ type: "hello", snapshot: NOW });
    s.send({ type: "pat", pats: { recent: 1, open: true } });
    expect(s.figure().dataset.patting).toBe("true");
    act(() => vi.advanceTimersByTime(PAT_MS + 500));
    expect(s.figure().dataset.patting).toBe("false");
    expect(s.figure().querySelectorAll("[data-heart]")).toHaveLength(0);
  });

  it("keeps the last picture while it reconnects, and says it is lost before any", () => {
    const s = stage();
    act(() => s.source.fail(true));
    expect(screen.getByTestId("live-state")).toHaveTextContent("連不上現場");
    expect(s.figure().dataset.pose).toBe("asleep");
    const t = stage();
    t.send({ type: "hello", snapshot: NOW });
    act(() => t.source.fail(false));
    expect(screen.getAllByTestId("live-state").at(-1)).toHaveTextContent("她在語音頻道· 重新連線中…");
    expect(screen.getAllByRole("button", { name: /摸摸頭/ }).at(-1)).toBeDisabled();
  });
});
