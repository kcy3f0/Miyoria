import { CommandRegistry, CommandReply, commandSpec } from "@miyoria/commands";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runSyncLoop, SYNC_DEBOUNCE_MS, type SyncRest, syncCommands } from "../src/sync.js";

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
        body: [{ name: "ping", description: "Ping", options: [] }],
      },
    ]);
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
