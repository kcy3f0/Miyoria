// `memory show | forget | export`, registered in the command registry when the `commands`
// module is running.
//
// Everyone may manage their own memories (`memory.self.*`); the optional `user` argument
// (someone else) needs `memory.admin.*`.

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  CommandReply,
  commandSpec,
  type Invocation,
  type Permissions,
  ROLE_RANK,
} from "@miyoria/commands";
import { errorMessage, getLogger } from "@miyoria/kernel";
import type { MemoryKind, MemoryRecord } from "@miyoria/store";
import {
  type AccountRef,
  type Authorizer,
  accountSubject,
  type Clock,
  type PersonId,
  sameAccount,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import type { MemoryEngine } from "./engine.js";
import { hasScope, scopeLabel, visibleScopes } from "./scope.js";
import { relativeDate } from "./score.js";

const log = getLogger("memory.commands");

export const PATHS = ["memory show", "memory forget", "memory export"] as const;
/** Replies stay below Discord's 2000-character message limit. */
const MAX_REPLY_CHARS = 1900;

/** Looks up the current `Authorizer` service, if any. */
export type AuthorizerLookup = () => Authorizer | undefined;

type Op = "show" | "forget" | "export";

const charCount = (s: string) => [...s].length;

class Handler {
  constructor(
    readonly engine: MemoryEngine,
    readonly perms: Permissions,
    readonly authorizer: AuthorizerLookup,
    readonly clock: Clock,
  ) {}

  async run(op: Op, inv: Invocation): Promise<CommandReply> {
    const requested = inv.account("user");
    const other = requested && !sameAccount(requested, inv.invoker) ? requested : null;
    if (other !== null && !this.adminAllowed(inv, `memory.admin.${op}`)) {
      return CommandReply.ephemeral("別人的記憶不能隨便看啦,這要管理員才行。");
    }
    const target = other ?? inv.invoker;
    const person = await this.engine.personOf(target);
    const who = other !== null ? `${target.id} ` : "你";
    let text: string;
    switch (op) {
      case "show":
        text = await this.show(inv, target, person, who);
        break;
      case "export":
        text = await this.export(inv, target, person, who);
        break;
      case "forget":
        text = await this.forget(target, person, (inv.str("target") ?? "").trim(), who);
        break;
    }
    return CommandReply.ephemeral(text);
  }

  /**
   * `memory.admin.*` check. A node the authorizer grants to an unknown account is no real gate
   * (the phase-1 role scheme opens every node outside `admin.` / `owner.`), so then guild
   * admins and owners decide.
   */
  adminAllowed(inv: Invocation, node: string): boolean {
    const auth = this.authorizer();
    if (auth) {
      const nobody = accountSubject({ platform: inv.invoker.platform, id: "\u0000nobody" });
      if (!auth.allowsSubject(nobody, node)) return auth.allowsSubject(inv.subject(), node);
    }
    return ROLE_RANK[this.perms.roleOf(inv)] >= ROLE_RANK.admin;
  }

  /** Records about `target` that may be shown in the invocation's context. */
  async visible(
    inv: Invocation,
    target: AccountRef,
    person: PersonId | null,
  ): Promise<MemoryRecord[]> {
    // Only the invoker is "in" the context of the reply, so DM memories show up only in the
    // invoker's own DM.
    const scopes = visibleScopes(inv.context, [inv.invoker], person === null ? [] : [person]);
    return (await this.engine.memoriesOf(person, target, false)).filter((r) =>
      hasScope(scopes, r.scope),
    );
  }

  async show(
    inv: Invocation,
    target: AccountRef,
    person: PersonId | null,
    who: string,
  ): Promise<string> {
    const records = await this.visible(inv, target, person);
    if (records.length === 0) return `在這裡,我好像還沒記得關於${who}的什麼事……`;
    const now = toTimestamp(this.clock.now());
    let out = `我記得關於${who}的事:\n`;
    for (const [i, r] of records.entries()) {
      const line = `- 〔${kindLabel(r.kind)}〕${r.content.replaceAll("\n", " ")}(${relativeDate(
        r.created_at,
        now,
      )})\n`;
      if (charCount(out) + charCount(line) > MAX_REPLY_CHARS - 40) {
        out += `……還有 ${records.length - i} 件沒列出來。`;
        break;
      }
      out += line;
    }
    return out.trimEnd();
  }

  async export(
    inv: Invocation,
    target: AccountRef,
    person: PersonId | null,
    who: string,
  ): Promise<string> {
    const records = await this.visible(inv, target, person);
    if (records.length === 0) return `在這裡沒有關於${who}的記憶可以匯出。`;
    const items: Record<string, unknown>[] = [];
    let truncated = 0;
    for (const [i, r] of records.entries()) {
      items.push(exportItem(r));
      if (charCount(JSON.stringify(items, null, 2)) > MAX_REPLY_CHARS - 80) {
        items.pop();
        truncated = records.length - i;
        break;
      }
    }
    let out = `\`\`\`json\n${JSON.stringify(items, null, 2)}\n\`\`\``;
    if (truncated > 0) out += `\n(太長了,還有 ${truncated} 筆沒放進來。)`;
    return out;
  }

  async forget(
    target: AccountRef,
    person: PersonId | null,
    raw: string,
    who: string,
  ): Promise<string> {
    if (raw === "") return "要忘掉什麼?給我一個關鍵字,或是 all。";
    if (raw.toLowerCase() === "all") {
      const n = await this.engine.forget(person, target, null);
      return n === 0
        ? `我本來就沒記得關於${who}的事。`
        : `……好啦,關於${who}的事我全部忘掉了(${n} 件)。`;
    }
    const n = await this.engine.forget(person, target, raw);
    return n === 0
      ? `我不記得關於${who}跟「${raw}」有關的事耶。`
      : `好,關於${who}跟「${raw}」有關的 ${n} 件事,我忘掉了。`;
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Rust `DateTime::to_rfc3339`: `+00:00` instead of `Z`. */
function rfc3339(ts: string): string {
  return new Date(ts)
    .toISOString()
    .replace(/\.000Z$/, "Z")
    .replace(/Z$/, "+00:00");
}

function exportItem(r: MemoryRecord): Record<string, unknown> {
  return {
    kind: r.kind,
    content: r.content,
    importance: round2(r.importance),
    confidence: round2(r.confidence),
    scope: scopeLabel(r.scope),
    created_at: rfc3339(r.created_at),
    due: r.due === null ? null : rfc3339(r.due),
  };
}

function kindLabel(kind: MemoryKind): string {
  switch (kind) {
    case "episode":
      return "經歷";
    case "fact":
      return "事實";
    case "self_note":
      return "我的筆記";
    case "followup":
      return "之後要問";
  }
}

function unregister(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}

const userArg = () => argSpec("user", "(管理員)要查看的其他人", ArgKind.user, { required: false });

function register(registry: CommandRegistry, handler: Handler): void {
  registry.setGroupDescription("memory", "我記得的關於你的事");
  const specs: [Op, string, string, ReturnType<typeof userArg>[]][] = [
    ["show", "memory show", "看看我記得關於你的哪些事(只有你看得到)", [userArg()]],
    [
      "forget",
      "memory forget",
      "讓我忘掉關於你的事",
      [argSpec("target", "要忘掉的關鍵字,或 all 忘掉全部", ArgKind.string), userArg()],
    ],
    ["export", "memory export", "匯出我記得的關於你的事(JSON)", [userArg()]],
  ];
  for (const [op, path, description, args] of specs) {
    registry.register(
      commandSpec(path, description, {
        args,
        permission: `memory.self.${op}`,
        ephemeral: true,
      }),
      (inv) => handler.run(op, inv),
    );
  }
}

/**
 * Remembers which registry the commands went into, so they can be removed on stop and
 * re-registered when the `commands` module restarts.
 */
export class MemoryCommands {
  #installed: CommandRegistry | null = null;

  /** Registers the commands in `registry` unless already there. */
  install(
    registry: CommandRegistry,
    engine: MemoryEngine,
    authorizer: AuthorizerLookup,
    clock: Clock = systemClock,
  ): void {
    if (this.#installed === registry) return;
    if (this.#installed !== null) {
      unregister(this.#installed);
      this.#installed = null;
    }
    const handler = new Handler(engine, registry.permissions(), authorizer, clock);
    try {
      register(registry, handler);
      this.#installed = registry;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not register memory commands");
      unregister(registry);
    }
  }

  uninstall(): void {
    if (this.#installed !== null) {
      unregister(this.#installed);
      this.#installed = null;
    }
  }
}
