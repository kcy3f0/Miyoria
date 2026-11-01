import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./http";
import { backoff, parseEnvelope, SseParser, type StreamStatus, streamEvents } from "./sse";
import type { Envelope } from "./types";

const env = (id: string): Envelope => ({
  id,
  ts: "2026-11-01T00:00:00Z",
  source: "agent",
  causation: null,
  correlation: null,
  event: {
    type: "agent_turn_started",
    data: { turn: "T", context: { platform: "discord", scope: null, channel: "1", kind: "dm" } },
  },
});

describe("SseParser", () => {
  it("parses complete messages and ignores keep-alive comments", () => {
    const p = new SseParser();
    expect(p.push(':keep-alive\n\nid: 1\ndata: {"a":1}\n\n')).toEqual([{ event: "message", data: '{"a":1}', id: "1" }]);
  });

  it("joins multi-line data and keeps named events", () => {
    const p = new SseParser();
    expect(p.push("event: ping\ndata: a\ndata:b\n\n")).toEqual([{ event: "ping", data: "a\nb", id: undefined }]);
  });

  it("handles messages split across chunks, including a CRLF split between chunks", () => {
    const p = new SseParser();
    expect(p.push("id: 7\r")).toEqual([]);
    expect(p.push("\ndata: hel")).toEqual([]);
    expect(p.push("lo\r\n")).toEqual([]);
    expect(p.push("\r\n")).toEqual([{ event: "message", data: "hello", id: "7" }]);
    expect(p.lastEventId).toBe("7");
  });

  it("accepts bare CR line endings and the retry field", () => {
    const p = new SseParser();
    expect(p.push("retry: 2500\rdata: x\r\r")).toHaveLength(1);
    expect(p.retry).toBe(2500);
  });

  it("does not dispatch empty events and keeps the last id", () => {
    const p = new SseParser();
    expect(p.push("id: 9\n\n")).toEqual([]);
    expect(p.push("data: y\n\n")[0]?.id).toBe("9");
  });
});

describe("parseEnvelope", () => {
  it("accepts envelopes and rejects anything else", () => {
    expect(parseEnvelope(JSON.stringify(env("A")))?.id).toBe("A");
    expect(parseEnvelope("not json")).toBeUndefined();
    expect(parseEnvelope('{"id":"x"}')).toBeUndefined();
    expect(parseEnvelope("null")).toBeUndefined();
  });
});

describe("backoff", () => {
  it("grows exponentially and is capped", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(backoff(1)).toBe(1000);
    expect(backoff(3)).toBe(4000);
    expect(backoff(20, 30_000)).toBe(30_000);
  });
});

function streamResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("streamEvents", () => {
  it("streams envelopes with auth and topics, then reconnects with Last-Event-ID", async () => {
    const ctl = new AbortController();
    const received: string[] = [];
    const statuses: StreamStatus["state"][] = [];
    const a = JSON.stringify(env("A"));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([`id: A\ndata: ${a.slice(0, 10)}`, `${a.slice(10)}\n\n`, "data: garbage\n\n"]))
      .mockImplementationOnce(async () => {
        ctl.abort();
        return streamResponse([]);
      });
    vi.stubGlobal("fetch", fetch);

    await streamEvents(new ApiClient({ baseUrl: "http://core", token: "tok" }), {
      topics: ["agent.*", "voice.*"],
      signal: ctl.signal,
      onEnvelope: (e) => received.push(e.id),
      onStatus: (s) => statuses.push(s.state),
      maxDelayMs: 1,
    });

    expect(received).toEqual(["A"]);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://core/api/events?topics=agent.*%2Cvoice.*");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers.Accept).toBe("text/event-stream");
    const second = fetch.mock.calls[1]?.[1] as RequestInit;
    expect((second.headers as Record<string, string>)["Last-Event-ID"]).toBe("A");
    expect(statuses).toContain("open");
    expect(statuses).toContain("retrying");
    expect(statuses.at(-1)).toBe("closed");
  });

  it("stops for good on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"error":"missing or invalid bearer token"}', { status: 401 })),
    );
    const statuses: StreamStatus[] = [];
    await streamEvents(new ApiClient({ baseUrl: "", token: "x" }), {
      signal: new AbortController().signal,
      onEnvelope: () => {},
      onStatus: (s) => statuses.push(s),
    });
    const last = statuses.at(-1);
    expect(last?.state).toBe("closed");
    expect(last && "error" in last ? last.error : "").toContain("Token");
  });
});
