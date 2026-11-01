// The whole extension through the SDK runtime against a fake host and a fake mod.

import { PassThrough } from "node:stream";
import { type InitializeResult, RpcPeer, runExtension } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../src/index.js";
import { FakeMod, SNAPSHOT, waitFor } from "./fake-mod.js";

let mod: FakeMod | undefined;
let shutdown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  await mod?.stop();
  mod = undefined;
});

const context = { platform: "discord", scope: null, channel: "c1", kind: "voice" };
const toolContext = {
  turn: "01J00000000000000000000000",
  context,
  account: { platform: "discord", id: "42" },
  message: { context, id: "m1" },
  priority: "initiative",
};

function host() {
  const hostToExt = new PassThrough();
  const extToHost = new PassThrough();
  const published: Array<{ topic: string; payload: unknown }> = [];
  const runtime = runExtension(extension, { input: hostToExt, output: extToHost, exit: () => {}, timeoutMs: 2000 });
  const peer = new RpcPeer({
    input: extToHost,
    output: hostToExt,
    timeoutMs: 3000,
    onRequest: (method, params) => {
      if (method === "events.publish") published.push(params as { topic: string; payload: unknown });
      return {};
    },
    onNotification: () => {},
  });
  shutdown = () => runtime.shutdown();
  return { peer, published };
}

function initialize(peer: RpcPeer, config: Record<string, unknown>, game: string | null = "minecraft") {
  return peer.request<InitializeResult>("initialize", {
    protocol: 1,
    host: { name: "miyoria", version: "0.1.0" },
    extension: { id: "miyoria.minecraft", version: "0.1.0", dir: "/ext", game },
    config,
    permissions: { events: [], tools: true, commands: false, network: [], input: [] },
  });
}

describe("extension", () => {
  it("registers game.minecraft tools and publishes game events", async () => {
    mod = await FakeMod.start();
    mod.respond = (req) => (req.type === "observe" ? { ok: true, data: SNAPSHOT } : { ok: true, data: {} });
    const { peer, published } = host();
    const result = await initialize(peer, { url: mod.url, token: mod.token, reconnect_min_ms: 20 });
    expect(result.contributions.tools.map((t) => t.name)).toEqual(["game.minecraft.observe", "game.minecraft.act"]);
    expect(result.contributions.prompts).toEqual([]);
    const m = mod;
    await waitFor(() => m.hellos === 1);
    await waitFor(() => published.some((p) => p.topic === "game.minecraft.connected"));

    const call = (name: string, args: unknown) =>
      peer.request<{ content: string }>("tools.call", { name, args, context: toolContext });
    const observed = (await call("game.minecraft.observe", {})).content;
    expect(observed).toContain("血量 17.5/20");
    expect(observed).toContain('狀態:{"connected":true,"in_game":true,"busy":true');
    const acted = (await call("game.minecraft.act", { action: "goto", args: { x: 10, y: 64, z: 5 } })).content;
    expect(acted).toBe("成功:走到 (10, 64, 5)\n{}");
    expect(m.requests.at(-1)).toMatchObject({ type: "baritone", command: "goto", x: 10, y: 64, z: 5 });

    m.emit("death", { last_damage_source: "fall" });
    await waitFor(() => published.some((p) => p.topic === "game.minecraft.death"));
    expect(published.find((p) => p.topic === "game.minecraft.death")?.payload).toEqual({
      type: "death",
      data: { last_damage_source: "fall", text: "死掉了(摔落)" },
      important: true,
    });
  });

  it("fails activation when the manifest does not declare the game", async () => {
    const { peer } = host();
    await expect(initialize(peer, { url: "ws://127.0.0.1:1" }, null)).rejects.toMatchObject({
      message: expect.stringContaining('game = "minecraft"'),
    });
  });
});
