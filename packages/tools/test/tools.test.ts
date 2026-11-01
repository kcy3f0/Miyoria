import { describe, expect, it } from "vitest";
import { InvalidToolNameError, type Tool, type ToolContext, ToolRegistry } from "../src/index.js";

function tool(name: string, permission: string | null = null): Tool {
  return {
    spec: { name, description: `tool ${name}`, parameters: { type: "object" } },
    permission,
    call: async (_ctx, args) => `${name}:${JSON.stringify(args)}`,
  };
}

describe("ToolRegistry", () => {
  it("registers by name, ordered, with the legacy name rules", async () => {
    const reg = new ToolRegistry();
    expect(reg.isEmpty).toBe(true);
    reg.register(tool("roll"));
    reg.register(tool("memory_search", "memory.search"));
    reg.register(tool("a-b_C9"));
    reg.register(tool("x".repeat(64)));
    expect(reg.names()).toEqual(["a-b_C9", "memory_search", "roll", "x".repeat(64)]);
    expect(reg.specs().map((s) => s.name)).toEqual(reg.names());

    for (const bad of ["", "has space", "dot.ted", "x".repeat(65), "中文"]) {
      expect(() => reg.register(tool(bad))).toThrow(InvalidToolNameError);
    }
    expect(() => reg.register(tool("a.b"))).toThrow("invalid tool name `a.b`");

    // Replacing keeps one entry.
    reg.register(tool("roll", "dice"));
    expect(reg.get("roll")?.permission).toBe("dice");
    expect(reg.names()).toHaveLength(4);

    const ctx = {
      turn: "01JC0000000000000000000000",
      context: { platform: "cli", scope: null, channel: "c", kind: "dm" },
      account: { platform: "cli", id: "u" },
      message: { context: { platform: "cli", scope: null, channel: "c", kind: "dm" }, id: "m" },
      priority: "direct",
      signal: new AbortController().signal,
    } satisfies ToolContext;
    expect(await reg.get("roll")?.call(ctx, { sides: 6 })).toBe('roll:{"sides":6}');

    expect(reg.unregister("roll")).toBe(true);
    expect(reg.unregister("roll")).toBe(false);
    expect(reg.get("roll")).toBeUndefined();
  });
});
