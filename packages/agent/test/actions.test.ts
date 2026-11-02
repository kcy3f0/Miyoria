// `channel.activeness`: her temporary activeness, through the gate, reverting on its own; and
// tool calls in a reactive turn carry the `user` principal.

import { ActuatorRegistry } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { MockProvider } from "@miyoria/llm";
import { type ToolContext, ToolRegistry } from "@miyoria/tools";
import { type AccountRef, Principals } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activenessCapability } from "../src/actions.js";
import { channel, Harness, incoming, noCheck, Probe } from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const OWEN: AccountRef = { platform: "test", id: "Owen" };

describe("channel.activeness", () => {
  it("sets her activeness here for a while, then reverts", async () => {
    const h = await Harness.create("always", noCheck(), new MockProvider("chat").reply("好"));
    const handle = h.handle();
    const c = channel("c");
    const before = handle.activeness(c);
    const tools = new ToolRegistry();
    const registry = new ActuatorRegistry({ services: h.sup.services, tools, builtins: false });
    registry.register(activenessCapability(handle, { now: () => Date.now() }));
    const ctx: ToolContext = {
      turn: "01JC0000000000000000000000",
      context: c,
      account: OWEN,
      principal: Principals.user(OWEN, c),
      message: { context: c, id: "m" },
      priority: "direct",
      signal: new AbortController().signal,
    };
    const tool = tools.get("channel_activeness");
    // Owen may not change the channel setting; she may choose to be livelier herself.
    await expect(tool?.call(ctx, { level: "high" })).rejects.toThrow(/not allowed/);
    expect(handle.activeness(c)).toBe(before);
    expect(await tool?.call(ctx, { level: "high", minutes: 10, on_own: true })).toContain(
      "for 10 min",
    );
    expect(handle.activeness(c)).toBe("high");
    expect(handle.activeness(channel("other"))).toBe(before);
    vi.advanceTimersByTime(10 * 60_000);
    expect(handle.activeness(c), "reverted").toBe(before);
    await expect(tool?.call(ctx, { level: "loud", on_own: true })).rejects.toThrow(/invalid/);
  });

  it("tool calls in a reactive turn run for the speaker", async () => {
    const mock = new MockProvider("chat")
      .events([
        { type: "tool_call_delta", index: 0, id: "c1", name: "probe", arguments: "{}" },
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("好了");
    const probe = new Probe("probe");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [probe] });
    h.say(incoming(channel("c"), "Owen", "幫我一下"));
    await vi.advanceTimersByTimeAsync(3000);
    const [ctx] = probe.calls[0] ?? [];
    expect(ctx?.principal).toEqual(Principals.user(OWEN, channel("c")));
  });

  it("registers in the app's actuator registry while running", async () => {
    const appTools = new ToolRegistry();

    const services = new ServiceRegistry();
    const app = new ActuatorRegistry({ services, tools: appTools, builtins: false });
    const h = await Harness.build("always", noCheck(), new MockProvider("chat").reply("好"), null, {
      appTools,
      actuators: app,
    });
    expect(app.names()).toEqual(["channel.activeness"]);
    expect(appTools.names()).toContain("channel_activeness");
    await h.sup.disable("agent");
    expect(app.names()).toEqual([]);
  });
});
