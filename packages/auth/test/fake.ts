// In-memory AuthStore and AuditLog for tests.

import type {
  AuditEntry,
  AuditLog,
  AuthScope,
  AuthStore,
  NodeOverride,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
} from "@miyoria/store";
import type { AccountRef } from "@miyoria/types";
import { scopeEquals } from "../src/resolve.js";

const sameAccount = (a: AccountRef, b: AccountRef) => a.platform === b.platform && a.id === b.id;

export class FakeAuthStore implements AuthStore {
  roleList: RoleDefinition[] = [];
  assignmentList: RoleAssignment[] = [];
  mappingList: RoleMapping[] = [];
  overrideList: NodeOverride[] = [];
  /** Counts `mappings` calls, to check caching. */
  mappingReads = 0;

  async roles(): Promise<RoleDefinition[]> {
    return structuredClone(this.roleList);
  }

  async upsertRole(role: RoleDefinition): Promise<void> {
    this.roleList = this.roleList.filter((r) => r.name !== role.name);
    this.roleList.push(structuredClone(role));
  }

  async deleteRole(name: string): Promise<boolean> {
    const before = this.roleList.length;
    this.roleList = this.roleList.filter((r) => r.name !== name);
    return this.roleList.length !== before;
  }

  async assignmentsFor(account: AccountRef): Promise<RoleAssignment[]> {
    return structuredClone(this.assignmentList.filter((a) => sameAccount(a.account, account)));
  }

  async allAssignments(): Promise<RoleAssignment[]> {
    return structuredClone(this.assignmentList);
  }

  async assign(assignment: RoleAssignment): Promise<void> {
    this.assignmentList = this.assignmentList.filter(
      (a) =>
        !(
          sameAccount(a.account, assignment.account) &&
          a.role === assignment.role &&
          scopeEquals(a.scope, assignment.scope)
        ),
    );
    this.assignmentList.push(structuredClone(assignment));
  }

  async revoke(account: AccountRef, role: string, scope: AuthScope): Promise<boolean> {
    const before = this.assignmentList.length;
    this.assignmentList = this.assignmentList.filter(
      (a) => !(sameAccount(a.account, account) && a.role === role && scopeEquals(a.scope, scope)),
    );
    return this.assignmentList.length !== before;
  }

  async mappings(platform: string, guild: string): Promise<RoleMapping[]> {
    this.mappingReads++;
    return structuredClone(
      this.mappingList.filter((m) => m.platform === platform && m.guild === guild),
    );
  }

  async setMapping(mapping: RoleMapping): Promise<void> {
    this.mappingList = this.mappingList.filter(
      (m) =>
        !(
          m.platform === mapping.platform &&
          m.guild === mapping.guild &&
          m.platform_role === mapping.platform_role
        ),
    );
    this.mappingList.push(structuredClone(mapping));
  }

  async removeMapping(platform: string, guild: string, platformRole: string): Promise<boolean> {
    const before = this.mappingList.length;
    this.mappingList = this.mappingList.filter(
      (m) => !(m.platform === platform && m.guild === guild && m.platform_role === platformRole),
    );
    return this.mappingList.length !== before;
  }

  async overrides(): Promise<NodeOverride[]> {
    return structuredClone(this.overrideList);
  }

  async setOverride(override: NodeOverride): Promise<void> {
    this.overrideList = this.overrideList.filter(
      (o) =>
        !(
          scopeEquals(o.scope, override.scope) &&
          o.role === override.role &&
          o.node === override.node
        ),
    );
    this.overrideList.push(structuredClone(override));
  }

  async removeOverride(scope: AuthScope, role: string, node: string): Promise<boolean> {
    const before = this.overrideList.length;
    this.overrideList = this.overrideList.filter(
      (o) => !(scopeEquals(o.scope, scope) && o.role === role && o.node === node),
    );
    return this.overrideList.length !== before;
  }
}

export class FakeAudit implements AuditLog {
  entries: AuditEntry[] = [];

  /** `[action, ok]` pairs in write order. */
  actions(): [string, boolean][] {
    return this.entries.map((e) => [e.action, e.ok]);
  }

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async recent(limit: number, actor: string | null): Promise<AuditEntry[]> {
    return [...this.entries]
      .reverse()
      .filter((e) => actor === null || e.actor === actor)
      .slice(0, limit);
  }
}
