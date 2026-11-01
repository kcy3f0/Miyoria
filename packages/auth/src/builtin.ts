// Built-in roles. Each lists all of its nodes; roles do not inherit from each other.
//
// | Role | Rank | Grants | Denies |
// |---|---|---|---|
// | owner | 100 | `*` | |
// | admin | 80 | everything below plus `admin.*`, `module.*`, `memory.*`, `stream.*` | |
// | moderator | 60 | trusted plus `voice.*`, `queue.*`, `game.*`, `stream.scene`, ... | `tools.mcp.*` |
// | trusted | 40 | user plus `chat.*`, `tools.*`, `queue.priority`, `game.suggest`, `stream.clip` | `tools.mcp.*` |
// | user | 20 | restricted plus `chat.talk`, `link.*`, `voice.join`, `voice.leave`, ... | |
// | restricted | 10 | `ping`, `help.*`, `me.*`, privacy controls | |
// | blocked | 0 | nothing | |

import type { RoleDefinition } from "@miyoria/store";

export const OWNER = "owner";
export const ADMIN = "admin";
export const MODERATOR = "moderator";
export const TRUSTED = "trusted";
export const USER = "user";
export const RESTRICTED = "restricted";
export const BLOCKED = "blocked";

/**
 * Roles at or below this rank are "blocked": an explicit assignment of one beats every other
 * role source except config owners, and such roles may not use commands without a permission
 * node.
 */
export const BLOCKED_RANK = 0;

/**
 * Lets a Discord-logged-in user into the admin panel (`/api/*` reads). `owner` and `admin` have
 * it through `*` / `admin.*`.
 */
export const PANEL_ACCESS = "admin.panel.access";
/** Lets a panel user make changes (every non-`GET` admin API route). */
export const PANEL_WRITE = "admin.panel.write";

/** Self-service privacy controls; kept even for `restricted`. */
const PRIVACY: readonly string[] = [
  "ping",
  "help.*",
  "me.*",
  "memory.self.*",
  "memory.show.self",
  "memory.forget.self",
  "memory.export.self",
  "voice.consent",
];

const EVERYDAY: readonly string[] = [
  "chat.talk",
  "link.*",
  "voice.join",
  "voice.leave",
  "queue.request",
  "queue.list",
  "game.status",
  "stream.status",
];

const TRUSTED_EXTRA: readonly string[] = [
  "chat.*",
  "tools.*",
  "queue.priority",
  "game.suggest",
  "stream.clip",
];

const MODERATOR_EXTRA: readonly string[] = [
  "voice.*",
  "queue.*",
  "game.*",
  "stream.scene",
  "memory.view.others",
  "admin.channel.*",
  "admin.voice.*",
  "admin.block.*",
  "admin.persona.view",
  "admin.role.list",
  "admin.role.whois",
  "admin.audit.view",
];

const ADMIN_EXTRA: readonly string[] = ["admin.*", "module.*", "memory.*", "stream.*"];

/** MCP tools can do anything their server can; below admin they need an explicit override. */
const NO_MCP: readonly string[] = ["tools.mcp.*"];

function role(
  name: string,
  rank: number,
  grants: readonly (readonly string[])[],
  denies: readonly string[],
): RoleDefinition {
  return { name, rank, grants: grants.flat(), denies: [...denies], builtin: true };
}

/** The seven built-in roles, highest rank first. */
export function builtinRoles(): RoleDefinition[] {
  return [
    role(OWNER, 100, [["*"]], []),
    role(ADMIN, 80, [PRIVACY, EVERYDAY, TRUSTED_EXTRA, MODERATOR_EXTRA, ADMIN_EXTRA], []),
    role(MODERATOR, 60, [PRIVACY, EVERYDAY, TRUSTED_EXTRA, MODERATOR_EXTRA], NO_MCP),
    role(TRUSTED, 40, [PRIVACY, EVERYDAY, TRUSTED_EXTRA], NO_MCP),
    role(USER, 20, [PRIVACY, EVERYDAY], []),
    role(RESTRICTED, 10, [PRIVACY], []),
    role(BLOCKED, BLOCKED_RANK, [], []),
  ];
}
