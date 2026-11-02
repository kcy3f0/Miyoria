import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposedToolsKey, SandboxKey, SandboxModule } from "../src/index.js";
import { FakeRunner } from "./fake-runner.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "miyoria-sandbox-module-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("SandboxModule", () => {
  it("provides_services_reaps_and_reports_health", async () => {
    const runner = new FakeRunner();
    runner.psOutput = "0123456789ab\n";
    const module = new SandboxModule("deepseek-chan", { baseDir: base, runner: () => runner });
    const sup = new Supervisor();
    sup.services.provide("app", SettingsStoreKey, new MemorySettingsStore());
    await sup.register(module, { root: "sbx" }, true);
    await sup.startAll();
    expect(sup.services.has(SandboxKey)).toBe(true);
    expect(sup.services.has(ProposedToolsKey)).toBe(true);
    await waitFor(() => runner.calledWith("rm").length > 0);
    expect(runner.calledWith("rm")).toEqual([["rm", "-f", "0123456789ab"]]);
    expect(await module.health()).toEqual({ status: "healthy" });
    expect(sup.services.require(SandboxKey).tools).toMatchObject({
      dir: join(base, "sbx", "profiles", "deepseek-chan", "tools"),
    });
    await sup.stopAll();
    expect(sup.services.get(SandboxKey)).toBeUndefined();
  });

  it("runs_degraded_without_docker", async () => {
    const runner = new FakeRunner();
    runner.dockerUp = false;
    const module = new SandboxModule("deepseek-chan", { baseDir: base, runner: () => runner });
    const sup = new Supervisor();
    await sup.register(module, null, true);
    await sup.startAll();
    await waitFor(() => runner.calledWith("version").length > 0);
    await waitFor(() => module.health !== undefined && sup.list()[0]?.state === "running");
    const health = await module.health();
    expect(health.status).toBe("degraded");
    // No settings store: no proposed tools, the sandbox itself still exists.
    expect(sup.services.has(ProposedToolsKey)).toBe(false);
    const error = await sup.services
      .require(SandboxKey)
      .run({ language: "python", code: "print(1)" })
      .catch((e: unknown) => e);
    expect((error as { kind: string }).kind).toBe("unavailable");
    expect(runner.calledWith("ps")).toHaveLength(0);
    await sup.stopAll();
  });
});
