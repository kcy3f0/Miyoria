import { CommandRegistry, CommandReply, commandSpec, registerPanels } from "@miyoria/commands";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  resetCommands,
  runSyncLoop,
  SYNC_DEBOUNCE_MS,
  type SyncRest,
  syncCommands,
  syncRunner,
} from "../src/sync.js";

afterEach(() => {
  vi.useRealTimers();
});

const handler = () => CommandReply.public("ok");

class FakeRest implements SyncRest {
  puts: { route: string; body: unknown }[] = [];
  failFor: string | null = null;

  async put(route: `/${string}`, options?: { body?: unknown }): Promise<unknown> {
    this.puts.push({ route, body: options?.body });
    if (this.failFor && route.includes(this.failFor)) throw new Error("Missing Access");
    return [];
  }
}

describe("syncCommands", () => {
  test("registers_globally_without_command_guilds", async () => {
    const registry = new CommandRegistry();
    registry.register(commandSpec("ping", "Ping"), handler);
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, []);
    expect(rest.puts).toEqual([
      {
        route: "/applications/app1/commands",
        body: [
          {
            name: "ping",
            description: "Ping",
            options: [],
            default_member_permissions: null,
            contexts: [0, 1],
            integration_types: [0],
          },
        ],
      },
    ]);
  });

  test("guild_mode_clears_the_global_set_and_other_guilds_once", async () => {
    const registry = new CommandRegistry();
    registry.register(commandSpec("help", "Help"), handler);
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, ["g1"], { cleanup: { guilds: ["g1", "g9"] } });
    expect(rest.puts).toEqual([
      { route: "/applications/app1/guilds/g1/commands", body: expect.any(Array) },
      { route: "/applications/app1/commands", body: [] },
      { route: "/applications/app1/guilds/g9/commands", body: [] },
    ]);
    // Later syncs only touch the command guilds.
    rest.puts = [];
    await syncCommands(rest, "app1", registry, ["g1"], { cleanup: null });
    expect(rest.puts.map((p) => p.route)).toEqual(["/applications/app1/guilds/g1/commands"]);
  });

  test("global_mode_clears_every_guild_set", async () => {
    const registry = new CommandRegistry();
    registry.register(commandSpec("help", "Help"), handler);
    const rest = new FakeRest();
    rest.failFor = "/guilds/g2/";
    await syncCommands(rest, "app1", registry, [], { cleanup: { guilds: ["g1", "g2", "g3"] } });
    expect(rest.puts.map((p) => [p.route, Array.isArray(p.body) && p.body.length])).toEqual([
      ["/applications/app1/commands", 1],
      ["/applications/app1/guilds/g1/commands", 0],
      ["/applications/app1/guilds/g2/commands", 0],
      ["/applications/app1/guilds/g3/commands", 0],
    ]);
  });

  test("invalid_commands_are_left_out_instead_of_failing_the_whole_put", async () => {
    const registry = new CommandRegistry();
    registry.register(commandSpec("help", "Help"), handler);
    registry.register(commandSpec("bad sub", "x"), handler);
    // A group description Discord rejects (empty).
    registry.setGroupDescription("bad", "");
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, []);
    const body = rest.puts[0]?.body as { name: string }[];
    expect(body.map((c) => c.name)).toEqual(["help"]);
  });

  test("reset_clears_the_global_set_and_every_guild", async () => {
    const rest = new FakeRest();
    rest.failFor = "/guilds/g2/";
    const report = await resetCommands(rest, "app1", ["g1", "g2"]);
    expect(rest.puts.every((p) => Array.isArray(p.body) && p.body.length === 0)).toBe(true);
    expect(report.cleared).toEqual(["global", "g1"]);
    expect(report.failed).toEqual([{ scope: "g2", error: "Missing Access" }]);
  });

  test("registers_in_each_command_guild_and_survives_failures", async () => {
    const registry = new CommandRegistry();
    registry.register(commandSpec("admin role list", "List"), handler);
    registry.setGroupDescription("admin", "管理");
    const rest = new FakeRest();
    rest.failFor = "/guilds/g1/";
    await syncCommands(rest, "app1", registry, ["g1", "g2"]);
    expect(rest.puts.map((p) => p.route)).toEqual([
      "/applications/app1/guilds/g1/commands",
      "/applications/app1/guilds/g2/commands",
    ]);
    const body = (rest.puts[1]?.body ?? []) as { description: string }[];
    expect(body[0]?.description).toBe("管理");
  });
});

describe("runSyncLoop", () => {
  test("syncs_once_then_debounces_bursts_of_changes", async () => {
    vi.useFakeTimers();
    const registry = new CommandRegistry();
    const controller = new AbortController();
    let syncs = 0;
    const loop = runSyncLoop({
      registry,
      signal: controller.signal,
      sync: async () => {
        syncs++;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(syncs).toBe(1);

    registry.register(commandSpec("a", "A"), handler);
    await vi.advanceTimersByTimeAsync(500);
    registry.register(commandSpec("b", "B"), handler);
    await vi.advanceTimersByTimeAsync(500);
    registry.unregister("a");
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS - 1001);
    expect(syncs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncs).toBe(2);

    // Quiet: nothing more.
    await vi.advanceTimersByTimeAsync(10 * SYNC_DEBOUNCE_MS);
    expect(syncs).toBe(2);

    registry.register(commandSpec("c", "C"), handler);
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
    expect(syncs).toBe(3);

    controller.abort();
    await loop;
  });

  test("stops_when_aborted_during_the_debounce", async () => {
    vi.useFakeTimers();
    const registry = new CommandRegistry();
    const controller = new AbortController();
    let syncs = 0;
    const loop = runSyncLoop({
      registry,
      signal: controller.signal,
      sync: async () => {
        syncs++;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    registry.register(commandSpec("a", "A"), handler);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await loop;
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 2);
    expect(syncs).toBe(1);
  });
});

describe("the slash surface", () => {
  function panelRegistry(): CommandRegistry {
    const registry = new CommandRegistry(undefined, { surface: "panels" });
    for (const path of [
      "voice join",
      "voice consent",
      "queue song request",
      "queue manage next",
      "me privacy",
      "me memory forget",
      "admin person block",
      "admin module list",
      "game start",
      "stream scene",
      "channel mode",
      "help",
    ]) {
      registry.register(commandSpec(path, `desc ${path}`), handler);
    }
    registerPanels(registry);
    return registry;
  }

  test("discord_gets_four_commands_and_no_old_subcommands", async () => {
    const registry = panelRegistry();
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, ["g1"], { cleanup: { guilds: ["g1", "g9"] } });
    const body = rest.puts[0]?.body as {
      name: string;
      options: { name: string; type: number }[];
    }[];
    expect(body.map((c) => c.name)).toEqual(["admin", "me", "miyo", "song"]);
    // The old tree (`/voice`, `/queue`, `/game`, ...) is not sent, and the overwrite replaces
    // whatever Discord held, so those commands vanish. Other scopes are emptied once.
    expect(body.flatMap((c) => c.options.filter((o) => o.type <= 2))).toEqual([]);
    expect(rest.puts.slice(1)).toEqual([
      { route: "/applications/app1/commands", body: [] },
      { route: "/applications/app1/guilds/g9/commands", body: [] },
    ]);
  });

  test("admin_takes_an_optional_user_and_is_not_gated_by_manage_server", async () => {
    const registry = panelRegistry();
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, []);
    const body = rest.puts[0]?.body as {
      name: string;
      default_member_permissions: string | null;
      contexts: number[];
      options: { name: string; type: number; required?: boolean }[];
    }[];
    const by = new Map(body.map((c) => [c.name, c]));
    expect(by.get("admin")?.default_member_permissions).toBeNull();
    expect(by.get("admin")?.options).toEqual([
      expect.objectContaining({ name: "user", type: 6, required: false }),
    ]);
    // `/me` also works in DMs (privacy), the others only in servers.
    expect(by.get("me")?.contexts).toEqual([0, 1]);
    expect(by.get("miyo")?.contexts).toEqual([0]);
    expect(by.get("song")?.contexts).toEqual([0]);
  });

  test("an_empty_set_never_overwrites_what_discord_has", async () => {
    const registry = new CommandRegistry(undefined, { surface: "panels" });
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, ["g1"], { cleanup: { guilds: ["g1", "g9"] } });
    // Nothing is written to the command guild; only the scopes not in use are cleared.
    expect(rest.puts.map((p) => p.route)).toEqual([
      "/applications/app1/commands",
      "/applications/app1/guilds/g9/commands",
    ]);
  });

  test("the_runner_skips_a_sync_when_the_slash_set_did_not_change", async () => {
    const registry = panelRegistry();
    const rest = new FakeRest();
    const sync = syncRunner({
      rest,
      applicationId: "app1",
      registry,
      commandGuilds: ["g1"],
      guilds: () => ["g1", "g9"],
    });
    await sync(true);
    expect(rest.puts).toHaveLength(3);
    rest.puts = [];
    // A module registering a command behind the panels changes nothing Discord shows.
    registry.register(commandSpec("ext hello", "hello"), handler);
    await sync(false);
    expect(rest.puts).toEqual([]);
    // A change to the panels themselves goes out, without the one-time cleanup.
    registry.registerPanel(commandSpec("song", "點歌與歌單（新）"), handler);
    await sync(false);
    expect(rest.puts.map((p) => p.route)).toEqual(["/applications/app1/guilds/g1/commands"]);
    // The first sync of a run always goes out.
    rest.puts = [];
    await sync(true);
    expect(rest.puts).toHaveLength(3);
  });
});
