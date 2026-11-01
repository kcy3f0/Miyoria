import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
  type ModuleManifest,
  type ModuleStatus,
  type ServiceLookup,
  type Supervisor,
  SupervisorKey,
} from "@miyoria/kernel";
import { AuthorizerKey, type ModuleId, serviceKey } from "@miyoria/types";
import { z } from "zod";
import { Permissions } from "./perms.js";
import { CommandRegistry } from "./registry.js";
import { ArgKind, argSpec, CommandReply, commandSpec, type Invocation } from "./spec.js";

/**
 * `[modules.commands]` config section.
 *
 * ```toml
 * [modules.commands]
 * owners = ["discord:123456789012345678"]
 * ```
 */
export const CommandsConfigSchema = z.object({
  /** Accounts with the `owner` role, as `"platform:id"`. */
  owners: z.array(z.string()).default([]),
});

export type CommandsConfig = z.output<typeof CommandsConfigSchema>;

export const CommandRegistryKey = serviceKey<CommandRegistry>("CommandRegistry");

/**
 * Module `commands`: provides the `CommandRegistry` service and registers the built-in
 * commands (`ping`, `admin module ...`).
 *
 * It also provides its `Permissions` as a fallback `Authorizer` whenever no other module
 * (normally `auth`) provides one, and puts it back after that module stops.
 */
export class CommandsModule implements Module {
  static readonly ID = "commands";

  readonly manifest: ModuleManifest = defineManifest(CommandsModule.ID, "Commands", {
    description: "Cross-platform command framework and built-in commands",
    configSchema: CommandsConfigSchema,
  });

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(CommandsConfigSchema);
    const perms = Permissions.fromStrings(config.owners);
    const registry = new CommandRegistry(perms, { services: ctx.services, clock: ctx.clock });
    registerBuiltins(registry, ctx);
    ctx.provide(CommandRegistryKey, registry);
    provideFallback(ctx, perms);

    const events = ctx.subscribe("system.module.state");
    ctx.spawn("authorizer-fallback", async () => {
      for await (const _ of events) provideFallback(ctx, perms);
    });
  }
}

function provideFallback(ctx: ModuleContext, fallback: Permissions): void {
  if (ctx.services.get(AuthorizerKey) === undefined) ctx.provide(AuthorizerKey, fallback);
}

type Op = "enable" | "disable" | "restart";

const OPS: Record<Op, { path: string; description: string; permission: string }> = {
  enable: {
    path: "admin module enable",
    description: "啟用模組",
    permission: "admin.module.toggle",
  },
  disable: {
    path: "admin module disable",
    description: "停用模組(依賴它的模組也會停)",
    permission: "admin.module.toggle",
  },
  restart: {
    path: "admin module restart",
    description: "重新啟動模組",
    permission: "admin.module.restart",
  },
};

/**
 * Registers `ping` and `admin module list | enable | disable | restart`.
 *
 * The admin commands look up the `SupervisorKey` service when they run, so the app may provide
 * it after this module started.
 */
export function registerBuiltins(
  registry: CommandRegistry,
  ctx: { readonly services: ServiceLookup },
): void {
  registry.register(commandSpec("ping", "確認 Miyoria 還醒著", { permission: "ping" }), () =>
    CommandReply.public("pong!……才、才不是特地回你的。"),
  );

  registry.setGroupDescription("admin", "管理指令");
  registry.setGroupDescription("admin module", "管理模組");

  registry.register(
    commandSpec("admin module list", "列出所有模組與狀態", {
      permission: "admin.module.list",
      ephemeral: true,
    }),
    () => {
      const sup = ctx.services.get(SupervisorKey);
      if (!sup) return noSupervisor();
      return CommandReply.ephemeral(formatModuleList(sup.list()));
    },
  );

  for (const op of ["enable", "disable", "restart"] as const) {
    const { path, description, permission } = OPS[op];
    registry.register(
      commandSpec(path, description, {
        args: [argSpec("id", "模組 id,例如 llm", ArgKind.string)],
        permission,
        ephemeral: true,
      }),
      async (inv: Invocation) => {
        const sup = ctx.services.get(SupervisorKey);
        if (!sup) return noSupervisor();
        const id = (inv.str("id") ?? "").trim();
        return CommandReply.ephemeral(await runOp(sup, op, id));
      },
    );
  }
}

async function runOp(sup: Supervisor, op: Op, id: ModuleId): Promise<string> {
  if (op === "disable" && id === CommandsModule.ID) {
    return "不要啦,停掉 `commands` 我就聽不到指令了。真的要停請用 CLI 或 Panel。";
  }
  try {
    await sup[op](id);
  } catch (error) {
    return `失敗了啦:${errorMessage(error)}`;
  }
  switch (op) {
    case "enable":
      return `\`${id}\` 啟用了。哼,感謝我吧。`;
    case "disable":
      return `\`${id}\` 停用了。`;
    case "restart":
      return `\`${id}\` 重新啟動好了。`;
  }
}

function noSupervisor(): CommandReply {
  return CommandReply.ephemeral("現在沒辦法管理模組(supervisor 不在),這不是我的錯喔。");
}

/** One line per module: `` `id` (name): state, recent restarts, — reason ``. */
export function formatModuleList(modules: readonly ModuleStatus[]): string {
  if (modules.length === 0) return "一個模組都沒有……";
  let out = "模組狀態:";
  for (const m of modules) {
    out += `\n\`${m.id}\` (${m.name}): ${m.state}`;
    if (m.recent_restarts > 0) out += `,最近重啟 ${m.recent_restarts} 次`;
    if (m.reason !== null) out += ` — ${m.reason}`;
  }
  return out;
}
