import { describe, expect, it } from "vitest";
import { MAX_THOUGHT, MindReplyError, parseMindReply } from "../src/index.js";

describe("her reply", () => {
  it("parses a full reply", () => {
    const reply = parseMindReply(
      `好,我想想。\n${JSON.stringify({
        thought: "Owen 在語音耶……就說我剛好路過。",
        feelings: [{ person: "u1", note: "有點在意他", affinity_hint: "+" }],
        drives: { social: -0.1, play: 0.05 },
        policy: {
          talkativeness: [{ scope: "p1", level: 0.8, for_min: 30, why: "大家很熱鬧" }],
          initiative: { level: 0.7, why: "想多做點事" },
        },
        agenda: {
          add: [{ text: "問 Owen 報告", person: "u1", due_in_min: 60 }],
          complete: ["g1"],
          drop: ["g2"],
        },
        intents: [
          {
            action: "voice.join",
            place: "p2",
            person: "u1",
            why: "想找 Owen",
            opening: "假裝路過",
            expires_in_s: 120,
          },
        ],
      })}`,
      2,
    );
    expect(reply.thought).toBe("Owen 在語音耶……就說我剛好路過。");
    expect(reply.feelings).toEqual([{ person: "u1", note: "有點在意他", hint: "+" }]);
    expect(reply.drives).toEqual({ social: -0.1, play: 0.05 });
    expect(reply.talkativeness).toEqual([
      { scope: "p1", level: 0.8, minutes: 30, why: "大家很熱鬧" },
    ]);
    expect(reply.initiative).toEqual({ level: 0.7, why: "想多做點事" });
    expect(reply.agendaAdd).toEqual([
      {
        text: "問 Owen 報告",
        why: "",
        person: "u1",
        place: null,
        dueInMin: 60,
        expiresInMin: 1440,
      },
    ]);
    expect(reply.agendaDone).toEqual(["g1"]);
    expect(reply.agendaDrop).toEqual(["g2"]);
    expect(reply.intents).toEqual([
      {
        action: "voice.join",
        place: "p2",
        person: "u1",
        args: {},
        why: "想找 Owen",
        opening: "假裝路過",
        expiresInS: 120,
      },
    ]);
  });

  it("bounds everything and drops broken parts without losing the rest", () => {
    const reply = parseMindReply(
      JSON.stringify({
        thought: "嗯".repeat(2000),
        feelings: [
          { person: "u1" },
          { note: "沒有人" },
          { person: "u2", note: "x".repeat(900), affinity_hint: "+++" },
          { person: "u3", affinity_hint: "-" },
          { person: "u4", affinity_hint: "+" },
          { person: "u5", affinity_hint: "+" },
        ],
        drives: { social: 5, rest: -3, boredom: "-0.1", nonsense: 1, play: "a lot" },
        policy: {
          talkativeness: [
            { scope: "voice", level: 7, for_min: 100_000 },
            { scope: "p1", level: "high" },
            { level: 0.5 },
            { scope: "text", level: -1, for_min: 1 },
          ],
          initiative: { level: "very" },
        },
        agenda: {
          add: [{ text: "" }, { text: "記得", expires_in_min: 99_999_999 }],
          complete: "g1",
        },
        intents: [
          { action: "chat.start", place: "p1", expires_in_s: 1 },
          { action: "", place: "p1" },
          { action: "voice.join", expires_in_s: 99_999, args: "x" },
          { action: "chat.dm", person: 3 },
        ],
      }),
      2,
    );
    expect([...reply.thought].length).toBe(MAX_THOUGHT + 1);
    expect(reply.feelings.map((f) => f.person)).toEqual(["u2", "u3", "u4"]);
    expect([...(reply.feelings[0]?.note ?? "")].length).toBe(301);
    expect(reply.feelings[0]?.hint).toBeNull();
    expect(reply.drives).toEqual({ social: 0.2, rest: -0.2, boredom: -0.1 });
    expect(reply.talkativeness).toEqual([
      { scope: "voice", level: 1, minutes: 1440, why: "" },
      { scope: "text", level: 0, minutes: 5, why: "" },
    ]);
    expect(reply.initiative).toBeNull();
    expect(reply.agendaAdd.map((a) => [a.text, a.expiresInMin])).toEqual([["記得", 7 * 24 * 60]]);
    expect(reply.agendaDone).toEqual([]);
    expect(reply.intents.map((i) => [i.action, i.expiresInS, i.args])).toEqual([
      ["chat.start", 15, {}],
      ["voice.join", 900, {}],
    ]);
  });

  it("tolerates missing parts and rejects what is not JSON", () => {
    expect(parseMindReply('{"thought": "沒事"}', 2)).toMatchObject({
      thought: "沒事",
      feelings: [],
      intents: [],
      initiative: null,
    });
    expect(parseMindReply('{"intents": [{"action": "chat.start"}]}', 0).intents).toEqual([]);
    expect(() => parseMindReply("我不想回答", 2)).toThrow(MindReplyError);
    expect(() => parseMindReply("{not json}", 2)).toThrow(MindReplyError);
    expect(() => parseMindReply("[1, 2] {", 2)).toThrow(MindReplyError);
  });
});
