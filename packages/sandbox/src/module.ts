import { resolve } from "node:path";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import { customEvent, type ProfileId } from "@miyoria/types";
import { SandboxConfigSchema } from "./config.js";
import { ProposedTools, ProposedToolsKey } from "./proposed.js";
import { type DockerRunner, ProcessDockerRunner } from "./runner.js";
import { DockerSandbox } from "./sandbox.js";
import { SandboxKey } from "./types.js";

export interface SandboxModuleOptions {
  /** Directory `root` resolves against (the directory of `miyoria.toml`). */
  baseDir: string;
  /** Docker CLI runner; default spawns `config.docker` (tests inject a fake). */
  runner?: (executable: string) => DockerRunner;
}

/**
 * Module `sandbox`: provides `SandboxKey` (Docker code sandbox and the profile's tools
 * workspace) and, with the settings store, `ProposedToolsKey`. Opt-in (`enabled = true`).
 *
 * At start it checks Docker in the background, removes containers this instance left behind
 * and prunes old run workspaces. Without Docker the module runs degraded: `run` throws
 * `unavailable` and the health shows why, until Docker comes back (re-checked on use).
 *
 * Nothing is registered as an LLM tool here: `code.run` / `tool.propose` are high-risk
 * capabilities that phase A's gate registers (see `SANDBOX_CAPABILITIES`).
 */
export class SandboxModule implements Module {
  static readonly ID = "sandbox";
  readonly manifest = defineManifest(SandboxModule.ID, "Code sandbox", {
    description: "Runs code she writes in disposable, offline Docker containers",
    configSchema: SandboxConfigSchema,
  });
  #sandbox: DockerSandbox | null = null;

  constructor(
    readonly profile: ProfileId,
    readonly options: SandboxModuleOptions,
  ) {}

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(SandboxConfigSchema);
    const runner = (this.options.runner ?? ((exe) => new ProcessDockerRunner(exe)))(config.docker);
    const publisher = (topic: string, payload: Parameters<typeof customEvent>[1]) =>
      ctx.publish(customEvent(topic, payload));
    const sandbox = new DockerSandbox(config, {
      root: resolve(this.options.baseDir, config.root),
      profile: this.profile,
      runner,
      clock: ctx.clock,
      publisher,
    });
    this.#sandbox = sandbox;
    ctx.provide(SandboxKey, sandbox);
    const store = ctx.services.get(SettingsStoreKey);
    if (store) {
      ctx.provide(
        ProposedToolsKey,
        new ProposedTools({
          store,
          profile: this.profile,
          sandbox,
          clock: ctx.clock,
          publisher,
          maxTools: config.max_proposed_tools,
          maxCodeBytes: config.caps.max_code_bytes,
        }),
      );
    } else {
      ctx.log.warn("no settings store; proposed tools are unavailable");
    }

    ctx.spawn("startup", async (signal) => {
      try {
        const health = await sandbox.health({ signal, refresh: true });
        if (health.available) await sandbox.reap(signal);
        await sandbox.prune();
      } catch (error) {
        if (!signal.aborted)
          ctx.log.warn({ err: errorMessage(error) }, "sandbox startup checks failed");
      }
    });
  }

  async stop(): Promise<void> {
    const sandbox = this.#sandbox;
    this.#sandbox = null;
    await sandbox?.close();
  }

  async health(): Promise<Health> {
    const sandbox = this.#sandbox;
    if (!sandbox) return { status: "unhealthy", reason: "not running" };
    const health = sandbox.lastHealth;
    if (health.checked_at === null) return { status: "degraded", reason: "checking docker" };
    if (!health.available) {
      return { status: "degraded", reason: `docker unavailable: ${health.error ?? "unknown"}` };
    }
    return HEALTHY;
  }
}
