import type { RoleDefinition } from "@miyoria/store";
import { describe, expect, test } from "vitest";
import {
  ADMIN,
  BLOCKED,
  builtinRoles,
  builtinStatus,
  LEGACY_BUILTIN_GRANTS,
  MODERATOR,
  OWNER,
  PANEL_ACCESS,
  PANEL_WRITE,
  RESTRICTED,
  TRUSTED,
  USER,
} from "../src/builtin.js";
import { isValidPattern, matches } from "../src/node.js";

function allows(role: RoleDefinition, node: string): boolean {
  return !role.denies.some((p) => matches(p, node)) && role.grants.some((p) => matches(p, node));
}

describe("built-in roles", () => {
  test("builtins_are_ordered_and_valid", () => {
    const roles = builtinRoles();
    expect(roles).toHaveLength(7);
    for (let i = 1; i < roles.length; i++) {
      expect((roles[i - 1] as RoleDefinition).rank).toBeGreaterThan(
        (roles[i] as RoleDefinition).rank,
      );
    }
    for (const r of roles) {
      for (const p of [...r.grants, ...r.denies]) {
        expect(isValidPattern(p), `${r.name}: ${p}`).toBe(true);
      }
      expect(r.builtin).toBe(true);
    }
  });

  test("web_tools_for_members", () => {
    const roles = builtinRoles();
    const get = (n: string) => roles.find((r) => r.name === n) as RoleDefinition;
    for (const name of [ADMIN, MODERATOR, TRUSTED, USER]) {
      expect(allows(get(name), "tools.web"), name).toBe(true);
    }
    expect(allows(get(RESTRICTED), "tools.web")).toBe(false);
    expect(allows(get(BLOCKED), "tools.web")).toBe(false);
    // Searching the web is not a licence for every tool.
    expect(allows(get(USER), "tools.mcp.fs.write")).toBe(false);
    expect(allows(get(USER), "tools.sandbox.x")).toBe(false);
  });

  test("a_stored_role_from_before_tools_web_is_upgraded", () => {
    for (const name of [ADMIN, MODERATOR, TRUSTED, USER]) {
      const current = builtinRoles().find((r) => r.name === name) as RoleDefinition;
      const legacy = LEGACY_BUILTIN_GRANTS[name] ?? [];
      expect(legacy.length, name).toBeGreaterThan(0);
      for (const old of legacy) {
        expect(old, name).not.toContain("tools.web");
        expect(builtinStatus({ ...current, grants: [...old] }), name).toBe("upgrade");
      }
      // The latest legacy list is today's grants without tools.web, in the same order.
      expect(legacy.at(-1), name).toEqual(current.grants.filter((g) => g !== "tools.web"));
      expect(builtinStatus(current), name).toBe("current");
    }
  });

  test("builtin_nodes", () => {
    const roles = builtinRoles();
    const get = (n: string) => roles.find((r) => r.name === n) as RoleDefinition;
    expect(allows(get(OWNER), "owner.shutdown")).toBe(true);
    expect(allows(get(ADMIN), "owner.shutdown")).toBe(false);
    expect(allows(get(ADMIN), "admin.module.toggle")).toBe(true);
    expect(allows(get(ADMIN), "tools.mcp.fs.write")).toBe(true);
    expect(allows(get(MODERATOR), "tools.mcp.fs.write")).toBe(false);
    expect(allows(get(MODERATOR), "admin.channel.mode")).toBe(true);
    expect(allows(get(MODERATOR), "admin.module.toggle")).toBe(false);
    expect(allows(get(TRUSTED), "tools.web.search")).toBe(true);
    expect(allows(get(USER), "voice.join")).toBe(true);
    expect(allows(get(USER), "help")).toBe(true);
    expect(allows(get(USER), "queue.vote")).toBe(true);
    expect(allows(get(USER), "channel.mode.view")).toBe(true);
    expect(allows(get(MODERATOR), "admin.person.block")).toBe(true);
    expect(allows(get(MODERATOR), "memory.view.others")).toBe(false);
    expect(allows(get(USER), "queue.skip")).toBe(false);
    expect(allows(get(USER), "admin.channel.mode")).toBe(false);
    expect(allows(get(RESTRICTED), "memory.self.forget")).toBe(true);
    expect(allows(get(RESTRICTED), "voice.consent")).toBe(true);
    expect(allows(get(RESTRICTED), "voice.join")).toBe(false);
    expect(allows(get(BLOCKED), "help")).toBe(false);
  });

  test("panel_nodes_are_held_by_owner_and_admin_only", () => {
    expect(PANEL_ACCESS).toBe("admin.panel.access");
    expect(PANEL_WRITE).toBe("admin.panel.write");
    for (const r of builtinRoles()) {
      const expected = r.name === OWNER || r.name === ADMIN;
      expect(allows(r, PANEL_ACCESS), r.name).toBe(expected);
      expect(allows(r, PANEL_WRITE), r.name).toBe(expected);
    }
  });
});
