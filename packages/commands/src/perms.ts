// Fallback permissions: three fixed roles derived from the permission node prefix. Used when no
// `Authorizer` service (the `auth` module's RBAC) is available.

import { type AccountRef, BaseAuthorizer, type PlatformId, type Subject } from "@miyoria/types";
import { CommandError, type InvocationData } from "./spec.js";

/** `owner` (listed in `[modules.commands] owners`) > `admin` (owner or guild admin) > `user`. */
export type Role = "user" | "admin" | "owner";

export const ROLE_RANK: Readonly<Record<Role, number>> = { user: 0, admin: 1, owner: 2 };

/**
 * `owner.*` needs `owner`, `admin.*` needs `admin`, everything else `user`
 * (Rust `Role::required_for`).
 */
export function requiredRole(permission: string): Role {
  const root = permission.split(".")[0];
  if (root === "owner") return "owner";
  if (root === "admin") return "admin";
  return "user";
}

const accountKey = (account: AccountRef): string => `${account.platform}\0${account.id}`;

/** Resolves the role of an invoker. Also the fallback `Authorizer`. */
export class Permissions extends BaseAuthorizer {
  readonly #owners = new Map<string, AccountRef>();

  constructor(owners: Iterable<AccountRef> = []) {
    super();
    for (const owner of owners) this.#owners.set(accountKey(owner), owner);
  }

  /** Parses `"platform:id"` strings such as `"discord:123"`. */
  static fromStrings(owners: readonly string[]): Permissions {
    return new Permissions(owners.map(parseAccount));
  }

  isOwner(account: AccountRef): boolean {
    return this.#owners.has(accountKey(account));
  }

  /** The configured owners. */
  owners(): AccountRef[] {
    return [...this.#owners.values()];
  }

  roleOf(invocation: Pick<InvocationData, "invoker" | "invoker_is_guild_admin">): Role {
    return this.#role(invocation.invoker, invocation.invoker_is_guild_admin);
  }

  /** Rust `Permissions::allows(&Invocation, &str)`; `allows(account, node)` is the Authorizer's. */
  allowsInvocation(
    invocation: Pick<InvocationData, "invoker" | "invoker_is_guild_admin">,
    permission: string,
  ): boolean {
    return ROLE_RANK[this.roleOf(invocation)] >= ROLE_RANK[requiredRole(permission)];
  }

  /**
   * Account-only checks (e.g. tools run on behalf of the user who triggered a turn). Without
   * guild-admin information an account is either an owner or a plain user, so `admin.*` nodes
   * are granted to owners only.
   */
  allowsSubject(subject: Subject, node: string): boolean {
    const role = this.#role(subject.account, subject.is_guild_admin);
    return ROLE_RANK[role] >= ROLE_RANK[requiredRole(node)];
  }

  #role(account: AccountRef, isGuildAdmin: boolean): Role {
    if (this.isOwner(account)) return "owner";
    return isGuildAdmin ? "admin" : "user";
  }
}

/** Parses `"platform:id"` into an `AccountRef`. */
export function parseAccount(s: string): AccountRef {
  const trimmed = s.trim();
  const colon = trimmed.indexOf(":");
  if (colon > 0 && colon < trimmed.length - 1) {
    const platform: PlatformId = trimmed.slice(0, colon);
    return { platform, id: trimmed.slice(colon + 1) };
  }
  throw new CommandError(`invalid account \`${s}\`, expected \`platform:id\``);
}
