import { describe, expect, it } from "vitest";
import { Permissions, parseAccount, requiredRole } from "../src/index.js";
import { guildContext, inv } from "./helpers.js";

describe("permissions", () => {
  it("required_roles", () => {
    expect(requiredRole("admin.module.toggle")).toBe("admin");
    expect(requiredRole("owner.shutdown")).toBe("owner");
    expect(requiredRole("memory.forget.self")).toBe("user");
    expect(requiredRole("administrator")).toBe("user");
    expect(requiredRole("")).toBe("user");
  });

  it("roles_and_checks", () => {
    const perms = Permissions.fromStrings(["discord:1"]);
    const owner = inv("x", "1", {}, guildContext);
    const admin = inv("x", "2", {}, guildContext);
    admin.invoker_is_guild_admin = true;
    const user = inv("x", "3", {}, guildContext);
    expect(perms.roleOf(owner)).toBe("owner");
    expect(perms.roleOf(admin)).toBe("admin");
    expect(perms.roleOf(user)).toBe("user");

    expect(perms.allowsInvocation(owner, "owner.x")).toBe(true);
    expect(perms.allowsInvocation(owner, "admin.x")).toBe(true);
    expect(perms.allowsInvocation(admin, "owner.x")).toBe(false);
    expect(perms.allowsInvocation(admin, "admin.x")).toBe(true);
    expect(perms.allowsInvocation(user, "admin.x")).toBe(false);
    expect(perms.allowsInvocation(user, "chat")).toBe(true);
  });

  it("authorizer_checks_accounts", () => {
    const auth = Permissions.fromStrings(["discord:1"]);
    const owner = parseAccount("discord:1");
    const user = parseAccount("discord:2");
    expect(auth.allows(owner, "owner.x")).toBe(true);
    expect(auth.allows(owner, "admin.x")).toBe(true);
    expect(auth.allows(user, "chat.react")).toBe(true);
    expect(auth.allows(user, "admin.x")).toBe(false);
    expect(auth.allows(user, "owner.x")).toBe(false);
    expect(auth.allows(parseAccount("twitch:1"), "admin.x")).toBe(false);
  });

  it("owner_ids_are_platform_scoped", () => {
    const perms = Permissions.fromStrings(["twitch:1"]);
    expect(perms.isOwner(inv("x", "1").invoker)).toBe(false);
    expect(() => parseAccount("discord")).toThrow("invalid account `discord`");
    expect(() => parseAccount("discord:")).toThrow();
    expect(() => parseAccount(":1")).toThrow();
  });

  it("owners_lists_the_configured_accounts", () => {
    const perms = Permissions.fromStrings(["discord:1", " twitch:abc "]);
    expect(perms.owners()).toEqual([
      { platform: "discord", id: "1" },
      { platform: "twitch", id: "abc" },
    ]);
  });
});
