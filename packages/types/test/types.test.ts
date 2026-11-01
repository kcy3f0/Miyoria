import { describe, expect, it } from "vitest";
import {
  type ContextKey,
  comparePriority,
  contextKeyEquals,
  contextKeyString,
  customEvent,
  type Envelope,
  EVENT_TOPICS,
  type Event,
  eventTopic,
  isActionExpired,
  isEvent,
  isUlid,
  newAction,
  newEnvelope,
  newId,
  type Priority,
  PromptContributors,
  serviceKey,
  textLane,
  voiceLane,
} from "../src/index.js";

const guild: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };

describe("ContextKey", () => {
  it("display form, including the voice infix and DMs", () => {
    expect(contextKeyString(guild)).toBe("discord:g1:c1");
    expect(contextKeyString({ ...guild, kind: "voice" })).toBe("discord:g1:voice:c1");
    expect(contextKeyString({ ...guild, scope: null, kind: "dm" })).toBe("discord:dm:c1");
    expect(contextKeyString({ ...guild, scope: null, kind: "voice" })).toBe("discord:dm:voice:c1");
    // Thread and channel share the display form; equality looks at the kind.
    expect(contextKeyString({ ...guild, kind: "thread" })).toBe("discord:g1:c1");
    expect(contextKeyEquals(guild, { ...guild, kind: "thread" })).toBe(false);
    expect(contextKeyEquals(guild, { ...guild })).toBe(true);
  });

  it("lanes", () => {
    expect(textLane(guild)).toBe("text:discord:g1:c1");
    expect(voiceLane("discord", "g1")).toBe("voice:discord:g1");
  });
});

describe("Action", () => {
  it("priority order and serde names", () => {
    const sorted: Priority[] = ["idle", "direct", "system", "initiative", "request"];
    expect(sorted.sort(comparePriority)).toEqual([
      "system",
      "direct",
      "request",
      "initiative",
      "idle",
    ]);
  });

  it("matches the Rust JSON shape and expires after its ttl", () => {
    const now = Date.parse("2026-03-10T00:00:00Z");
    const action = newAction(
      textLane(guild),
      "direct",
      { type: "send_message", context: guild, message: { text: "hi", reply_to: null } },
      { now },
    );
    const json = JSON.parse(JSON.stringify(action));
    expect(json).toEqual({
      id: action.id,
      lane: "text:discord:g1:c1",
      priority: "direct",
      created_at: "2026-03-10T00:00:00.000Z",
      ttl: 120000,
      coalesce_key: null,
      turn: null,
      payload: {
        type: "send_message",
        context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
        message: { text: "hi", reply_to: null },
      },
    });
    expect(isActionExpired(action, now + 120_000)).toBe(false);
    expect(isActionExpired(action, now + 120_001)).toBe(true);
    // A clock that went backwards never expires an action.
    expect(isActionExpired(action, now - 1_000_000)).toBe(false);
  });
});

describe("Event", () => {
  it("adjacently tagged JSON, same as serde", () => {
    // Taken from docs/protocols/extension-rpc.md.
    const wire = `{"type":"agent_turn_completed","data":{"turn":"01JC0000000000000000000000","context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},"text":"沒幹嘛啊"}}`;
    const event = JSON.parse(wire) as Event;
    expect(eventTopic(event)).toBe("agent.turn.completed");
    expect(JSON.stringify(event)).toBe(wire);
    expect(isEvent(event, "agent_turn_completed") && event.data.text).toBe("沒幹嘛啊");
  });

  it("topics of every variant", () => {
    expect(EVENT_TOPICS.module_state_changed).toBe("system.module.state");
    expect(EVENT_TOPICS.platform_message_created).toBe("platform.message.created");
    expect(Object.keys(EVENT_TOPICS)).toHaveLength(15);
    expect(eventTopic(customEvent("llm.budget", { state: "ok" }))).toBe("llm.budget");
  });

  it("envelopes carry ids, source and correlation", () => {
    const env: Envelope = newEnvelope("agent", customEvent("x.y", null), {
      correlation: "01JC0000000000000000000000",
      now: 0,
    });
    expect(isUlid(env.id)).toBe(true);
    expect(env).toMatchObject({
      ts: "1970-01-01T00:00:00.000Z",
      source: "agent",
      causation: null,
      correlation: "01JC0000000000000000000000",
      event: { type: "custom", data: { topic: "x.y", payload: null } },
    });
  });
});

describe("ids and registries", () => {
  it("ULIDs sort in creation order", () => {
    const ids = Array.from({ length: 50 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it("service keys compare by identity", () => {
    const a = serviceKey<number>("X");
    expect(a.id).toBe("X");
    expect(a).not.toBe(serviceKey<number>("X"));
  });

  it("prompt contributors are listed by key", () => {
    const reg = new PromptContributors();
    const make = (key: string) => ({ key, contribute: async () => [] });
    reg.register(make("memory"));
    reg.register(make("game"));
    reg.register(make("mood"));
    reg.unregister("mood");
    expect(reg.all().map((c) => c.key)).toEqual(["game", "memory"]);
  });
});
