import { getLogger, type ServiceLookup } from "@miyoria/kernel";
import { type AuditLog, AuditLogKey } from "@miyoria/store";
import {
  AuthorizerKey,
  type Clock,
  contextKeyString,
  type JsonObject,
  newId,
  type ServiceKey,
  type Subject,
  serviceKey,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import { Permissions, type Role, requiredRole } from "./perms.js";
import {
  type ArgValue,
  CommandError,
  CommandReply,
  type CommandSpec,
  commandName,
  Invocation,
  type InvocationData,
  splitPath,
} from "./spec.js";

const log = getLogger("commands.registry");

/**
 * Optional service run before a permission check, so an `Authorizer` that loads data lazily
 * (e.g. per-guild role mappings) can fetch it first.
 */
export interface AuthorizerPreload {
  preload(subject: Subject): Promise<void>;
}

export const AuthorizerPreloadKey = serviceKey<AuthorizerPreload>("AuthorizerPreload");

/** Deepest supported command path (Discord: group / subcommand group / subcommand). */
export const MAX_PATH_DEPTH = 3;
const MAX_NAME_LEN = 32;

export type HandlerResult = CommandReply | Promise<CommandReply>;
export type CommandHandler = (invocation: Invocation) => HandlerResult;

/** A user-facing argument problem (zh-TW), thrown by `normalizeArgs`. */
export class CommandArgError extends Error {
  override readonly name = "CommandArgError";
}

interface Entry {
  spec: CommandSpec;
  handler: CommandHandler;
}

/**
 * Observes `CommandRegistry.version()` changes, like a Rust `watch::Receiver`: several changes
 * in a row are reported once. Iterate it with `for await`, or call `changed()`.
 */
export class VersionSubscription implements AsyncIterable<number> {
  readonly #registry: CommandRegistry;
  readonly #waiters: Array<(version: number | null) => void> = [];
  #seen: number;
  #closed = false;

  /** @internal Created by `CommandRegistry.subscribe`. */
  constructor(registry: CommandRegistry, seen: number, signal?: AbortSignal) {
    this.#registry = registry;
    this.#seen = seen;
    if (signal?.aborted) this.close();
    else signal?.addEventListener("abort", () => this.close(), { once: true });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The current version, without marking it as seen. */
  current(): number {
    return this.#registry.version();
  }

  /**
   * Resolves with the new version once it differs from the last one seen (marking it seen), or
   * with `null` when the subscription is closed.
   */
  changed(): Promise<number | null> {
    if (this.#closed) return Promise.resolve(null);
    const version = this.#registry.version();
    if (version !== this.#seen) {
      this.#seen = version;
      return Promise.resolve(version);
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** @internal */
  notify(version: number): void {
    if (this.#closed || this.#waiters.length === 0) return;
    this.#seen = version;
    for (const resolve of this.#waiters.splice(0)) resolve(version);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#registry.unsubscribe(this);
    for (const resolve of this.#waiters.splice(0)) resolve(null);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<number> {
    try {
      for (;;) {
        const version = await this.changed();
        if (version === null) return;
        yield version;
      }
    } finally {
      this.close();
    }
  }
}

export interface CommandRegistryOptions {
  /** Where `Authorizer`, `AuthorizerPreload` and `AuditLog` are looked up at dispatch time. */
  services?: ServiceLookup;
  /** Time source for audit entries. */
  clock?: Clock;
}

/**
 * Every registered command. Provided as the `CommandRegistryKey` service by the `commands`
 * module; other modules may register commands at any time and platforms watch `subscribe()`
 * to re-sync.
 */
export class CommandRegistry {
  readonly #perms: Permissions;
  #services: ServiceLookup | null;
  readonly #clock: Clock;
  readonly #entries = new Map<string, Entry>();
  readonly #groups = new Map<string, string>();
  readonly #subscriptions = new Set<VersionSubscription>();
  #version = 0;

  constructor(perms: Permissions = new Permissions(), options: CommandRegistryOptions = {}) {
    this.#perms = perms;
    this.#services = options.services ?? null;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Looks up the `Authorizer` (falling back to the own `Permissions`), `AuthorizerPreload` and
   * `AuditLog` services through `services` whenever a command is dispatched.
   */
  withServices(services: ServiceLookup): this {
    this.#services = services;
    return this;
  }

  permissions(): Permissions {
    return this.#perms;
  }

  /**
   * Registers (or replaces) the command at `spec.path`.
   *
   * Throws `CommandError` if the spec is malformed or if its path is a prefix of another
   * command's path (or the other way round), which hierarchical platforms cannot represent.
   */
  register(spec: CommandSpec, handler: CommandHandler): void {
    validateSpec(spec);
    const key = spec.path.join(" ");
    for (const other of this.#entries.values()) {
      const path = other.spec.path;
      if (path.join(" ") !== key && (startsWith(path, spec.path) || startsWith(spec.path, path))) {
        throw new CommandError(
          `command \`${commandName(spec)}\` conflicts with \`${commandName(other.spec)}\``,
        );
      }
    }
    this.#entries.set(key, { spec: structuredClone(spec), handler });
    this.#bump();
  }

  /** Removes the command at the space separated `path`. */
  unregister(path: string): boolean {
    const removed = this.#entries.delete(splitPath(path).join(" "));
    if (removed) this.#bump();
    return removed;
  }

  /**
   * Sets the description of a command group such as `"admin"` or `"admin module"` (platforms
   * need one for each parent level).
   */
  setGroupDescription(path: string, description: string): void {
    this.#groups.set(splitPath(path).join(" "), description);
    this.#bump();
  }

  groupDescription(path: string | readonly string[]): string | undefined {
    return this.#groups.get(typeof path === "string" ? splitPath(path).join(" ") : path.join(" "));
  }

  /** All registered commands, ordered by path. */
  specs(): CommandSpec[] {
    return [...this.#entries.values()]
      .map((e) => e.spec)
      .sort((a, b) => comparePaths(a.path, b.path))
      .map((spec) => structuredClone(spec));
  }

  get(path: readonly string[]): CommandSpec | undefined {
    const entry = this.#entries.get(path.join(" "));
    return entry ? structuredClone(entry.spec) : undefined;
  }

  /** Increases on every registration change. */
  version(): number {
    return this.#version;
  }

  /**
   * Watches for registration changes (commands or group descriptions). Close the returned
   * subscription (or pass a `signal`) when done.
   */
  subscribe(signal?: AbortSignal): VersionSubscription {
    const subscription = new VersionSubscription(this, this.#version, signal);
    if (!subscription.closed) this.#subscriptions.add(subscription);
    return subscription;
  }

  /** @internal */
  unsubscribe(subscription: VersionSubscription): void {
    this.#subscriptions.delete(subscription);
  }

  /**
   * Checks permissions and arguments, then runs the handler.
   *
   * Unknown commands, permission denials and invalid arguments become ephemeral replies; only
   * handler failures are thrown.
   */
  async dispatch(data: InvocationData): Promise<CommandReply> {
    const invocation = Invocation.from(data);
    const entry = this.#entries.get(invocation.path.join(" "));
    if (!entry) {
      return CommandReply.ephemeral(
        `沒有「${invocation.path.join(" ")}」這個指令啦,你是不是打錯了?`,
      );
    }
    const { spec, handler } = entry;
    const audit = isAdminNode(spec.permission) ? this.#service(AuditLogKey) : undefined;
    if (!(await this.#allows(invocation, spec.permission))) {
      if (audit) await this.#appendAudit(audit, invocation, false, "denied");
      return CommandReply.ephemeral(denial(requiredRole(spec.permission)));
    }
    try {
      invocation.args = normalizeArgs(spec, invocation.args);
    } catch (error) {
      if (error instanceof CommandArgError) {
        return CommandReply.ephemeral(`${error.message}……參數要好好給我啦。`);
      }
      throw error;
    }
    if (!audit) return await handler(invocation);
    const record = new Invocation(invocation);
    let reply: CommandReply;
    try {
      reply = await handler(invocation);
    } catch (error) {
      await this.#appendAudit(audit, record, false, null);
      throw error;
    }
    await this.#appendAudit(audit, record, true, null);
    return reply;
  }

  /** Checks `node` with the `Authorizer` service if there is one, otherwise with `Permissions`. */
  async #allows(invocation: Invocation, node: string): Promise<boolean> {
    const authorizer = this.#service(AuthorizerKey);
    if (!authorizer) return this.#perms.allowsInvocation(invocation, node);
    const subject = invocation.subject();
    const preload = this.#service(AuthorizerPreloadKey);
    if (preload) await preload.preload(subject);
    return authorizer.allowsSubject(subject, node);
  }

  #service<T>(key: ServiceKey<T>): T | undefined {
    return this.#services?.get(key);
  }

  async #appendAudit(
    audit: AuditLog,
    inv: Invocation,
    ok: boolean,
    outcome: string | null,
  ): Promise<void> {
    const detail: JsonObject = {
      args: sortedArgs(inv.args),
      context: contextKeyString(inv.context),
    };
    if (outcome !== null) detail.outcome = outcome;
    const entry = {
      id: newId(),
      at: toTimestamp(this.#clock.now()),
      actor: `${inv.invoker.platform}:${inv.invoker.id}`,
      action: inv.path.join(" "),
      target: contextKeyString(inv.context),
      detail,
      ok,
    };
    try {
      await audit.append(entry);
    } catch (err) {
      log.warn({ action: entry.action, err }, "cannot write audit entry");
    }
  }

  #bump(): void {
    this.#version += 1;
    for (const subscription of [...this.#subscriptions]) subscription.notify(this.#version);
  }
}

/** `admin.*` and `owner.*` nodes are audited. */
function isAdminNode(node: string): boolean {
  const root = node.split(".")[0];
  return root === "admin" || root === "owner";
}

/** Args as a JSON object with ascending keys (Rust serialized a `BTreeMap`). */
function sortedArgs(args: Record<string, ArgValue>): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(args).sort()) out[key] = args[key] as ArgValue;
  return out;
}

function denial(required: Role): string {
  return required === "owner" ? "這個只有我的主人能用,你、你又不是!" : "你沒有權限做這個啦。";
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((word, i) => path[i] === word);
}

function comparePaths(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

const VALID_NAME_CHAR = /^(?:(?![\p{Uppercase}])[\p{Alphabetic}\p{N}]|[-_])$/u;

function validName(name: string): boolean {
  const chars = [...name];
  return (
    chars.length >= 1 && chars.length <= MAX_NAME_LEN && chars.every((c) => VALID_NAME_CHAR.test(c))
  );
}

function validateSpec(spec: CommandSpec): void {
  const name = commandName(spec);
  if (spec.path.length === 0 || spec.path.length > MAX_PATH_DEPTH) {
    throw new CommandError(`command \`${name}\`: path must have 1 to ${MAX_PATH_DEPTH} words`);
  }
  const bad = spec.path.find((word) => !validName(word));
  if (bad !== undefined) throw new CommandError(`command \`${name}\`: invalid name \`${bad}\``);
  if (spec.description.trim() === "") {
    throw new CommandError(`command \`${name}\`: description is empty`);
  }
  const seen = new Set<string>();
  for (const arg of spec.args) {
    if (!validName(arg.name)) {
      throw new CommandError(`command \`${name}\`: invalid argument name \`${arg.name}\``);
    }
    if (seen.has(arg.name)) {
      throw new CommandError(`command \`${name}\`: duplicate argument \`${arg.name}\``);
    }
    seen.add(arg.name);
    if (arg.kind.type === "choice" && arg.kind.choices.length === 0) {
      throw new CommandError(`command \`${name}\`: argument \`${arg.name}\` has no choices`);
    }
  }
}

const INTEGER = /^[+-]?\d+$/;

/**
 * Validates `args` against the spec and coerces string values (from text platforms) to the
 * declared kinds. Throws `CommandArgError`; its message is user-facing.
 */
export function normalizeArgs(
  spec: CommandSpec,
  args: Readonly<Record<string, ArgValue>>,
): Record<string, ArgValue> {
  const unknown = Object.keys(args)
    .sort()
    .find((key) => !spec.args.some((a) => a.name === key));
  if (unknown !== undefined) throw new CommandArgError(`「${unknown}」不是這個指令的參數`);
  const out: Record<string, ArgValue> = {};
  for (const arg of spec.args) {
    const value = Object.hasOwn(args, arg.name) ? args[arg.name] : undefined;
    if (value === undefined) {
      if (arg.required) throw new CommandArgError(`少了「${arg.name}」`);
      continue;
    }
    out[arg.name] = coerce(arg.name, arg.kind, value);
  }
  return out;
}

function coerce(
  name: string,
  kind: CommandSpec["args"][number]["kind"],
  value: ArgValue,
): ArgValue {
  switch (kind.type) {
    case "string":
      if (typeof value === "string") return value;
      break;
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value)) return value;
      if (typeof value === "string") {
        const trimmed = value.trim();
        const parsed = Number(trimmed);
        if (INTEGER.test(trimmed) && Number.isSafeInteger(parsed)) return parsed;
        throw new CommandArgError(`「${name}」要是整數`);
      }
      break;
    case "boolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        switch (value.trim().toLowerCase()) {
          case "true":
          case "yes":
          case "on":
          case "1":
            return true;
          case "false":
          case "no":
          case "off":
          case "0":
            return false;
          default:
            throw new CommandArgError(`「${name}」要是 true 或 false`);
        }
      }
      break;
    case "user":
      if (typeof value === "string") {
        const id = mentionId(value, ["<@!", "<@"]);
        if (id === null) throw new CommandArgError(`「${name}」要是一個使用者`);
        return id;
      }
      break;
    case "role":
      if (typeof value === "string") {
        const id = mentionId(value, ["<@&"]);
        if (id === null) throw new CommandArgError(`「${name}」要是一個身分組`);
        return id;
      }
      break;
    case "choice":
      if (typeof value === "string") {
        if (kind.choices.includes(value)) return value;
        throw new CommandArgError(`「${name}」只能是 ${kind.choices.join(" / ")} 其中之一`);
      }
      break;
  }
  log.warn({ arg: name, kind, value }, "argument has the wrong type");
  throw new CommandArgError(`「${name}」的型別不對`);
}

/**
 * `"<@123>"` (with one of `prefixes`) or a bare `"123"` / `"discord:123"` → the id part.
 * Rejects empty values and whitespace.
 */
function mentionId(raw: string, prefixes: readonly string[]): string | null {
  const trimmed = raw.trim();
  let id = trimmed;
  for (const prefix of prefixes) {
    if (
      trimmed.startsWith(prefix) &&
      trimmed.endsWith(">") &&
      trimmed.length >= prefix.length + 1
    ) {
      id = trimmed.slice(prefix.length, -1);
      break;
    }
  }
  return id !== "" && !/\s/u.test(id) && !/[<>@&]/u.test(id) ? id : null;
}
