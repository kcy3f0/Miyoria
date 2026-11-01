import type { Tool } from "@miyoria/tools";
import { describe, expect, it } from "vitest";
import { parseCheck, ToolRegistry, truncate } from "../src/index.js";

const named = (name: string): Tool => ({
  spec: { name, description: "test", parameters: { type: "object" } },
  call: async () => "ok",
});

describe("tools", () => {
  it("register_and_unregister", () => {
    const reg = new ToolRegistry();
    expect(reg.isEmpty).toBe(true);
    reg.register(named("b_tool"));
    reg.register(named("a-tool"));
    reg.register(named("a-tool"));
    expect(() => reg.register(named("bad name"))).toThrow();
    expect(() => reg.register(named(""))).toThrow();
    expect(reg.names()).toEqual(["a-tool", "b_tool"]);
    expect(reg.specs().length).toBe(2);
    expect(reg.get("a-tool")).toBeDefined();
    expect(reg.unregister("a-tool")).toBe(true);
    expect(reg.unregister("a-tool")).toBe(false);
    expect(reg.names()).toEqual(["b_tool"]);
  });
});

describe("turn", () => {
  it("parses_check_replies", () => {
    const r = parseCheck('```json\n{"respond": true, "reason": "被問問題"}\n```');
    expect(r.respond).toBe(true);
    expect(r.reason).toBe("被問問題");
    expect(parseCheck('{"respond": false}').respond).toBe(false);
    expect(() => parseCheck("yes")).toThrow("no JSON object in fast model reply");
    expect(() => parseCheck('{"respond": "maybe"}')).toThrow("invalid JSON from fast model");
  });

  it("truncates_tool_results", () => {
    expect(truncate("短", 5)).toBe("短");
    expect(truncate("一二三四五六", 3)).toBe("一二三…");
  });
});
