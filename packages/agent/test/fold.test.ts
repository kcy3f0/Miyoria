// Phase G in turns: history her conversation notes already cover is not repeated raw, and
// lessons shift her ambient talkativeness.

import { contentText, MockProvider } from "@miyoria/llm";
import {
  type ContextKey,
  type ConversationState,
  ConversationStatesKey,
  type Lessons,
  LessonsKey,
  SocialSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterFold } from "../src/index.js";
import { channel, Harness, incoming, mention, noCheck, stopHarnesses, wait } from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

describe("afterFold", () => {
  const h = [1, 2, 3, 4, 5, 6].map((ts) => ({ ts }));
  it("keeps what is after the fold, but at least `keep` of the newest", () => {
    expect(afterFold(h, null, 2)).toEqual(h);
    expect(afterFold(h, { id: "x", ts: toTimestamp(2) }, 2).map((e) => e.ts)).toEqual([3, 4, 5, 6]);
    expect(afterFold(h, { id: "x", ts: toTimestamp(5) }, 3).map((e) => e.ts)).toEqual([4, 5, 6]);
    expect(afterFold(h, { id: "x", ts: toTimestamp(9) }, 0)).toEqual([]);
  });
});

class States {
  state: ConversationState | null = null;
  get(context: ContextKey) {
    return this.state && this.state.context.channel === context.channel ? this.state : null;
  }
  list() {
    return this.state ? [this.state] : [];
  }
}

describe("turns with conversation notes", () => {
  it("send only the lines after the fold (plus a few) and never wait for a fold", async () => {
    const ctx = channel("c1");
    const states = new States();
    const chat = new MockProvider("chat").reply("好喔");
    const h = await Harness.build(
      "always",
      { ...(noCheck() as object), history_after_fold: 3 },
      chat,
      null,
      {
        provide: (s) => s.provide("app", ConversationStatesKey, states),
      },
    );
    const old = Array.from({ length: 12 }, (_, i) => incoming(ctx, "owen", `舊訊息 ${i}`));
    for (const m of old) h.say(m);
    states.state = {
      context: ctx,
      updated_at: toTimestamp(Date.now()),
      folded_up_to: { id: "log-11", ts: old[10]?.ts ?? "" },
      folds: 1,
      lines: 11,
      recap: "Owen 一直在講舊的事",
      notes: {},
    };
    await wait(10_000);
    const before = chat.requests().length;
    h.say(mention(ctx, "owen", "新的問題?"));
    await wait(10_000);
    const req = chat.requests().slice(before).at(-1);
    const text = (req?.messages ?? []).map((m) => contentText(m.content)).join("\n");
    expect(text).toContain("新的問題?");
    expect(text).toContain("舊訊息 11");
    expect(text).not.toContain("舊訊息 3");
  });

  it("lessons about the speaker make her quieter where they apply", async () => {
    const ctx = channel("c2");
    const lessons: Lessons = {
      all: () => [],
      applicable: () => [],
      talkShift: (_c, people) => (people.length > 0 ? -0.4 : 0),
    };
    const chat = new MockProvider("chat").reply("<silence/>");
    const h = await Harness.build("ambient", noCheck(), chat, null, {
      provide: (s) => {
        s.provide("app", LessonsKey, lessons);
        s.provide("app", SocialSignalsKey, {
          attitude: () => ({
            person: "p-owen",
            affinity: 0,
            trust: 0,
            familiarity: 0,
            blocked: false,
            label: "",
            call_name: null,
          }),
        });
      },
    });
    h.say(incoming(ctx, "owen", "今天好累喔大家"));
    await wait(10_000);
    const trace = h.traces().at(-1);
    expect(trace?.reasons.some((r) => r.includes("default+lessons"))).toBe(true);
  });
});
