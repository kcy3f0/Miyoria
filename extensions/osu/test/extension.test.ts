// The whole extension through the SDK runtime against a fake host and a fake live.service.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { type InitializeResult, RpcPeer, runExtension } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import extension, { accountProblem } from "../src/index.js";

async function waitFor(ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const TOKEN = "test-token-0123456789";
const context = { platform: "discord", scope: null, channel: "c1", kind: "voice" };
const toolContext = {
  turn: "01J00000000000000000000000",
  context,
  account: { platform: "discord", id: "42" },
  message: { context, id: "m1" },
  priority: "normal",
};

const GAME_EVENTS = [
  { id: 2, type: "started", artist: "Soleily", title: "Renatus", version: "Hard", level: "hard" },
  { id: 3, type: "combo_break", combo: 320, misses: 1, accuracy: 0.991 },
  {
    id: 4,
    type: "finished",
    artist: "Soleily",
    title: "Renatus",
    version: "Hard",
    accuracy: 0.9912,
    rank: "S",
    misses: 1,
    full_combo: false,
  },
];

let server: Server | undefined;
let shutdown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  const s = server;
  if (s) await new Promise((resolve) => s.close(resolve));
  server = undefined;
});

/** Fake live.service logged in as `user`: records requests, answers like the real one. */
async function fakeService(user: string | null = "Miyoria AI") {
  const requests: Array<{ method: string; path: string; auth?: string; body: unknown }> = [];
  const s = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      const reply = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`)
        return reply(401, { error: "unauthorized" });
      if (req.url?.startsWith("/events")) {
        // first poll: an old event (not replayed); then the play's events once; then nothing new
        const after = Number(new URL(req.url, "http://x").searchParams.get("after"));
        if (after === 0) return reply(200, { events: [{ id: 1, type: "preparing" }], last: 1 });
        if (after === 1) return reply(200, { events: GAME_EVENTS, last: 4 });
        return setTimeout(() => reply(200, { events: [], last: 4 }), 50);
      }
      if (req.url === "/solo")
        return reply(200, { user, room: null, level: "hard", playing: true, now: null });
      if (req.url === "/join") return reply(400, { error: "already_in_room" });
      if (req.url === "/play" && (JSON.parse(raw) as { beatmap_id: number }).beatmap_id === 999)
        return setTimeout(() => reply(200, {}), 1000); // a map still being prepared
      if (req.url === "/play")
        return reply(200, { accuracy: 0.99, rank: "S", replay_url: "/replays/abc.osr" });
      return reply(200, { user, room: 7, level: "expert", ready: true });
    });
  });
  server = s;
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, requests };
}

function host() {
  const hostToExt = new PassThrough();
  const extToHost = new PassThrough();
  const runtime = runExtension(extension, {
    input: hostToExt,
    output: extToHost,
    exit: () => {},
    timeoutMs: 2000,
  });
  const published: Array<{
    topic: string;
    payload: { data: { text: string }; important?: boolean };
  }> = [];
  const peer = new RpcPeer({
    input: extToHost,
    output: hostToExt,
    timeoutMs: 3000,
    onRequest: (method, params) => {
      if (method === "events.publish") published.push(params as (typeof published)[number]);
      return {};
    },
    onNotification: () => {},
  });
  shutdown = () => runtime.shutdown();
  return { peer, published };
}

function initialize(peer: RpcPeer, config: Record<string, unknown>) {
  return peer.request<InitializeResult>("initialize", {
    protocol: 1,
    host: { name: "miyoria", version: "0.1.0" },
    extension: { id: "miyoria.osu", version: "0.1.0", dir: "/ext", game: "osu" },
    config,
    permissions: { events: [], tools: true, commands: false, network: [], input: [] },
  });
}

describe("extension", () => {
  it("turns the live.service API into tools", async () => {
    const service = await fakeService();
    const { peer } = host();
    const result = await initialize(peer, {
      url: service.url,
      token: TOKEN,
      public_url: "https://ai.example",
      account: "miyoria ai",
      blocked_accounts: ["owner"],
    });
    const tools = result.contributions.tools;
    expect(tools.map((t) => t.name)).toEqual([
      "osu_ai.status",
      "osu_ai.list_rooms",
      "osu_ai.join_room",
      "osu_ai.leave_room",
      "osu_ai.set_level",
      "osu_ai.play_map",
      "game.osu.observe",
      "game.osu.act",
    ]);
    expect(tools.find((t) => t.name === "osu_ai.status")?.permission).toBeNull();
    expect(tools.find((t) => t.name === "osu_ai.join_room")?.permission).toBe("tools.osu.play");
    expect(tools.find((t) => t.name === "osu_ai.join_room")?.parameters).toMatchObject({
      required: ["room_id"],
    });

    const call = async (name: string, args: unknown) =>
      (await peer.request<{ content: string }>("tools.call", { name, args, context: toolContext }))
        .content;
    expect(JSON.parse(await call("osu_ai.status", {}))).toEqual({
      user: "Miyoria AI",
      room: 7,
      level: "expert",
      ready: true,
    });
    expect(await call("osu_ai.join_room", { room_id: 7 })).toBe("失敗:already_in_room");
    expect(
      JSON.parse(await call("osu_ai.play_map", { beatmap_id: 5, mods: ["hd"] })),
    ).toMatchObject({
      replay_url: "https://ai.example/replays/abc.osr",
    });
    // Every call first asks who live.service is logged in as (the event poller does the same).
    const calls = service.requests.filter((r) => !r.path.startsWith("/events"));
    calls.forEach((r, i) => {
      if (r.path !== "/status") expect(calls[i - 1]?.path).toBe("/status");
    });
    expect(
      calls.filter((r) => r.path !== "/status").map((r) => [r.method, r.path, r.body]),
    ).toEqual([
      ["POST", "/join", { room_id: 7 }],
      ["POST", "/play", { beatmap_id: 5, mods: [{ acronym: "HD" }] }],
    ]);
    expect(service.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("plays maps for the director and publishes game events", async () => {
    const service = await fakeService();
    const { peer, published } = host();
    await initialize(peer, { url: service.url, token: TOKEN, account: "Miyoria AI" });
    const call = async (name: string, args: unknown) =>
      (await peer.request<{ content: string }>("tools.call", { name, args, context: toolContext }))
        .content;
    expect(
      await call("game.osu.act", {
        action: "play",
        args: { beatmap_id: 8, level: "hard", mods: ["hd"] },
      }),
    ).toBe("成功:正在準備下一張譜(10–40 秒),強度 hard");
    expect(service.requests.find((r) => r.path === "/solo")?.body).toEqual({
      beatmap_id: 8,
      level: "hard",
      mods: [{ acronym: "HD" }],
    });
    expect(await call("game.osu.observe", {})).toMatch(/^在多人房 7,強度 expert/);

    await waitFor(() => published.length >= 3);
    expect(published.map((p) => [p.topic, p.payload.data.text, p.payload.important])).toEqual([
      ["game.osu.started", "開始打 Soleily - Renatus [Hard]", true],
      ["game.osu.combo_break", "320 combo 斷了(miss 1,準度 99.10%)", true],
      ["game.osu.goal_reached", "打完 Soleily - Renatus [Hard]:99.12% S,miss 1", true],
    ]);
  });

  it("asks to come back when a map takes longer than the tool timeout", async () => {
    const service = await fakeService();
    const { peer } = host();
    await initialize(peer, {
      url: service.url,
      token: TOKEN,
      account: "Miyoria AI",
      request_timeout_ms: 200,
    });
    const { content } = await peer.request<{ content: string }>("tools.call", {
      name: "osu_ai.play_map",
      args: { beatmap_id: 999 },
      context: toolContext,
    });
    expect(content).toMatch(/^還在準備這張譜/);
  });

  it("reports a service that is down instead of throwing", async () => {
    const { peer } = host();
    await initialize(peer, { url: "http://127.0.0.1:1", token: TOKEN, account: "Miyoria AI" });
    const { content } = await peer.request<{ content: string }>("tools.call", {
      name: "osu_ai.status",
      args: {},
      context: toolContext,
    });
    expect(content).toMatch(/^失敗:連不到 osu! AI 服務/);
  });

  it.each([
    ["another account", "Owner", { account: "Miyoria AI" }, /不是設定的 AI 帳號/],
    [
      "a blocked account",
      "Owner",
      { account: "Owner", blocked_accounts: [" owner "] },
      /blocked_accounts/,
    ],
    ["no account configured", "Miyoria AI", {}, /沒有設定 AI 帳號/],
    ["a service not logged in", null, { account: "Miyoria AI" }, /還沒登入/],
  ])("refuses every tool when live.service runs with %s", async (_, user, extra, why) => {
    const service = await fakeService(user);
    const { peer } = host();
    await initialize(peer, { url: service.url, token: TOKEN, ...extra });
    for (const [name, args] of [
      ["osu_ai.status", {}],
      ["osu_ai.list_rooms", {}],
      ["osu_ai.join_room", { room_id: 7 }],
      ["osu_ai.play_map", { beatmap_id: 5 }],
      ["game.osu.act", { action: "play", args: { beatmap_id: 5 } }],
      ["game.osu.observe", {}],
    ] as const) {
      const { content } = await peer.request<{ content: string }>("tools.call", {
        name,
        args,
        context: toolContext,
      });
      expect(content).toMatch(why);
    }
    // Nothing but the account check ever reached it.
    expect(service.requests.every((r) => r.method === "GET" && r.path === "/status")).toBe(true);
  });
});

describe("accountProblem", () => {
  it("allows only the configured account, never a blocked one", () => {
    expect(accountProblem("Miyoria_AI", "miyoria_ai", ["owner"])).toBeNull();
    expect(accountProblem("owner", "owner", ["Owner"])).toMatch(/blocked_accounts/);
    expect(accountProblem("OWNER", "Miyoria_AI", ["owner"])).toMatch(/不能用的帳號/);
    expect(accountProblem("someone", "Miyoria_AI", [])).toMatch(/不是設定的 AI 帳號/);
    expect(accountProblem(undefined, "Miyoria_AI", [])).toMatch(/還沒登入/);
    expect(accountProblem("Miyoria_AI", "  ", [])).toMatch(/沒有設定/);
  });
});
