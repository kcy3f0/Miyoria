// `admin role ...` and `admin perm ...` commands.
//
// Besides the command's permission node, every change is limited by rank: the invoker may only
// hand out, take away, map or override roles ranked strictly below their own effective role,
// and may not change someone who ranks as high or higher. Global changes are judged by the
// invoker's global role, so a guild admin cannot grant roles in other guilds. Config owners may
// do everything.

import {
  ArgKind,
  type ArgSpec,
  argSpec,
  type CommandRegistry,
  CommandRegistryKey,
  CommandReply,
  type CommandSpec,
  commandSpec,
  type Invocation,
} from "@miyoria/commands";
import { getLogger, type ServiceLookup } from "@miyoria/kernel";
import type { AuthScope, NodeOverride, RoleDefinition, RoleMapping } from "@miyoria/store";
import { type AccountRef, accountSubject, type Subject, sameAccount } from "@miyoria/types";
import { isValidPattern } from "./node.js";
import { candidateEquals, outranks, type Resolution, type Source, scopeCovers } from "./resolve.js";
import { type AuthService, accountString, errorChain } from "./service.js";

const log = getLogger("auth.commands");

export const COMMAND_PATHS = [
  "admin role list",
  "admin role assign",
  "admin role revoke",
  "admin role map",
  "admin role unmap",
  "admin role whois",
  "admin perm allow",
  "admin perm deny",
  "admin perm clear",
] as const;

const NODE_LIST = "admin.role.list";
const NODE_ASSIGN = "admin.role.assign";
const NODE_MAP = "admin.role.map";
const NODE_WHOIS = "admin.role.whois";
const NODE_PERM = "admin.perm.set";
const SHOWN_NODES = 6;

/**
 * Remembers which registry the commands went into, so they can be removed on stop and
 * re-registered when the `commands` module restarts.
 */
export class AuthCommands {
  #installed: CommandRegistry | null = null;

  /** Registers the commands in the current `CommandRegistry` service, if any and not done already. */
  install(services: ServiceLookup, service: AuthService): void {
    const registry = services.get(CommandRegistryKey);
    if (!registry) {
      log.debug("no command registry, auth commands not registered");
      return;
    }
    if (this.#installed === registry) return;
    if (this.#installed) {
      unregister(this.#installed);
      this.#installed = null;
    }
    try {
      register(registry, service);
      this.#installed = registry;
    } catch (error) {
      log.warn({ error: errorChain(error) }, "could not register auth commands");
      unregister(registry);
    }
  }

  uninstall(): void {
    if (this.#installed) {
      unregister(this.#installed);
      this.#installed = null;
    }
  }
}

function unregister(registry: CommandRegistry): void {
  for (const path of COMMAND_PATHS) registry.unregister(path);
}

type Handler = (service: AuthService, inv: Invocation) => Promise<CommandReply>;

function add(registry: CommandRegistry, service: AuthService, spec: CommandSpec, handler: Handler) {
  registry.register({ ...spec, ephemeral: true }, (inv) => handler(service, inv));
}

const scopeArg = (): ArgSpec =>
  argSpec(
    "scope",
    "範圍(預設:在伺服器裡是 guild,私訊裡是 global)",
    ArgKind.choice(["global", "guild", "channel"]),
    { required: false },
  );

const userArg = (description: string, required = true): ArgSpec =>
  argSpec("user", description, ArgKind.user, { required });

const roleArg = (): ArgSpec => argSpec("role", "Miyoria 角色,例如 moderator", ArgKind.string);

function register(registry: CommandRegistry, service: AuthService): void {
  registry.setGroupDescription("admin role", "角色管理");
  registry.setGroupDescription("admin perm", "權限節點覆寫");
  add(
    registry,
    service,
    commandSpec("admin role list", "列出角色、身分組對應與覆寫", { permission: NODE_LIST }),
    list,
  );
  for (const revoke of [false, true]) {
    const [path, description] = revoke
      ? (["admin role revoke", "收回某人的角色"] as const)
      : (["admin role assign", "指派角色給某人"] as const);
    add(
      registry,
      service,
      commandSpec(path, description, {
        args: [userArg("對象"), roleArg(), scopeArg()],
        permission: NODE_ASSIGN,
      }),
      (svc, inv) => assign(svc, inv, revoke),
    );
  }
  add(
    registry,
    service,
    commandSpec("admin role map", "把 Discord 身分組對應到 Miyoria 角色", {
      args: [argSpec("discord_role", "Discord 身分組", ArgKind.role), roleArg()],
      permission: NODE_MAP,
    }),
    (svc, inv) => mapRole(svc, inv, false),
  );
  add(
    registry,
    service,
    commandSpec("admin role unmap", "取消 Discord 身分組的對應", {
      args: [argSpec("discord_role", "Discord 身分組", ArgKind.role)],
      permission: NODE_MAP,
    }),
    (svc, inv) => mapRole(svc, inv, true),
  );
  add(
    registry,
    service,
    commandSpec("admin role whois", "查某人在這裡實際的角色和原因", {
      args: [userArg("對象(預設是你自己)", false)],
      permission: NODE_WHOIS,
    }),
    whois,
  );
  for (const op of ["allow", "deny", "clear"] as const) {
    add(
      registry,
      service,
      commandSpec(PERM_OPS[op].path, PERM_OPS[op].description, {
        args: [
          roleArg(),
          argSpec("node", "權限節點,例如 queue.skip 或 queue.*", ArgKind.string),
          scopeArg(),
        ],
        permission: NODE_PERM,
      }),
      (svc, inv) => perm(svc, inv, op),
    );
  }
}

type PermOp = "allow" | "deny" | "clear";

const PERM_OPS: Record<PermOp, { path: string; description: string }> = {
  allow: { path: "admin perm allow", description: "在某個範圍允許角色使用權限節點" },
  deny: { path: "admin perm deny", description: "在某個範圍禁止角色使用權限節點" },
  clear: { path: "admin perm clear", description: "拿掉某個範圍的權限節點覆寫" },
};

/** An early exit with the reply to send (Rust `Err(CommandReply)`). */
class Refusal extends Error {
  override readonly name = "Refusal";

  constructor(readonly reply: CommandReply) {
    super(reply.text);
  }
}

/** Runs `body`, turning a `Refusal` into its reply. */
async function replying(body: () => Promise<CommandReply>): Promise<CommandReply> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof Refusal) return error.reply;
    throw error;
  }
}

function no(text: string): CommandReply {
  return CommandReply.ephemeral(text);
}

function failed(error: unknown): CommandReply {
  const chain = errorChain(error);
  log.warn({ error: chain }, "auth command failed");
  return no(`失敗了啦:${chain}`);
}

/** Runs a store-backed change; a failure becomes a `failed` refusal. */
async function guarded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw new Refusal(failed(error));
  }
}

const actor = (inv: Invocation): string => accountString(inv.invoker);

function who(account: AccountRef): string {
  return account.platform === "discord" ? `<@${account.id}>` : accountString(account);
}

function platformRole(inv: Invocation, id: string): string {
  return inv.context.platform === "discord" ? `<@&${id}>` : `\`${id}\``;
}

function scopeLabel(inv: Invocation, scope: AuthScope): string {
  switch (scope.type) {
    case "global":
      return "全域";
    case "guild":
      return inv.context.scope === scope.guild ? "這個伺服器" : `伺服器 ${scope.guild}`;
    case "channel":
      if (scope.context.channel === inv.context.channel) return "這個頻道";
      return scope.context.platform === "discord"
        ? `<#${scope.context.channel}>`
        : `頻道 ${scope.context.channel}`;
  }
}

function sourceLabel(inv: Invocation, source: Source): string {
  switch (source.type) {
    case "config_owner":
      return "設定檔裡的主人";
    case "assignment":
      return `${scopeLabel(inv, source.scope)}的指派(由 ${source.granted_by})`;
    case "platform_role":
      return `身分組 ${platformRole(inv, source.platform_role)} 的對應`;
    case "guild_admin":
      return "伺服器管理員";
    case "default":
      return "預設角色";
  }
}

function parseScope(inv: Invocation): AuthScope {
  const guild = inv.context.scope;
  const inGuild = (scope: AuthScope): AuthScope => {
    if (guild !== null) return scope;
    throw new Refusal(no("私訊裡沒有伺服器或頻道範圍啦,用 global。"));
  };
  const scope = inv.str("scope");
  if ((scope === null && guild === null) || scope === "global") return { type: "global" };
  if (scope === null || scope === "guild") {
    return inGuild({ type: "guild", platform: inv.context.platform, guild: guild ?? "" });
  }
  return inGuild({ type: "channel", context: inv.context });
}

function roleNamed(svc: AuthService, inv: Invocation): RoleDefinition {
  const name = (inv.str("role") ?? "").trim().toLowerCase();
  const role = svc.role(name);
  if (!role) {
    throw new Refusal(no(`沒有 \`${name}\` 這個角色。用 \`/admin role list\` 看看有哪些。`));
  }
  return role;
}

/**
 * The invoker as seen in `scope` (global changes are judged without the guild context),
 * checked against `node`.
 */
function authority(
  svc: AuthService,
  inv: Invocation,
  scope: AuthScope,
  node: string,
): { subject: Subject; resolution: Resolution } {
  const subject = scope.type === "global" ? accountSubject(inv.invoker) : inv.subject();
  if (!svc.check(subject, node)) throw new Refusal(no("你在這個範圍沒有權限做這個啦。"));
  return { subject, resolution: svc.resolve(subject) };
}

function outrank(resolution: Resolution, role: RoleDefinition): void {
  if (!outranks(resolution, role.rank)) {
    throw new Refusal(no(`\`${role.name}\` 跟你一樣高或比你高,你不能動它。哼,想得美。`));
  }
}

async function list(svc: AuthService, inv: Invocation): Promise<CommandReply> {
  let out = "角色(由高到低):";
  for (const role of svc.roles()) {
    const more = Math.max(0, role.grants.length - SHOWN_NODES);
    const nodes = role.grants.slice(0, SHOWN_NODES);
    let line = `\n\`${role.name}\` ${role.rank}${role.builtin ? " · 內建" : ""} — ${
      nodes.length === 0 ? "(什麼都不能做)" : nodes.join(", ")
    }`;
    if (more > 0) line += ` …還有 ${more} 個`;
    if (role.denies.length > 0) line += `;禁止 ${role.denies.join(", ")}`;
    out += line;
  }
  if (inv.context.scope !== null) {
    try {
      const maps = await svc.mappings(inv.context.platform, inv.context.scope);
      if (maps.length > 0) {
        out += "\n\n這個伺服器的身分組對應:";
        for (const m of maps) out += `\n${platformRole(inv, m.platform_role)} → \`${m.role}\``;
      }
    } catch (error) {
      return failed(error);
    }
  }
  const overrides: NodeOverride[] = svc
    .overrides()
    .filter((o) => scopeCovers(o.scope, inv.context));
  if (overrides.length > 0) {
    out += "\n\n在這裡生效的覆寫:";
    for (const o of overrides) {
      out += `\n\`${o.role}\` 在${scopeLabel(inv, o.scope)}${o.allow ? "允許" : "禁止"} \`${o.node}\``;
    }
  }
  return CommandReply.ephemeral(out);
}

function assign(svc: AuthService, inv: Invocation, revoke: boolean): Promise<CommandReply> {
  return replying(async () => {
    const target = inv.account("user");
    if (!target) throw new Refusal(no("要指定一個人啦。"));
    const role = roleNamed(svc, inv);
    const scope = parseScope(inv);
    const { resolution: me } = authority(svc, inv, scope, NODE_ASSIGN);
    outrank(me, role);
    const targetSubject = scope.type === "global" ? accountSubject(target) : inv.subjectFor(target);
    if (
      !sameAccount(target, inv.invoker) &&
      !outranks(me, svc.resolve(targetSubject).effective.rank)
    ) {
      throw new Refusal(no(`${who(target)} 的角色跟你一樣高或比你高,我才不聽你的。`));
    }
    const place = scopeLabel(inv, scope);
    if (revoke) {
      const removed = await guarded(svc.revoke(actor(inv), target, role.name, scope));
      return removed
        ? no(`好,收回了 ${who(target)} 在${place}的 \`${role.name}\`。`)
        : no(`${who(target)} 在${place}本來就沒有被指派 \`${role.name}\` 啊。`);
    }
    await guarded(svc.assign(actor(inv), target, role.name, scope));
    let text = `好啦,${who(target)} 在${place}是 \`${role.name}\` 了。感謝我吧。`;
    const effective = svc.resolve(inv.subjectFor(target)).effective;
    if (effective.role !== role.name) {
      text += `\n(不過他在這裡實際生效的是 \`${effective.role}\`。)`;
    }
    return no(text);
  });
}

function mapRole(svc: AuthService, inv: Invocation, remove: boolean): Promise<CommandReply> {
  return replying(async () => {
    const guild = inv.context.scope;
    if (guild === null) throw new Refusal(no("身分組對應只能在伺服器裡設定。"));
    const platform = inv.context.platform;
    const discordRole = inv.str("discord_role") ?? "";
    const { resolution: me } = authority(svc, inv, { type: "guild", platform, guild }, NODE_MAP);
    const maps = await guarded(svc.mappings(platform, guild));
    const existing = maps.find((m) => m.platform_role === discordRole);
    const old = existing ? svc.role(existing.role) : undefined;
    if (old) outrank(me, old);
    const shown = platformRole(inv, discordRole);
    if (remove) {
      if (!existing) return no(`${shown} 本來就沒有對應啊。`);
      await guarded(svc.unmapRole(actor(inv), platform, guild, discordRole));
      return no(`好,${shown} 不再對應任何角色了。`);
    }
    const role = roleNamed(svc, inv);
    outrank(me, role);
    const mapping: RoleMapping = {
      platform,
      guild,
      platform_role: discordRole,
      role: role.name,
    };
    await guarded(svc.mapRole(actor(inv), mapping));
    return no(`好,在這個伺服器有 ${shown} 的人就是 \`${role.name}\`。`);
  });
}

async function whois(svc: AuthService, inv: Invocation): Promise<CommandReply> {
  const target = inv.account("user") ?? inv.invoker;
  const subject = inv.subjectFor(target);
  await svc.preload(subject);
  const r = svc.resolve(subject);
  let out = `${who(target)} 在這裡是 \`${r.effective.role}\`(rank ${r.effective.rank})。\n原因:${sourceLabel(
    inv,
    r.effective.source,
  )}`;
  const others = r.candidates
    .filter((c) => !candidateEquals(c, r.effective))
    .map((c) => `\`${c.role}\`(${sourceLabel(inv, c.source)})`);
  if (others.length > 0) out += `\n也符合:${others.join("、")}`;
  const unknown =
    !sameAccount(target, inv.invoker) &&
    target.platform === inv.context.platform &&
    !Object.hasOwn(inv.resolved_users, target.id);
  if (unknown && inv.context.scope !== null) {
    out += "\n(看不到對方的身分組,只算了指派的角色。)";
  }
  return CommandReply.ephemeral(out);
}

function perm(svc: AuthService, inv: Invocation, op: PermOp): Promise<CommandReply> {
  return replying(async () => {
    const role = roleNamed(svc, inv);
    const node = (inv.str("node") ?? "").trim();
    if (!isValidPattern(node)) {
      throw new Refusal(no(`\`${node}\` 格式不對,要像 \`queue.skip\` 或 \`queue.*\` 這樣。`));
    }
    const scope = parseScope(inv);
    const { subject: meSubject, resolution: me } = authority(svc, inv, scope, NODE_PERM);
    outrank(me, role);
    // Allowing (or lifting a deny) must not hand out more than one has.
    if (op !== "deny" && !svc.check(meSubject, node)) {
      throw new Refusal(no(`你自己都不能用 \`${node}\`,不能給別人啦。`));
    }
    const place = scopeLabel(inv, scope);
    if (op === "clear") {
      const removed = await guarded(svc.removeOverride(actor(inv), scope, role.name, node));
      return removed
        ? no(`好,拿掉了 \`${role.name}\` 在${place}對 \`${node}\` 的覆寫。`)
        : no(`\`${role.name}\` 在${place}本來就沒有 \`${node}\` 的覆寫啊。`);
    }
    const allow = op === "allow";
    await guarded(svc.setOverride(actor(inv), { scope, role: role.name, node, allow }));
    return no(`好,\`${role.name}\` 在${place}${allow ? "可以用" : "不能用"} \`${node}\` 了。`);
  });
}
