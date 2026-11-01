import {
  defineManifest,
  EventBus,
  type Module,
  type ModuleContext,
  ServiceRegistry,
  Supervisor,
  SupervisorKey,
} from "@miyoria/kernel";
import { type AuditEntry, type AuditLog, AuditLogKey } from "@miyoria/store";
import { type Authorizer, AuthorizerKey, type ModuleStateKind } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  type CommandRegistry,
  CommandRegistryKey,
  CommandsConfigSchema,
  CommandsModule,
  formatModuleList,
  parseAccount,
} from "../src/index.js";
import { guildContext, inv } from "./helpers.js";

class Dummy implements Module {
  readonly manifest = defineManifest("dummy", "Dummy");

  async start(ctx: ModuleContext): Promise<void> {
    ctx.spawn(
      "idle",
      (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve())),
    );
  }
}

async function boot(): Promise<{ sup: Supervisor; reg: CommandRegistry }> {
  const services = new ServiceRegistry();
  const sup = new Supervisor({ bus: new EventBus(), services });
  services.provide("app", SupervisorKey, sup);
  await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
  await sup.register(new Dummy(), null, true);
  await sup.startAll();
  return { sup, reg: services.require(CommandRegistryKey) };
}

function state(sup: Supervisor, id: string): ModuleStateKind | undefined {
  return sup.list().find((s) => s.id === id)?.state;
}

const inGuild = (path: string, invoker: string, args: Record<string, string> = {}) =>
  inv(path, invoker, args, guildContext);

describe("commands module", () => {
  it("builtins_are_registered", async () => {
    const { sup, reg } = await boot();
    expect(reg.specs().map((s) => s.path.join(" "))).toEqual([
      "admin module disable",
      "admin module enable",
      "admin module list",
      "admin module restart",
      "ping",
    ]);
    expect(reg.groupDescription("admin")).toBe("管理指令");
    expect(reg.groupDescription("admin module")).toBe("管理模組");
    const pong = await reg.dispatch(inGuild("ping", "5"));
    expect(pong.text.startsWith("pong")).toBe(true);
    expect(pong.ephemeral).toBe(false);
    const auth = sup.services.require(AuthorizerKey);
    expect(auth.allows(parseAccount("discord:1"), "admin.x")).toBe(true);
    expect(auth.allows(parseAccount("discord:5"), "admin.x")).toBe(false);
    await sup.stopAll();
    expect(sup.services.get(AuthorizerKey)).toBeUndefined();
  });

  it("admin_module_commands", async () => {
    const { sup, reg } = await boot();

    const denied = await reg.dispatch(inGuild("admin module disable", "5", { id: "dummy" }));
    expect(denied.ephemeral).toBe(true);
    expect(denied.text).toContain("權限");
    expect(state(sup, "dummy")).toBe("running");

    const list = await reg.dispatch(inGuild("admin module list", "1"));
    expect(list.ephemeral).toBe(true);
    expect(list.text).toContain("`dummy` (Dummy): running");

    await reg.dispatch(inGuild("admin module disable", "1", { id: "dummy" }));
    expect(state(sup, "dummy")).toBe("disabled");

    const admin = inGuild("admin module enable", "5", { id: "dummy" });
    admin.invoker_is_guild_admin = true;
    const enabled = await reg.dispatch(admin);
    expect(enabled.text).toContain("啟用了");
    expect(state(sup, "dummy")).toBe("running");

    const restarted = await reg.dispatch(inGuild("admin module restart", "1", { id: "dummy" }));
    expect(restarted.text).toContain("重新啟動好了");
    expect(state(sup, "dummy")).toBe("running");

    const unknown = await reg.dispatch(inGuild("admin module enable", "1", { id: "ghost" }));
    expect(unknown.text).toContain("失敗");
    expect(unknown.text).toContain("unknown module `ghost`");

    const protectedModule = await reg.dispatch(
      inGuild("admin module disable", "1", { id: "commands" }),
    );
    expect(protectedModule.text).toContain("CLI");
    expect(state(sup, "commands")).toBe("running");

    const missingArg = await reg.dispatch(inGuild("admin module enable", "1"));
    expect(missingArg.text).toContain("少了「id」");
    await sup.stopAll();
  });

  it("restarting_commands_provides_a_fresh_registry", async () => {
    const { sup, reg } = await boot();
    await reg.dispatch(inGuild("admin module restart", "1", { id: "commands" }));
    const fresh = sup.services.require(CommandRegistryKey);
    expect(fresh).not.toBe(reg);
    expect(fresh.specs()).toHaveLength(5);
    await sup.stopAll();
  });

  it("uses_the_authorizer_service_and_audits", async () => {
    const services = new ServiceRegistry();
    const audit: AuditEntry[] = [];
    const log: AuditLog = {
      append: async (entry) => {
        audit.push(entry);
      },
      recent: async () => audit,
    };
    // Allows only `ping` and `admin.module.list`, and only in guild `10` with role `r1`.
    const guildOnly: Authorizer = {
      allows: () => false,
      allowsSubject: (subject, node) =>
        subject.context?.scope === "10" &&
        subject.platform_roles.length === 1 &&
        subject.platform_roles[0] === "r1" &&
        (node === "ping" || node === "admin.module.list"),
    };
    services.provide("app", AuthorizerKey, guildOnly);
    services.provide("app", AuditLogKey, log);
    const sup = new Supervisor({ bus: new EventBus(), services });
    await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
    await sup.startAll();
    const reg = services.require(CommandRegistryKey);

    // The owner is denied: the service decides, not the fallback.
    const denied = await reg.dispatch(inGuild("admin module list", "1"));
    expect(denied.text).toContain("權限");
    const withRole = inGuild("admin module list", "5");
    withRole.platform_roles = ["r1"];
    const listed = await reg.dispatch(withRole);
    // Reached the handler (no supervisor in this test).
    expect(listed.text).toContain("supervisor");
    const ping = inGuild("ping", "5");
    ping.platform_roles = ["r1"];
    expect((await reg.dispatch(ping)).text.startsWith("pong")).toBe(true);

    // Only admin nodes are audited, denials too.
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      action: "admin module list",
      actor: "discord:1",
      ok: false,
      detail: { outcome: "denied" },
    });
    expect(audit[1]).toMatchObject({ actor: "discord:5", ok: true });
    // The app's authorizer was kept.
    expect(services.require(AuthorizerKey).allows(parseAccount("discord:1"), "x")).toBe(false);
    await sup.stopAll();
  });

  it("rejects_bad_owner_config", async () => {
    const bus = new EventBus();
    const states = bus.subscribe("system.module.state");
    const sup = new Supervisor({ bus, services: new ServiceRegistry() });
    await sup.register(new CommandsModule(), { owners: ["123"] }, true);
    await sup.startAll();
    for (;;) {
      const env = await states.recv();
      if (env?.event.type === "module_state_changed" && env.event.data.state === "failed") {
        expect(env.event.data.reason).toContain("invalid account `123`");
        break;
      }
    }
    expect(CommandsConfigSchema.parse({}).owners).toEqual([]);
    await sup.stopAll();
  });

  it("fallback_authorizer_returns_after_the_auth_module_stops", async () => {
    const services = new ServiceRegistry();
    const sup = new Supervisor({ bus: new EventBus(), services });
    // Stand-in for the `auth` module: provides an Authorizer while running.
    const auth: Authorizer = { allows: () => true, allowsSubject: () => true };
    class FakeAuth implements Module {
      readonly manifest = defineManifest("auth", "Auth");
      async start(ctx: ModuleContext): Promise<void> {
        ctx.provide(AuthorizerKey, auth);
      }
    }
    await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
    await sup.register(new FakeAuth(), null, true);
    await sup.startAll();
    // Whoever provided last wins; after `auth` stops, the fallback must be back.
    await sup.disable("auth");
    const fallback = services.require(AuthorizerKey);
    expect(fallback).not.toBe(auth);
    expect(fallback.allows(parseAccount("discord:1"), "owner.x")).toBe(true);
    expect(fallback.allows(parseAccount("discord:2"), "owner.x")).toBe(false);
    await sup.stopAll();
  });

  it("format_module_list", () => {
    expect(formatModuleList([])).toBe("一個模組都沒有……");
    expect(
      formatModuleList([
        {
          id: "llm",
          name: "LLM",
          description: "",
          enabled: true,
          state: "failed",
          reason: "boom",
          recent_restarts: 2,
        },
      ]),
    ).toBe("模組狀態:\n`llm` (LLM): failed,最近重啟 2 次 — boom");
  });
});
