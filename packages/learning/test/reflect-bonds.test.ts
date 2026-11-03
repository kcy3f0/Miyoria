// Reflect in v2 (docs/design/v2-architecture.md §3.4, §3.6): a short system of its own, reasoning
// `reflect`, person-card tidy-up through `adjustBond(..., "reflect")` within caps, long-term
// goals into her `GoalAgenda`, and the interaction threshold.

import { ServiceRegistry } from "@miyoria/kernel";
import { LlmRouter, LlmRouterKey, MockProvider, parseModelRef } from "@miyoria/llm";
import { MemorySettingsStore, PeopleStoreKey } from "@miyoria/store";
import {
  type AffectSource,
  type AffectState,
  AffectStateKey,
  type BondChange,
  ephemeralHandlesIn,
  type Goal,
  type GoalAgenda,
  GoalAgendaKey,
  type GoalInput,
  type PersonCard,
  type PersonId,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_FORMAT,
  FeedbackTracker,
  LessonStore,
  Reflector,
  reflectConfig,
} from "../src/index.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T12:00:00.000Z")); // 20:00 at UTC+8
});

afterEach(() => {
  vi.useRealTimers();
});

const PERSONA = [
  "# 你是 DeepSeek-chan",
  "",
  "深海來的鯨魚娘。愛吐槽,其實很照顧人。",
  "",
  "- **個性**:好勝、愛面子。",
  "",
  "# 說話風格",
  "",
  "- 只輸出 <silence/> 表示不說話;<emo:smug> 標情緒。",
].join("\n");

function card(handle: string, person: PersonId, attachment: number): PersonCard {
  return {
    person,
    handle,
    call_name: null,
    affinity: 30,
    trust: 40,
    familiarity: 40,
    attachment,
    emotions: {},
    feeling: "有點在意",
    label: "朋友",
    owner: false,
    blocked: false,
    last_seen: null,
    last_together: null,
    updated_at: "",
  };
}

class FakeAffect {
  readonly bonds: { person: PersonId; change: BondChange; by: AffectSource }[] = [];
  readonly list = [card("Owen", "p-owen", 0.4), card("Amy", "p-amy", 0.1)];
  card(person: PersonId) {
    return this.list.find((c) => c.person === person) ?? null;
  }
  cardByHandle(handle: string) {
    return this.list.find((c) => c.handle === handle) ?? null;
  }
  cards() {
    return [...this.list];
  }
  async adjustBond(person: PersonId, change: BondChange, by: AffectSource) {
    this.bonds.push({ person, change, by });
    return this.card(person);
  }
}

class FakeGoals {
  readonly added: GoalInput[] = [];
  goals(): Goal[] {
    return this.added.map((g, i) => ({ id: String(i), what: g.what }) as Goal);
  }
  add(input: GoalInput): Goal {
    this.added.push(input);
    return { id: "g", what: input.what } as Goal;
  }
}

function setup(...replies: string[]) {
  const provider = new MockProvider("p");
  for (const r of replies) provider.reply(r);
  const services = new ServiceRegistry();
  services.provide(
    "t",
    LlmRouterKey,
    new LlmRouter(new Map([["p", provider]]), new Map([["summarizer", [parseModelRef("p:s")]]])),
  );
  const affect = new FakeAffect();
  services.provide("t", AffectStateKey, affect as unknown as AffectState);
  const goals = new FakeGoals();
  services.provide("t", GoalAgendaKey, goals as unknown as GoalAgenda);
  services.provide("t", PeopleStoreKey, {
    all: async () => [
      { id: "p-owen", display_name: "Owen", created_at: "", accounts: [] },
      { id: "p-amy", display_name: "Amy", created_at: "", accounts: [] },
    ],
  } as never);
  const store = new MemorySettingsStore();
  const config = reflectConfig({ min_interval_mins: 0, light_after_total_lines: 5 });
  const clock = { now: () => Date.now() };
  const feedback = new FeedbackTracker(
    store,
    "p",
    { utcOffsetMinutes: 480, keepDays: 14, replyWindowMs: 600_000 },
    clock,
  );
  const reflector = new Reflector({
    config,
    profile: "p",
    name: "DeepSeek-chan",
    persona: () => PERSONA,
    services,
    store,
    clock,
    feedback,
    lessons: new LessonStore(store, "p", config.max_lessons, clock),
  });
  return { provider, affect, goals, reflector, store };
}

describe("Reflect (v2)", () => {
  it("has a short system of its own and reasons at `reflect`", async () => {
    const { provider, reflector } = setup('{"summary": "嗯"}');
    await reflector.reflect("daily", null);
    const request = provider.requests()[0];
    expect(request?.reasoning_purpose).toBe("reflect");
    expect(request?.reasoning).toBe("high");
    const system = String(request?.messages[0]?.content);
    expect(system.startsWith("你是 DeepSeek-chan\n深海來的鯨魚娘。")).toBe(true);
    expect(system).toContain("好勝、愛面子。");
    expect(system).not.toMatch(/silence|<emo/);
    expect(system).toContain('"bonds": []');
    // Her rules name no per-call codes (the shared document format warns against them).
    expect(ephemeralHandlesIn(system.replace(DRAFT_FORMAT, ""))).toEqual([]);
    // Her person cards (the ones she cares about) are in the data.
    expect(String(request?.messages[1]?.content)).toContain(
      "Owen:朋友,在意 0.40;你對他的感覺:有點在意",
    );
  });

  it("tidies person cards with adjustBond, in small steps, each person once a day", async () => {
    const reply = JSON.stringify({
      summary: "今天跟 Owen 聊很多。",
      bonds: [
        {
          person: "Owen",
          attachment: 0.2,
          affinity: 9,
          trust: -5,
          feeling: "他很溫柔。u2 說的不對。",
          why: "聊得很開心",
        },
        { person: "Amy", attachment: 0, affinity: 0, trust: 0, feeling: null, why: "" },
        { person: "Nobody", attachment: 0.01, why: "?" },
      ],
      feelings: [{ person: "Amy", note: "她今天有點冷淡" }],
    });
    const { affect, reflector, store } = setup(reply, reply);
    const run = await reflector.reflect("daily", null);
    expect(run?.error).toBeNull();
    expect(affect.bonds).toEqual([
      {
        person: "p-owen",
        change: {
          attachment: 0.03,
          affinity: 2,
          trust: -2,
          feeling: "他很溫柔。",
          why: "聊得很開心",
        },
        by: "reflect",
      },
      { person: "p-amy", change: { feeling: "她今天有點冷淡", why: "反思" }, by: "reflect" },
    ]);
    expect(run?.feelings).toEqual(["Owen", "Amy"]);
    // A second reflection the same day does not move them again (kept across restarts).
    await reflector.flush();
    expect(await store.get("p", "reflect:state")).toMatchObject({
      bonds_day: "2026-11-02",
      bonds_people: ["p-owen", "p-amy"],
    });
    vi.advanceTimersByTime(60 * 60_000);
    await reflector.reflect("light", null);
    expect(affect.bonds).toHaveLength(2);
    // The next day they may move again.
    vi.advanceTimersByTime(24 * 60 * 60_000);
    await reflector.reflect("light", null);
    expect(affect.bonds).toHaveLength(4);
  });

  it("writes long-term goals into her GoalAgenda as `whenever` goals", async () => {
    const { goals, reflector } = setup(
      JSON.stringify({
        summary: "嗯",
        goals: [
          { text: "學會一首新歌", why: "想唱給大家聽", days: 5 },
          { text: "跟 u1 約好一起玩", why: "" },
        ],
      }),
    );
    const run = await reflector.reflect("daily", null);
    expect(goals.added).toEqual([
      {
        what: "學會一首新歌",
        why: "想唱給大家聽",
        trigger: { kind: "whenever" },
        expires: "2026-11-07T12:00:00.000Z",
        source: "reflect",
      },
    ]);
    expect(run?.goals).toEqual(["學會一首新歌"]);
  });

  it("reflects lightly once enough was said anywhere (the interaction threshold)", () => {
    vi.setSystemTime(Date.parse("2026-11-02T19:00:00.000Z")); // 03:00, before the daily hour
    const { reflector } = setup("{}");
    const now = Date.now();
    for (let i = 0; i < 4; i++) reflector.activity(now - 20 * 60_000);
    expect(reflector.due(now, "ok")).toBeNull();
    reflector.activity(now - 15 * 60_000);
    expect(reflector.due(now, "ok")).toEqual({ kind: "light", context: null });
    expect(reflector.due(now, "degraded")).toBeNull();
    // Not while people are still talking.
    reflector.activity(now - 60_000);
    expect(reflector.due(now, "ok")).toBeNull();
  });
});
