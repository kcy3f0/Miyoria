// Tools by what she is doing (v2 §3.4) and claims backed by structured signals (§1.8 #5).

import { ActuatorRegistry, CapabilityTool, defineCapability } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { MockProvider } from "@miyoria/llm";
import { type ToolContext, ToolRegistry } from "@miyoria/tools";
import {
  type ActivityManager,
  ActivityManagerKey,
  type ActivitySnapshot,
  type ActivityTask,
  type HerActivity,
  type HerPresence,
  type JsonValue,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { offeredIn, scopeOfSnapshot } from "../src/tool-scope.js";
import {
  channel,
  Harness,
  mention,
  noCheck,
  Probe,
  stopHarnesses,
  toolCall,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

const AT = toTimestamp(Date.UTC(2026, 10, 3));

function snapshot(
  activity: HerActivity = { type: "idle", since: AT },
  presence: HerPresence = { type: "none" },
): ActivitySnapshot {
  return {
    version: 1,
    at: AT,
    presence,
    broadcast: { type: "off" },
    activity,
    override: null,
    scene: null,
  };
}

const PLAYING: HerActivity = {
  type: "game",
  target: "minecraft",
  phase: "running",
  task: null,
  failure: null,
  since: AT,
};

/** An ActivityManager that only answers reads. */
class FakeManager implements ActivityManager {
  readonly tasksList: ActivityTask[] = [];
  constructor(public current: ActivitySnapshot) {}
  snapshot(): ActivitySnapshot {
    return this.current;
  }
  async request(): Promise<never> {
    throw new Error("not in this test");
  }
  cancel(): boolean {
    return false;
  }
  task(id: string): ActivityTask | null {
    return this.tasksList.find((t) => t.id === id) ?? null;
  }
  tasks(): ActivityTask[] {
    return [...this.tasksList];
  }
}

/** A capability tool (the gated kind a game's `game.*` capabilities are) that records calls. */
class CapProbe extends CapabilityTool {
  readonly calls: JsonValue[] = [];

  constructor(name: string) {
    super(
      new ActuatorRegistry({
        services: new ServiceRegistry(),
        tools: new ToolRegistry(),
        builtins: false,
      }),
      defineCapability({
        name: name.replace("_", "."),
        summary: name,
        risk: "low",
        args: z.object({}),
        permission: null,
        tool: { name, description: name, properties: {} },
        async execute() {
          return "done";
        },
      }),
    );
  }

  override async call(_ctx: ToolContext, args: JsonValue): Promise<string> {
    this.calls.push(args);
    return "done";
  }
}

const tools = () => ({
  goal: new CapProbe("game_goal"),
  start: new CapProbe("game_start"),
  stop: new CapProbe("game_stop"),
  raw: new Probe("game_minecraft_act"),
  join: new Probe("voice_join"),
  leave: new Probe("voice_leave"),
});

describe("tool scope", () => {
  it("offers no game tools while she is just chatting, the goal tool while a game runs", () => {
    const t = tools();
    const idle = scopeOfSnapshot(snapshot());
    expect(offeredIn(t.goal, idle)).toBe(false);
    expect(offeredIn(t.stop, idle)).toBe(false);
    expect(offeredIn(t.start, idle)).toBe(true);
    const playing = scopeOfSnapshot(snapshot(PLAYING));
    expect(offeredIn(t.goal, playing)).toBe(true);
    expect(offeredIn(t.stop, playing)).toBe(true);
    // A starting game already takes a goal (applied once the session runs).
    const starting = scopeOfSnapshot(snapshot({ ...PLAYING, phase: "starting" }));
    expect(offeredIn(t.goal, starting)).toBe(true);
    // A failed game is no game to steer.
    const failed = scopeOfSnapshot(snapshot({ ...PLAYING, phase: "failed" }));
    expect(offeredIn(t.goal, failed)).toBe(false);
  });

  it("never offers a game adapter's raw tool, whatever the state (or none known)", () => {
    const t = tools();
    expect(offeredIn(t.raw, scopeOfSnapshot(snapshot(PLAYING)))).toBe(false);
    expect(offeredIn(t.raw, null)).toBe(false);
    expect(offeredIn(t.goal, null)).toBe(true);
  });

  it("a chat turn gets the tools of the ActivityManager's snapshot", async () => {
    const manager = new FakeManager(snapshot());
    const chat = new MockProvider("chat").reply("好啊").reply("好啊");
    const t = tools();
    const h = await Harness.build("always", noCheck(), chat, null, {
      tools: Object.values(t),
      provide: (s) => s.provide("app", ActivityManagerKey, manager),
    });
    h.say(mention(channel("c"), "Owen", "在嗎"));
    await wait(3000);
    const offered = (chat.requests()[0]?.tools ?? []).map((s) => s.name);
    expect(offered).toEqual(["game_start", "react", "voice_join"]);

    manager.current = snapshot(PLAYING, {
      type: "in",
      channel: { platform: "test", scope: "guild", channel: "v", kind: "voice" },
      since: AT,
    });
    h.say(mention(channel("c"), "Owen", "去挖鐵"));
    await wait(3000);
    const playing = (chat.requests()[1]?.tools ?? []).map((s) => s.name);
    expect(playing).toEqual([
      "game_goal",
      "game_start",
      "game_stop",
      "react",
      "voice_join",
      "voice_leave",
    ]);
  });

  it("refuses a call of a tool that is not offered now", async () => {
    const manager = new FakeManager(snapshot());
    const chat = new MockProvider("chat")
      .events([
        toolCall(0, "c1", "game_goal", '{"text":"挖鐵"}'),
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("沒在玩啦");
    const t = tools();
    const h = await Harness.build("always", noCheck(), chat, null, {
      tools: Object.values(t),
      provide: (s) => s.provide("app", ActivityManagerKey, manager),
    });
    h.say(mention(channel("c"), "Owen", "去挖鐵"));
    await wait(3000);
    expect(t.goal.calls).toHaveLength(0);
    expect(h.sink.texts()).toEqual(["沒在玩啦"]);
  });
});
