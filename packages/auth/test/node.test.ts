import { describe, expect, test } from "vitest";
import { isValidPattern, matches } from "../src/node.js";

describe("node patterns", () => {
  test("pattern_matching", () => {
    expect(matches("*", "anything.at.all")).toBe(true);
    expect(matches("queue.*", "queue")).toBe(true);
    expect(matches("queue.*", "queue.skip")).toBe(true);
    expect(matches("queue.*", "queue.skip.self")).toBe(true);
    expect(matches("queue.*", "queuex")).toBe(false);
    expect(matches("queue.*", "queue_x.skip")).toBe(false);
    expect(matches("voice.consent", "voice.consent")).toBe(true);
    expect(matches("voice.consent", "voice.consent.x")).toBe(false);
    expect(matches("voice.consent", "voice")).toBe(false);
    expect(matches("admin.*", "admin.role.*")).toBe(true);
    expect(matches("memory.self.*", "memory.*")).toBe(false);
  });

  test("pattern_validation", () => {
    for (const ok of ["*", "ping", "admin.*", "tools.mcp.my-server.do_it", "a1.b2"]) {
      expect(isValidPattern(ok), ok).toBe(true);
    }
    for (const bad of ["", ".*", "a..b", "A.b", "a.*.b", "a b", "a.", "*.a", "a*"]) {
      expect(isValidPattern(bad), bad).toBe(false);
    }
  });
});
