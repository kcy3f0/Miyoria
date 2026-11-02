// Stage Link protocol tests: `stage.link` on a real socket and a scripted Stage node.

import {
  CommandRegistry,
  CommandRegistryKey,
  commandName,
  Invocation,
  Permissions,
} from "@miyoria/commands";
import { EventBus, ServiceRegistry, type Subscription, Supervisor } from "@miyoria/kernel";
import {
  type ContextKey,
  customEvent,
  type Envelope,
  type Event,
  type JsonObject,
  newId,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  EMOTION_TOPIC,
  formatAddress,
  STATUS_TOPIC,
  STREAM_COMMAND_PATHS,
  type StageLink,
  StageLinkKey,
  StageLinkModule,
  VOICE_GOLIVE_TOPIC,
} from "../src/index.js";
import { delay, type Json, WAIT_MS, waitUntil } from "./common.js";

const TOKEN = "stage-secret";

class Harness {
  private constructor(
    readonly sup: Supervisor,
    readonly services: ServiceRegistry,
    readonly bus: EventBus,
    readonly module: StageLinkModule,
  ) {}

  static async start(config: JsonObject = {}): Promise<Harness> {
    const services = new ServiceRegistry();
    services.provide("commands", CommandRegistryKey, new CommandRegistry(new Permissions()));
    const bus = new EventBus();
    const sup = new Supervisor({ bus, services });
    const module = new StageLinkModule();
    await sup.register(module, { bind: "127.0.0.1:0", token: TOKEN, ...config }, true);
    await sup.startAll();
    const h = new Harness(sup, services, bus, module);
    harnesses.push(h);
    return h;
  }

  url(): string {
    const addr = this.module.localAddr();
    if (!addr) throw new Error("not running");
    return `ws://${formatAddress(addr)}/stage-link`;
  }

  link(): StageLink {
    return this.services.require(StageLinkKey);
  }

  registry(): CommandRegistry {
    return this.services.require(CommandRegistryKey);
  }

  subscribe(topics: string[]): Subscription {
    return this.bus.subscribe(topics);
  }

  publish(event: Event): void {
    this.bus.publish("test", event);
  }

  async node(): Promise<Node> {
    const node = await Node.connect(this.url());
    node.hello(TOKEN);
    const welcome = await node.recvJson();
    expect(welcome.type, JSON.stringify(welcome)).toBe("welcome");
    const link = this.link();
    await waitUntil(() => link.isConnected());
    return node;
  }
}

const harnesses: Harness[] = [];
const nodes: Node[] = [];
afterEach(async () => {
  for (const n of nodes.splice(0)) n.ws.terminate();
  for (const h of harnesses.splice(0)) await h.sup.stopAll();
});

async function nextEvent(sub: Subscription): Promise<Envelope> {
  const env = await Promise.race([sub.recv(), delay(WAIT_MS).then(() => null)]);
  if (!env) throw new Error("no event in time");
  return env;
}

/** A scripted Stage node. */
class Node {
  readonly #queue: Json[] = [];
  #close: number | null = null;
  readonly #waiters = new Set<() => void>();

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const v = JSON.parse(data.toString());
      if (v.type === "ping") {
        this.sendJson({ type: "pong" });
        return;
      }
      this.#queue.push(v);
      this.#wake();
    });
    ws.on("close", (code) => {
      this.#close = code;
      this.#wake();
    });
    ws.on("error", () => {});
  }

  #wake(): void {
    for (const w of [...this.#waiters]) w();
  }

  static connect(url: string): Promise<Node> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const node = new Node(ws);
      nodes.push(node);
      ws.once("open", () => resolve(node));
      ws.once("error", reject);
    });
  }

  sendJson(value: unknown): void {
    this.ws.send(JSON.stringify(value));
  }

  hello(token: string): void {
    this.sendJson({
      type: "hello",
      version: 1,
      token,
      node: "test-stage",
      capabilities: ["vts", "obs"],
    });
  }

  async #wait<T>(take: () => T | undefined, what: string): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const v = take();
      if (v !== undefined) return v;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${what} in time`);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.#waiters.add(done);
      });
    }
  }

  /** Next JSON message (pings are answered). */
  recvJson(): Promise<Json> {
    return this.#wait(() => {
      if (this.#queue.length > 0) return this.#queue.shift();
      if (this.#close !== null) throw new Error(`socket closed (${this.#close})`);
      return undefined;
    }, "message");
  }

  expectClose(): Promise<number> {
    return this.#wait(() => this.#close ?? undefined, "close");
  }
}

const voiceCtx = (): ContextKey => ({
  platform: "discord",
  scope: "g1",
  channel: "vc1",
  kind: "voice",
});

function invocation(path: string): Invocation {
  const inv = Invocation.create(
    path,
    { platform: "discord", id: "7" },
    { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
  );
  // Starting and stopping the stream needs `stream.start` / `stream.stop` (admin).
  inv.invoker_is_guild_admin = true;
  return inv;
}

/** Answers the next request with `status`; returns the request. */
async function answer(node: Node, status: JsonObject): Promise<Json> {
  const req = await node.recvJson();
  node.sendJson({ ...status, id: req.id, type: "status" });
  return req;
}

describe("stage.link", () => {
  it("empty_token_fails_to_start", async () => {
    const h = await Harness.start({ token: "" });
    let state: ReturnType<Supervisor["list"]>[number] | undefined;
    await waitUntil(() => {
      state = h.sup.list().find((s) => s.id === "stage.link");
      return state?.state === "failed";
    });
    expect(state?.reason).toContain("STAGE_LINK_TOKEN");
    expect(h.services.has(StageLinkKey)).toBe(false);
  });

  it("hello_is_authenticated_and_newer_node_wins", async () => {
    const h = await Harness.start({ hello_timeout_ms: 300 });

    const wrong = await Node.connect(h.url());
    wrong.hello("nope");
    expect(await wrong.expectClose()).toBe(4401);

    const old = await Node.connect(h.url());
    old.sendJson({ type: "hello", version: 9, token: TOKEN });
    expect(await old.expectClose()).toBe(4400);

    const silent = await Node.connect(h.url());
    expect(await silent.expectClose()).toBe(4400);
    expect(h.link().isConnected()).toBe(false);

    const status = h.subscribe([STATUS_TOPIC]);
    const first = await h.node();
    const link = h.link();
    expect(link.node()).toStrictEqual(["test-stage", ["vts", "obs"]]);
    const env = await nextEvent(status);
    expect(env.event).toStrictEqual(
      customEvent(STATUS_TOPIC, {
        connected: true,
        vts: false,
        obs: false,
        scene: null,
        streaming: false,
        scenes: [],
        hotkeys: [],
        overlay_url: null,
      }),
    );
    expect(env.source).toBe("stage.link");

    first.sendJson({ type: "status", vts: true, obs: true, scene: "Talk", streaming: false });
    await waitUntil(() => (link.status()?.vts ?? false) && (link.status()?.obs ?? false));
    expect(link.status()?.scene).toBe("Talk");

    await h.node();
    expect(await first.expectClose()).toBe(4409);
    expect(link.isConnected()).toBe(true);
  });

  it("forwards_emotions_speaking_and_subtitles", async () => {
    const h = await Harness.start();
    const node = await h.node();
    const turn = newId();

    h.publish(customEvent(EMOTION_TOPIC, { turn, context: { ...voiceCtx() }, emotion: "annoyed" }));
    expect(await node.recvJson()).toStrictEqual({ type: "emotion", name: "annoyed", intensity: 1 });

    h.publish({
      type: "voice_playback",
      data: { context: voiceCtx(), turn, state: "started", text: "哼," },
    });
    expect(await node.recvJson()).toStrictEqual({ type: "speaking", state: "started" });
    expect(await node.recvJson()).toStrictEqual({
      type: "subtitle",
      turn,
      text: "哼,",
      final: false,
    });
    h.publish({ type: "agent_turn_completed", data: { turn, context: voiceCtx(), text: "哼," } });
    h.publish({
      type: "voice_playback",
      data: { context: voiceCtx(), turn, state: "finished", text: "哼," },
    });
    expect(await node.recvJson()).toStrictEqual({ type: "speaking", state: "stopped" });
    expect(await node.recvJson()).toStrictEqual({
      type: "subtitle",
      turn,
      text: "哼,",
      final: true,
    });

    h.link().gaze("game");
    expect(await node.recvJson()).toStrictEqual({ type: "gaze", target: "game" });
  });

  it("follows_go_live_with_obs", async () => {
    const h = await Harness.start({ golive_start_delay_ms: 0 });
    const node = await h.node();
    node.sendJson({ type: "status", vts: true, obs: true, scene: "Talk", streaming: false });
    await waitUntil(() => h.link().status()?.obs === true);

    // The voice node started Go Live: Stage presses OBS "Start Streaming".
    h.publish(customEvent(VOICE_GOLIVE_TOPIC, { guild: "g1", state: "starting" }));
    const start = await node.recvJson();
    expect(start.type).toBe("stream");
    expect(start.action).toBe("start");
    node.sendJson({
      type: "status",
      vts: true,
      obs: true,
      scene: "Talk",
      streaming: true,
      id: start.id,
    });
    await waitUntil(() => h.link().status()?.streaming === true);

    // "live" does not touch OBS again.
    h.publish(customEvent(VOICE_GOLIVE_TOPIC, { guild: "g1", state: "live" }));
    // Go Live ended: Stage presses OBS "Stop Streaming".
    h.publish(customEvent(VOICE_GOLIVE_TOPIC, { guild: "g1", state: "stopped" }));
    const stop = await node.recvJson();
    expect(stop.type).toBe("stream");
    expect(stop.action).toBe("stop");
    node.sendJson({
      type: "status",
      vts: true,
      obs: true,
      scene: "Talk",
      streaming: false,
      id: stop.id,
    });
    await waitUntil(() => h.link().status()?.streaming === false);
  });

  it("requests_are_answered_by_id", async () => {
    const h = await Harness.start({ request_timeout_ms: 500 });
    const link = h.link();
    await expect(link.setScene("Game"), "no node yet").rejects.toThrow("not connected");
    expect(() => link.gaze("chat")).toThrow("not connected");
    const node = await h.node();

    let pending = link.setScene("Game");
    let req = await node.recvJson();
    expect(req.type).toBe("scene");
    expect(req.name).toBe("Game");
    node.sendJson({
      type: "status",
      vts: false,
      obs: true,
      scene: "Game",
      streaming: false,
      id: req.id,
    });
    expect((await pending).scene).toBe("Game");

    pending = link.stream("start");
    req = await node.recvJson();
    expect(req.type).toBe("stream");
    expect(req.action).toBe("start");
    const errors = h.subscribe(["stage.error"]);
    node.sendJson({ type: "error", message: "OBS is not connected", id: req.id });
    await expect(pending).rejects.toThrow("OBS is not connected");
    expect((await nextEvent(errors)).event).toStrictEqual(
      customEvent("stage.error", { message: "OBS is not connected" }),
    );

    // Unanswered requests time out.
    await expect(link.hotkey("Wave")).rejects.toThrow("in time");
    expect((await node.recvJson()).type).toBe("avatar_hotkey");

    // A disconnect fails pending requests.
    pending = link.refreshStatus();
    expect((await node.recvJson()).type).toBe("status_request");
    node.ws.close();
    await expect(pending).rejects.toThrow("stage node disconnected");
    await waitUntil(() => !link.isConnected());
    expect(link.status()).toBeNull();
  });

  it("stream_commands", async () => {
    const h = await Harness.start();
    const registry = h.registry();
    let reply = await registry.dispatch(invocation("stream status"));
    expect(reply.text).toContain("直播機目前沒有連線");

    const node = await h.node();

    let call = registry.dispatch(invocation("stream start"));
    let req = await answer(node, { vts: true, obs: true, scene: "Talk", streaming: true });
    expect(req.action).toBe("start");
    reply = await call;
    expect(registry.get(["stream", "start"])?.ephemeral).toBe(false);
    expect(reply.text).toBe("已開始直播。");

    call = registry.dispatch(invocation("stream scene").withArg("name", "Game"));
    req = await answer(node, { vts: true, obs: true, scene: "Game", streaming: true });
    expect(req.name).toBe("Game");
    expect((await call).text).toContain("Game");

    call = registry.dispatch(invocation("stream status"));
    req = await answer(node, { vts: false, obs: true, scene: "Game", streaming: true });
    expect(req.type).toBe("status_request");
    reply = await call;
    expect(registry.get(["stream", "status"])?.ephemeral).toBe(true);
    expect(reply.text).toContain("直播中");
    expect(reply.text).toContain("Game");

    const paths = registry.specs().map((s) => commandName(s));
    for (const p of STREAM_COMMAND_PATHS) expect(paths, `${p} registered`).toContain(p);
    expect(registry.get(["stream", "start"])?.permission).toBe("stream.start");
    expect(registry.groupDescription("stream")).toContain("OBS");
    expect(registry.get(["stream", "scene"])?.args[0]?.autocomplete).toBe(true);
    expect(await registry.autocomplete(invocation("stream scene"), "name", "ga")).toEqual([
      { name: "Game", value: "Game" },
    ]);

    await h.sup.stopAll();
    for (const p of STREAM_COMMAND_PATHS) {
      expect(registry.get(p.split(" ")), `${p} unregistered on stop`).toBeUndefined();
    }
  });

  it("stop_closes_the_node_with_going_away_and_heartbeat_times_out", async () => {
    let h = await Harness.start();
    let node = await h.node();
    await h.sup.stopAll();
    expect(await node.expectClose()).toBe(1001);
    expect(h.module.localAddr()).toBeNull();
    const health = await h.module.health();
    expect(health).toStrictEqual({ status: "healthy" });

    // A silent node is dropped with 4408; pings come every ping_interval_ms.
    h = await Harness.start({ peer_timeout_ms: 300, ping_interval_ms: 100 });
    expect(await h.module.health()).toStrictEqual({
      status: "degraded",
      reason: "stage node not connected",
    });
    node = await Node.connect(h.url());
    node.ws.removeAllListeners("message");
    let pings = 0;
    node.ws.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "ping") pings++;
    });
    node.hello(TOKEN);
    expect(await node.expectClose()).toBe(4408);
    expect(pings).toBeGreaterThanOrEqual(1);
  });
});
