// The whole extension through the SDK runtime against a fake host and a fake live.service.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { type InitializeResult, RpcPeer, runExtension } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../src/index.js";

const TOKEN = "test-token-0123456789";
const context = { platform: "discord", scope: null, channel: "c1", kind: "voice" };
const toolContext = {
  turn: "01J00000000000000000000000",
  context,
  account: { platform: "discord", id: "42" },
  message: { context, id: "m1" },
  priority: "normal",
};

let server: Server | undefined;
let shutdown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  const s = server;
  if (s) await new Promise((resolve) => s.close(resolve));
  server = undefined;
});

/** Fake live.service: records requests, answers like the real one. */
async function fakeService() {
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
      if (req.url === "/join") return reply(400, { error: "already_in_room" });
      if (req.url === "/play")
        return reply(200, { accuracy: 0.99, rank: "S", replay_url: "/replays/abc.osr" });
      return reply(200, { room: 7, level: "expert", ready: true });
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
  const peer = new RpcPeer({
    input: extToHost,
    output: hostToExt,
    timeoutMs: 3000,
    onRequest: () => ({}),
    onNotification: () => {},
  });
  shutdown = () => runtime.shutdown();
  return peer;
}

function initialize(peer: RpcPeer, config: Record<string, unknown>) {
  return peer.request<InitializeResult>("initialize", {
    protocol: 1,
    host: { name: "miyoria", version: "0.1.0" },
    extension: { id: "miyoria.osu", version: "0.1.0", dir: "/ext", game: null },
    config,
    permissions: { events: [], tools: true, commands: false, network: [], input: [] },
  });
}

describe("extension", () => {
  it("turns the live.service API into tools", async () => {
    const service = await fakeService();
    const peer = host();
    const result = await initialize(peer, {
      url: service.url,
      token: TOKEN,
      public_url: "https://ai.example",
    });
    const tools = result.contributions.tools;
    expect(tools.map((t) => t.name)).toEqual([
      "osu_ai.status",
      "osu_ai.list_rooms",
      "osu_ai.join_room",
      "osu_ai.leave_room",
      "osu_ai.set_level",
      "osu_ai.play_map",
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
    expect(service.requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ["GET", "/status", null],
      ["POST", "/join", { room_id: 7 }],
      ["POST", "/play", { beatmap_id: 5, mods: [{ acronym: "HD" }] }],
    ]);
    expect(service.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("reports a service that is down instead of throwing", async () => {
    const peer = host();
    await initialize(peer, { url: "http://127.0.0.1:1", token: TOKEN });
    const { content } = await peer.request<{ content: string }>("tools.call", {
      name: "osu_ai.status",
      args: {},
      context: toolContext,
    });
    expect(content).toMatch(/^失敗:連不到 osu! AI 服務/);
  });
});
