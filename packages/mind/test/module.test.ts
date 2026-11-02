import { MockProvider } from "@miyoria/llm";
import { MemorySettingsStore } from "@miyoria/store";
import {
  customEvent,
  type JsonValue,
  SelfStateKey,
  type Thought,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THOUGHT_PREFIX } from "../src/index.js";
import { HER, OWEN, rig, salient, stopRigs, TEXT, VOICE, wait } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T12:00:00.000Z")); // 20:00 at UTC+8
});

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

const TURN = "01JCTURN000000000000000000";

const FULL_REPLY = JSON.stringify({
  thought: "Owen 進語音了耶……主動跑去好像很在意他,就說我剛好路過。",
  feelings: [{ person: "u1", note: "有點在意他", affinity_hint: "+" }],
  drives: { social: -0.1 },
  policy: {
    talkativeness: [{ scope: "p2", level: 0.8, for_min: 30, why: "大家很熱鬧" }],
  },
  agenda: { add: [{ text: "問 Owen 報告的結果", person: "u1" }] },
  intents: [
    { action: "voice.join", place: "p1", person: "u1", why: "想找 Owen", opening: "假裝路過" },
    { action: "speak", place: "p1", why: "x" },
  ],
});

function systemText(provider: MockProvider, n = 0): string {
  const request = provider.requests()[n];
  return (request?.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

function dataText(provider: MockProvider, n = 0): string {
  const request = provider.requests()[n];
  return (request?.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
}

describe("mind module", () => {
  it("thinks about a salient change and acts on it, within bounds", async () => {
    const provider = new MockProvider("p").reply(FULL_REPLY);
    const r = await rig(provider);
    r.publish(salient("Owen 進了語音頻道「聊天室」"));
    await wait(2000);
    expect(provider.requests().length, "coalescing").toBe(0);
    await wait(2000);
    expect(provider.requests().length).toBe(1);
    const request = provider.requests()[0];
    expect(request?.json_mode).toBe(true);
    expect(request?.thinking).toBe(true);
    expect(request?.model).toBe("mind");
    // Names, the world summary and what happened are data; the system role has none of it.
    for (const derived of ["Owen", "Minecraft", "聊天室", "海豚"]) {
      expect(systemText(provider), derived).not.toContain(derived);
    }
    expect(dataText(provider)).toContain("⟦資料 來源=world");
    expect(dataText(provider)).toContain("Owen 進了語音頻道");
    expect(systemText(provider)).toContain("你是住在深海的鯨魚娘。");

    await wait(100);
    // The intent, resolved against the snapshot; `speak` is not hers to start.
    expect(r.intents.intents).toEqual([
      expect.objectContaining({
        capability: "voice.join",
        args: { channel: "v1", guild: "g1" },
        context: VOICE,
        about: OWEN,
        opening: "假裝路過",
      }),
    ]);
    const self = r.sup.services.require(SelfStateKey);
    expect(self.feeling("person-owen")?.text).toBe("有點在意他");
    expect(r.social.events).toEqual([["person-owen", [["mind", "warm", 0.3]]]]);
    expect(self.talkativeness(TEXT)).toMatchObject({ level: 0.8, scope: "discord:g1:c1" });
    expect(self.agenda().map((a) => [a.text, a.person])).toEqual([
      ["問 Owen 報告的結果", "person-owen"],
    ]);

    const [thought] = r.mind().thoughts();
    expect(thought?.thought).toContain("就說我剛好路過");
    expect(thought?.triggers.map((t) => t.kind)).toEqual(["salient"]);
    expect(thought?.changes).toContain("對 Owen 的感覺");
    expect(thought?.intents.map((i) => [i.capability, i.status, i.detail])).toEqual([
      ["voice.join", "started", "her turn is queued"],
      ["speak", "dropped", "not something she can do"],
    ]);

    // What became of it: the gate decision and what she said in her turn.
    r.publish(
      customEvent("gate.decision", {
        turn: TURN,
        capability: "voice.join",
        allowed: true,
        stage: "rate",
        reason: "within limits",
        at: toTimestamp(Date.now()),
      }),
    );
    r.publish({
      type: "agent_turn_completed",
      data: { turn: TURN, context: VOICE, text: "我只是剛好路過喔。" },
    });
    await wait(10);
    const [after] = r.mind().thoughts();
    expect(after?.intents[0]).toMatchObject({
      status: "done",
      said: "我只是剛好路過喔。",
      turn: TURN,
      decisions: [expect.objectContaining({ capability: "voice.join", allowed: true })],
    });
    const published = r.thoughts() as unknown as Thought[];
    expect(published.length).toBeGreaterThanOrEqual(3);
    expect(published.at(-1)?.intents[0]?.said).toBe("我只是剛好路過喔。");
    expect(r.mind().stats()).toMatchObject({ calls_last_hour: 1, calls_total: 1 });
  });

  it("adapts the heartbeat and keeps to the hourly cap", async () => {
    const provider = new MockProvider("p").reply('{"thought": "沒什麼事。"}');
    const r = await rig(provider, { config: { max_calls_per_hour: 3, min_interval_secs: 30 } });
    await wait(11 * 60_000);
    expect(provider.requests().length).toBe(0);
    await wait(60_000);
    expect(provider.requests().length, "first heartbeat after 12 min").toBe(1);
    expect(
      r
        .mind()
        .thoughts()[0]
        ?.triggers.map((t) => t.kind),
    ).toEqual(["heartbeat"]);
    // Nothing came of it: the next one is 1.5× sparser.
    await wait(17 * 60_000);
    expect(provider.requests().length).toBe(1);
    await wait(60_000);
    expect(provider.requests().length).toBe(2);
    // Lots happening, but at most three thoughts in the hour.
    for (let i = 0; i < 6; i++) {
      r.publish(salient(`事件 ${i}`));
      await wait(40_000);
    }
    expect(provider.requests().length).toBe(3);
    expect(r.mind().stats().calls_last_hour).toBe(3);
  });

  it("does not think while autonomy is paused", async () => {
    const provider = new MockProvider("p").reply('{"thought": "嗯"}');
    const r = await rig(provider);
    await r.registry.setPaused(true);
    expect(r.mind().accepting).toBe(false);
    expect(r.mind().stats().idle_reason).toBe("paused");
    expect(
      r.mind().suggest({
        source: "initiative",
        reason: "greeting",
        context: TEXT,
        hint: "打招呼",
        about: [],
      }),
    ).toBe(false);
    r.publish(salient("Owen 上線了"));
    await wait(30 * 60_000);
    expect(provider.requests().length).toBe(0);
    await r.registry.setPaused(false);
    r.publish(salient("Owen 上線了"));
    await wait(40_000);
    expect(provider.requests().length).toBe(1);
  });

  it("takes initiative's suggestions as reasons to think (followups go on her agenda)", async () => {
    const provider = new MockProvider("p").reply(
      JSON.stringify({
        thought: "對了,要問他考試的事。",
        intents: [{ action: "chat.start", place: "p1", person: "u1", opening: "考得怎樣?" }],
      }),
    );
    const r = await rig(provider);
    const accepted = r.mind().suggest({
      source: "initiative",
      reason: "followup",
      context: TEXT,
      hint: "問他考試考得怎樣",
      about: [OWEN],
    });
    expect(accepted).toBe(true);
    const self = r.sup.services.require(SelfStateKey);
    expect(self.agenda().map((a) => a.text)).toEqual(["問他考試考得怎樣"]);
    await wait(5000);
    expect(dataText(provider)).toContain("可能的契機");
    expect(dataText(provider)).toContain("問他考試考得怎樣(p1 u1)");
    await wait(10);
    expect(r.intents.intents.map((i) => [i.capability, i.context, i.about])).toEqual([
      ["chat.start", TEXT, OWEN],
    ]);
  });

  it("thinks when her voice channel goes quiet after a conversation", async () => {
    const provider = new MockProvider("p").reply('{"thought": "大家怎麼都不說話了。"}');
    const r = await rig(provider);
    const member = (id: string, self: boolean): VoiceParticipant => ({
      account: { platform: "discord", id },
      display_name: id,
      is_self: self,
      muted: false,
      deafened: false,
    });
    r.publish({ type: "platform_ready", data: { platform: "discord", self_account: HER } });
    r.publish({
      type: "voice_joined",
      data: { context: VOICE, participants: [member(OWEN.id, false), member(HER.id, true)] },
    });
    for (let i = 0; i < 3; i++) {
      r.publish({
        type: "voice_utterance",
        data: {
          id: `u${i}`,
          context: VOICE,
          speaker: { account: OWEN, display_name: "Owen", is_bot: false },
          text: "然後呢",
          language: "zh",
          emotion: null,
          audio_events: [],
          started_at: toTimestamp(Date.now()),
          ended_at: toTimestamp(Date.now()),
          asr_ms: 100,
        },
      });
      await wait(5000);
    }
    expect(provider.requests().length).toBe(0);
    await wait(45_000);
    expect(provider.requests().length).toBe(1);
    expect(
      r
        .mind()
        .thoughts()[0]
        ?.triggers.map((t) => [t.kind, t.context]),
    ).toEqual([["voice_quiet", VOICE]]);
  });

  it("falls back to the chat chain and records failures in the journal", async () => {
    const provider = new MockProvider("p").reply("我不想用 JSON");
    const r = await rig(provider, { chatOnly: true });
    r.publish(salient("Owen 上線了"));
    await wait(5000);
    expect(provider.requests()[0]?.model).toBe("chat");
    const [thought] = r.mind().thoughts();
    expect(thought?.error).toContain("no JSON object");
    expect(thought?.intents).toEqual([]);
  });

  it("keeps her journal across restarts, the newest `journal_keep`", async () => {
    const store = new MemorySettingsStore();
    const provider = new MockProvider("p").reply('{"thought": "一"}').reply('{"thought": "二"}');
    const r = await rig(provider, { store, config: { journal_keep: 1, min_interval_secs: 0 } });
    r.publish(salient("a"));
    await wait(5000);
    r.publish(salient("b"));
    await wait(5000);
    const keys = [...(await store.list("p", THOUGHT_PREFIX)).keys()];
    expect(keys.length).toBe(1);
    await r.sup.restart("mind");
    expect(
      r
        .mind()
        .thoughts()
        .map((t) => t.thought),
    ).toEqual(["二"]);
    const saved = (await store.list("p", THOUGHT_PREFIX)).values().next().value as JsonValue;
    expect((saved as unknown as Thought).thought).toBe("二");
  });
});
