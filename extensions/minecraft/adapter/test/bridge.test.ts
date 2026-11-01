import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeClient, type BridgeError, type BridgeEvent } from "../src/bridge.js";
import { resolveEndpoint } from "../src/config.js";
import { FakeMod, waitFor } from "./fake-mod.js";

let mod: FakeMod | undefined;
let client: BridgeClient | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  await mod?.stop();
  mod = undefined;
});

function connect(m: FakeMod, token = m.token, extra: Partial<ConstructorParameters<typeof BridgeClient>[0]> = {}) {
  client = new BridgeClient({
    endpoint: () => ({ url: m.url, token }),
    reconnectMinMs: 20,
    reconnectMaxMs: 80,
    requestTimeoutMs: 300,
    ...extra,
  });
  client.start();
  return client;
}

describe("resolveEndpoint", () => {
  it("reads port and token from the mod config file, config wins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-"));
    const cfgDir = join(dir, "config");
    mkdirSync(cfgDir);
    writeFileSync(join(cfgDir, "miyoria-bridge.json"), JSON.stringify({ port: 7999, token: "from-file" }));
    expect(await resolveEndpoint({ minecraft_dir: dir }, {})).toEqual({ url: "ws://127.0.0.1:7999", token: "from-file" });
    expect(await resolveEndpoint({}, { MIYORIA_MC_DIR: dir, MIYORIA_MC_TOKEN: "env" })).toEqual({
      url: "ws://127.0.0.1:7999",
      token: "env",
    });
    expect(await resolveEndpoint({ minecraft_dir: dir, port: 8000, token: "cfg" }, {})).toEqual({
      url: "ws://127.0.0.1:8000",
      token: "cfg",
    });
    expect(await resolveEndpoint({}, {})).toEqual({ url: "ws://127.0.0.1:7890", token: "" });
  });
});

describe("BridgeClient", () => {
  it("authenticates and correlates requests", async () => {
    mod = await FakeMod.start();
    mod.respond = (req) =>
      req.type === "ping" ? { ok: true, data: { time: 1 } } : { ok: false, code: "invalid_args", message: "nope" };
    const statuses: unknown[] = [];
    const c = connect(mod);
    c.onStatus((h) => statuses.push(h?.minecraft ?? null));
    await waitFor(() => c.ready);
    expect(c.hello?.capabilities?.baritone).toBe(true);
    expect(statuses).toEqual(["1.21.1"]);
    const [a, b] = await Promise.allSettled([c.request("ping"), c.request("look", { yaw: 1 })]);
    expect(a).toEqual({ status: "fulfilled", value: { time: 1 } });
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason).toMatchObject({ code: "invalid_args", message: "nope" });
    expect(mod.requests[1]).toMatchObject({ type: "look", yaw: 1 });
    expect(typeof mod.requests[1]?.id).toBe("string");
  });

  it("fails fast when disconnected and times out silent requests", async () => {
    mod = await FakeMod.start();
    const c = new BridgeClient({ endpoint: () => ({ url: "ws://127.0.0.1:1", token: "x" }) });
    await expect(c.request("observe")).rejects.toMatchObject({ code: "not_connected" });
    mod.respond = () => "silent";
    const live = connect(mod);
    await waitFor(() => live.ready);
    await expect(live.request("observe")).rejects.toMatchObject({ code: "timeout" });
  });

  it("forwards pushed events", async () => {
    mod = await FakeMod.start();
    const c = connect(mod);
    const events: BridgeEvent[] = [];
    c.onEvent((e) => events.push(e));
    await waitFor(() => c.ready);
    mod.emit("damage", { amount: 3, source: "mob", attacker: "zombie", health: 14 });
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ name: "damage", data: { attacker: "zombie" } });
  });

  it("reconnects after the connection drops and fails pending requests", async () => {
    mod = await FakeMod.start();
    mod.respond = () => "silent";
    const c = connect(mod, mod.token, { requestTimeoutMs: 5000 });
    const statuses: Array<string | null> = [];
    c.onStatus((h) => statuses.push(h ? "up" : null));
    await waitFor(() => c.ready);
    const pending = c.request("observe");
    mod.kick();
    await expect(pending).rejects.toMatchObject({ code: "not_connected" });
    await waitFor(() => mod?.hellos === 2);
    await waitFor(() => c.ready);
    expect(statuses).toEqual(["up", null, "up"]);
  });

  it("keeps retrying a refused token and picks up a new one", async () => {
    mod = await FakeMod.start();
    let token = "wrong-token-000000";
    const m = mod;
    const warnings: string[] = [];
    client = new BridgeClient({
      endpoint: () => ({ url: m.url, token }),
      reconnectMinMs: 20,
      reconnectMaxMs: 40,
      log: { info: () => {}, warn: (message) => warnings.push(message) },
    });
    client.start();
    const c = client;
    await new Promise((r) => setTimeout(r, 120));
    expect(c.ready).toBe(false);
    expect(warnings.some((w) => w.includes("token"))).toBe(true);
    token = m.token;
    await waitFor(() => c.ready);
  });

  it("starts while the mod is not up yet", async () => {
    const probe = await FakeMod.start();
    const port = probe.port;
    await probe.stop();
    client = new BridgeClient({
      endpoint: () => ({ url: `ws://127.0.0.1:${port}`, token: "secret-token-1234" }),
      reconnectMinMs: 20,
      reconnectMaxMs: 40,
    });
    client.start();
    await new Promise((r) => setTimeout(r, 60));
    mod = await FakeMod.start(port);
    const c = client;
    await waitFor(() => c.ready);
  });

  it("close stops reconnecting", async () => {
    mod = await FakeMod.start();
    const c = connect(mod);
    await waitFor(() => c.ready);
    c.close();
    expect(c.ready).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(mod.hellos).toBe(1);
    const err = (await c.request("ping").catch((e: unknown) => e)) as BridgeError;
    expect(err.code).toBe("not_connected");
  });
});
