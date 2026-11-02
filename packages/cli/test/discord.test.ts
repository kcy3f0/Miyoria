import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commandsReset, DiscordApi } from "../src/commands/discord.js";

const dir = mkdtempSync(join(tmpdir(), "miyoria-cli-discord-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function fakeDiscord(guilds: string[]) {
  const calls: Call[] = [];
  let limited = true;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.replace("https://discord.com/api/v10", "");
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path === "/applications/@me") return json(200, { id: "app1" });
    if (path.startsWith("/users/@me/guilds")) {
      const after = new URL(url).searchParams.get("after") ?? "0";
      const rest = guilds.filter((g) => BigInt(g) > BigInt(after));
      return json(
        200,
        rest.slice(0, 200).map((id) => ({ id })),
      );
    }
    if (method === "PUT") {
      // One rate limit on the first PUT; the client waits and retries.
      if (limited) {
        limited = false;
        return json(429, { retry_after: 0.01 });
      }
      return json(200, []);
    }
    return json(404, {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("miyoria discord commands reset", () => {
  it("pages_through_guilds", async () => {
    const guilds = Array.from({ length: 450 }, (_, i) => String(1000 + i));
    const { fetchImpl } = fakeDiscord(guilds);
    const api = new DiscordApi("t", fetchImpl);
    expect(await api.applicationId()).toBe("app1");
    expect(await api.guildIds()).toEqual(guilds);
  });

  it("clears_the_global_set_and_every_guild", async () => {
    const config = join(dir, "miyoria.toml");
    writeFileSync(config, '[modules."platform.discord.bot"]\ntoken = "abc"\n');
    const { calls, fetchImpl } = fakeDiscord(["11", "22"]);
    await commandsReset(config, null, true, fetchImpl);
    const puts = calls.filter((c) => c.method === "PUT");
    // The rate-limited first PUT is retried.
    expect(puts.map((c) => c.url.replace("https://discord.com/api/v10", ""))).toEqual([
      "/applications/app1/commands",
      "/applications/app1/commands",
      "/applications/app1/guilds/11/commands",
      "/applications/app1/guilds/22/commands",
    ]);
    expect(puts.every((c) => Array.isArray(c.body) && c.body.length === 0)).toBe(true);
  });

  it("needs_yes_outside_a_terminal", async () => {
    const config = join(dir, "miyoria.toml");
    const { fetchImpl } = fakeDiscord([]);
    await expect(commandsReset(config, null, false, fetchImpl)).rejects.toThrow("--yes");
  });
});
