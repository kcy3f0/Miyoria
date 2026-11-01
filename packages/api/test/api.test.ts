// End-to-end tests: a real supervisor running the `api` module on a random port, in-memory
// stores and a persona loaded from a temp profile dir, driven through `ApiClient`
// (`tests/api.rs`).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonaHandle, PersonaHandleKey } from "@miyoria/agent";
import { Supervisor, SupervisorKey } from "@miyoria/kernel";
import { LlmRouter, LlmRouterKey, MIYORIA_VERSION } from "@miyoria/llm";
import { Profile } from "@miyoria/profile";
import { AuditLogKey, DecisionLogKey, PersonaOverrideStoreKey } from "@miyoria/store";
import { type ContextKey, newId, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiClient, ApiModule } from "../src/index.js";
import { Idle } from "./support/fakes.js";
import { raw, statusOf, waitFor } from "./support/http.js";
import { TestStore } from "./support/stores.js";

const TOKEN = "test-token";
const PROFILE = "test-chan";

interface Harness {
  sup: Supervisor;
  store: TestStore;
  persona: PersonaHandle;
  client: ApiClient;
  base: string;
  dir: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.sup.stopAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

async function writeProfile(dir: string): Promise<Profile> {
  const root = join(dir, PROFILE);
  mkdirSync(join(root, "persona"), { recursive: true });
  writeFileSync(join(root, "profile.toml"), `id = "${PROFILE}"\ndisplay_name = "Test"\n`);
  writeFileSync(join(root, "persona/identity.md"), "I am Test.\n");
  writeFileSync(join(root, "persona/style.md"), "Be brief.\n");
  return Profile.load(dir, PROFILE);
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "miyoria-api-"));
  const persona = new PersonaHandle(await writeProfile(dir));
  const sup = new Supervisor();
  const store = new TestStore();
  const k = "kernel";
  sup.services.provide(k, DecisionLogKey, store.decisions);
  sup.services.provide(k, PersonaOverrideStoreKey, store.personaOverrides);
  sup.services.provide(k, AuditLogKey, store.audit);
  sup.services.provide(k, ActiveProfileKey, PROFILE);
  sup.services.provide(k, PersonaHandleKey, persona);
  sup.services.provide("llm", LlmRouterKey, new LlmRouter(new Map(), new Map()));
  // The app provides the supervisor as a service.
  sup.services.provide(k, SupervisorKey, sup);

  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN }, true);
  await sup.register(new Idle("dummy", "Dummy"), null, true);
  await sup.startAll();

  const base = api.url();
  if (!base) throw new Error("api is not running");
  const h = { sup, store, persona, client: new ApiClient(base, TOKEN), base, dir };
  harnesses.push(h);
  return h;
}

describe("api", () => {
  it("health_and_auth", async () => {
    const h = await harness();
    const anon = new ApiClient(h.base, "wrong");

    const health = await anon.health();
    expect(health.status).toBe("ok");
    expect(health.version).toBe(MIYORIA_VERSION);

    expect(await statusOf(anon.modules())).toBe(401);

    const unauthorized = await raw(h.base, "GET", "/api/modules");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");
    expect((unauthorized.body as { error: string }).error).toContain("token");

    const missing = await raw(h.base, "GET", "/api/nope");
    expect(missing.status).toBe(404);
    expect(typeof (missing.body as { error: unknown }).error).toBe("string");
  });

  it("module_lifecycle", async () => {
    const h = await harness();
    const c = h.client;

    const modules = await c.modules();
    expect(modules.map((m) => m.id)).toEqual(["api", "dummy"]);
    expect(modules.every((m) => m.state === "running")).toBe(true);

    let m = await c.moduleAction("dummy", "disable");
    expect([m.enabled, m.state]).toEqual([false, "disabled"]);
    expect(await statusOf(c.moduleAction("dummy", "restart"))).toBe(409);
    m = await c.moduleAction("dummy", "enable");
    expect([m.enabled, m.state]).toEqual([true, "running"]);
    m = await c.moduleAction("dummy", "restart");
    expect(m.state).toBe("running");

    for (const action of ["disable", "restart"]) {
      expect(await statusOf(c.moduleAction("api", action)), `${action} api`).toBe(409);
    }
    expect(await statusOf(c.moduleAction("ghost", "enable"))).toBe(404);
    expect(await statusOf(c.moduleAction("dummy", "explode"))).toBe(404);

    // Still serving after all of that.
    expect(await c.modules()).toHaveLength(2);
  });

  it("persona_edit_and_history", async () => {
    const h = await harness();
    const c = h.client;

    const sections = await c.persona();
    expect(sections.map((s) => [s.key, s.body])).toEqual([
      ["identity", "I am Test."],
      ["style", "Be brief."],
    ]);

    expect(await c.setPersona("style", "Be very brief.")).toBe(1);
    expect(await c.setPersonaAs("style", "Be terse.", "panel:owen")).toBe(2);
    expect(h.persona.personaPrompt()).toContain("Be terse.");
    const style = (await c.persona()).find((s) => s.key === "style");
    expect(style?.body).toBe("Be terse.");

    const history = await c.personaHistory("style");
    expect(history.map((o) => [o.version, o.edited_by])).toEqual([
      [1, "api"],
      [2, "panel:owen"],
    ]);
    const audit = await h.store.audit.recent(10, "api");
    expect(
      audit.map((e) => [e.action, e.target, (e.detail as { version: number }).version]),
    ).toEqual([
      ["persona.set", "style", 2],
      ["persona.set", "style", 1],
    ]);
    const current = await h.store.personaOverrides.current(PROFILE);
    expect(current.get("style")).toBe("Be terse.");

    expect(await statusOf(c.setPersona("bad key", "x"))).toBe(400);
  });

  function context(channel: string): ContextKey {
    return { platform: "discord", scope: "guild", channel, kind: "channel" };
  }

  it("decisions_newest_first", async () => {
    const h = await harness();
    for (const [i, channel] of ["a", "b", "a"].entries()) {
      await h.store.decisions.append({
        id: newId(),
        profile: PROFILE,
        ts: toTimestamp((1_700_000_000 + i) * 1000),
        trace: {
          turn: newId(),
          context: context(channel),
          respond: i % 2 === 0,
          score: i,
          reasons: [`#${i}`],
        },
      });
    }

    const all = await h.client.decisions(50);
    expect(all.map((d) => d.trace.reasons[0])).toEqual(["#2", "#1", "#0"]);
    expect(await h.client.decisions(1)).toHaveLength(1);

    const inA = await h.client.decisionsIn(context("a"), 50);
    expect(inA).toHaveLength(2);
    expect(inA.every((d) => d.trace.context.channel === "a")).toBe(true);

    const bad = await raw(h.base, "GET", "/api/decisions?context=nope", { token: TOKEN });
    expect(bad.status).toBe(400);
  });

  it("usage_and_missing_service", async () => {
    const h = await harness();
    expect((await h.client.usage()).size).toBe(0);

    h.sup.services.removeOwnedBy("llm");
    expect(await statusOf(h.client.usage())).toBe(503);
  });

  it("events_stream_until_stop", async () => {
    const h = await harness();
    const events = await h.client.events(["system.*"]);

    await h.client.moduleAction("dummy", "disable");
    const first = await events.next();
    expect(first.done).toBe(false);
    expect(first.value?.event).toMatchObject({
      type: "module_state_changed",
      data: { module: "dummy" },
    });

    // Stopping the module ends the stream (and lets the server shut down).
    const drained = (async () => {
      for await (const _ of events) {
        // drain
      }
      return true;
    })();
    await h.sup.stopAll();
    const ended = await Promise.race([
      drained,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    expect(ended, "event stream did not end on stop").toBe(true);
  });

  async function waitFailed(sup: Supervisor): Promise<string> {
    return waitFor(() => {
      const api = sup.list().find((m) => m.id === ApiModule.ID);
      return api?.state === "failed" ? (api.reason ?? "") : null;
    });
  }

  it("start_failures", async () => {
    const empty = new Supervisor();
    await empty.register(new ApiModule(), { token: "" }, true);
    await empty.startAll();
    expect(await waitFailed(empty)).toContain("MIYORIA_API_TOKEN");
    await empty.stopAll();

    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const address = taken.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    try {
      const sup = new Supervisor();
      await sup.register(
        new ApiModule(),
        { bind: `127.0.0.1:${address.port}`, token: TOKEN },
        true,
      );
      await sup.startAll();
      expect(await waitFailed(sup)).toContain("cannot bind");
      await sup.stopAll();
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });
});
