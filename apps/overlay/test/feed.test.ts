import { describe, expect, it } from "vitest";
import {
  type Action,
  initialState,
  MAX_QUEUE_ITEMS,
  type OverlayState,
  parseMessage,
  parseQueueItem,
  reduce,
} from "../src/feed.js";

const run = (actions: Action[], from: OverlayState = initialState()): OverlayState => actions.reduce(reduce, from);
const sub = (turn: string, text: string, final = false): Action => ({ type: "subtitle", turn, text, final });

describe("parseMessage", () => {
  it("parses the Stage's subtitle frame", () => {
    expect(parseMessage('{"type":"subtitle","turn":"t1","text":"你好","final":false}')).toEqual({
      type: "subtitle", turn: "t1", text: "你好", final: false,
    });
    expect(parseMessage('{"type":"subtitle","turn":"t1","text":"你好。","final":true}')).toMatchObject({ final: true });
  });

  it("tolerates a missing / numeric turn and a missing final", () => {
    expect(parseMessage('{"type":"subtitle","text":"a"}')).toEqual({ type: "subtitle", turn: "", text: "a", final: false });
    expect(parseMessage('{"type":"subtitle","turn":7,"text":"a"}')).toMatchObject({ turn: "7" });
  });

  it("parses emotion: lowercases the name, defaults and clamps intensity", () => {
    expect(parseMessage('{"type":"emotion","name":"Happy","intensity":0.5}')).toEqual({ type: "emotion", name: "happy", intensity: 0.5 });
    expect(parseMessage('{"type":"emotion","name":"sad"}')).toMatchObject({ intensity: 1 });
    expect(parseMessage('{"type":"emotion","name":"sad","intensity":7}')).toMatchObject({ intensity: 1 });
    expect(parseMessage('{"type":"emotion","name":"sad","intensity":-1}')).toMatchObject({ intensity: 0 });
    expect(parseMessage('{"type":"emotion","name":"  "}')).toBeNull();
  });

  it("parses speaking and status", () => {
    expect(parseMessage('{"type":"speaking","state":"started"}')).toEqual({ type: "speaking", state: "started" });
    expect(parseMessage('{"type":"speaking","state":"maybe"}')).toBeNull();
    expect(parseMessage('{"type":"status","core":true,"vts":false,"obs":true,"scene":"Game","streaming":true}')).toEqual({
      type: "status",
      status: { core: true, vts: false, obs: true, scene: "Game", streaming: true },
    });
    expect(parseMessage('{"type":"status","scene":null}')).toEqual({
      type: "status",
      status: { core: false, vts: false, obs: false, scene: null, streaming: false },
    });
  });

  it("parses queue items given as strings or objects, skipping junk, capped", () => {
    const m = parseMessage(
      JSON.stringify({
        type: "queue",
        items: ["夜に駆ける", { title: "Minecraft", user: "阿翔" }, { text: "x", by: "" }, 5, null, {}, "  "],
      }),
    );
    expect(m).toEqual({
      type: "queue",
      items: [
        { title: "夜に駆ける", by: null },
        { title: "Minecraft", by: "阿翔" },
        { title: "x", by: null },
      ],
    });
    const many = parseMessage(JSON.stringify({ type: "queue", items: Array.from({ length: 40 }, (_, i) => `s${i}`) }));
    expect(many && many.type === "queue" && many.items.length).toBe(MAX_QUEUE_ITEMS);
    expect(parseMessage('{"type":"queue","items":"nope"}')).toBeNull();
  });

  it("returns null (never throws) for garbage", () => {
    for (const bad of ["", "not json", "[]", "null", "42", '{"type":"nope"}', '{"text":"x"}', '{"type":"subtitle","text":5}']) {
      expect(parseMessage(bad), bad).toBeNull();
    }
  });

  it("parseQueueItem prefers title over text and truncates long titles", () => {
    expect(parseQueueItem({ text: "b", title: "a" })).toEqual({ title: "a", by: null });
    expect(parseQueueItem({ title: "x".repeat(500) })?.title.length).toBe(160);
  });
});

describe("reduce", () => {
  it("starts empty and offline", () => {
    expect(initialState()).toEqual({
      connected: false, speaking: false, subtitleSeq: 0, subtitle: null, emotion: null, status: null, queue: [], notice: null,
    });
  });

  it("grows a subtitle across partials of one turn and bumps the sequence each time", () => {
    const s = run([sub("t1", "你"), sub("t1", "你好"), sub("t1", "你好嗎")]);
    expect(s.subtitle).toEqual({ turn: "t1", text: "你好嗎", final: false });
    expect(s.subtitleSeq).toBe(3);
  });

  it("marks the subtitle final; a late partial of the same turn does not reopen it", () => {
    const done = run([sub("t1", "你好"), sub("t1", "你好嗎。", true)]);
    expect(done.subtitle?.final).toBe(true);
    expect(reduce(done, sub("t1", "你好嗎"))).toBe(done);
  });

  it("ignores an identical repeat (the Stage resends the latest subtitle to a new client)", () => {
    const s = run([sub("t1", "你好", true)]);
    expect(reduce(s, sub("t1", "你好", true))).toBe(s);
  });

  it("a new turn replaces the old one, even after a final", () => {
    const s = run([sub("t1", "你好", true), sub("t2", "再見")]);
    expect(s.subtitle).toEqual({ turn: "t2", text: "再見", final: false });
  });

  it("accepts a revision of the same turn (a corrected transcript)", () => {
    const s = run([sub("t1", "你好嗎"), sub("t1", "妳好嗎")]);
    expect(s.subtitle?.text).toBe("妳好嗎");
    expect(s.subtitleSeq).toBe(2);
  });

  it("an empty final clears the subtitle; an empty partial does not", () => {
    expect(run([sub("t1", "你好"), sub("t1", "", true)]).subtitle).toBeNull();
    expect(run([sub("t1", "你好"), sub("t2", "")]).subtitle).toEqual({ turn: "t2", text: "", final: false });
  });

  it("keeps emotion, status and queue as the latest message", () => {
    const s = run([
      { type: "emotion", name: "happy", intensity: 1 },
      { type: "emotion", name: "sad", intensity: 0.4 },
      { type: "status", status: { core: true, vts: true, obs: false, scene: "Chat", streaming: false } },
      { type: "queue", items: [{ title: "a", by: null }] },
      { type: "queue", items: [] },
    ]);
    expect(s.emotion).toEqual({ name: "sad", intensity: 0.4 });
    expect(s.status?.scene).toBe("Chat");
    expect(s.queue).toEqual([]);
  });

  it("tracks speaking, and a dropped connection stops it", () => {
    const talking = run([{ type: "connection", connected: true }, { type: "speaking", state: "started" }]);
    expect(talking).toMatchObject({ connected: true, speaking: true });
    expect(reduce(talking, { type: "speaking", state: "stopped" }).speaking).toBe(false);
    expect(reduce(talking, { type: "connection", connected: false })).toMatchObject({ connected: false, speaking: false });
  });

  it("does not mutate the previous state", () => {
    const a = initialState();
    const frozen = Object.freeze({ ...a });
    expect(() => reduce(frozen, sub("t", "x"))).not.toThrow();
    expect(a.subtitle).toBeNull();
  });

  it("shows a notice until an empty one clears it", () => {
    const on = parseMessage('{"type":"notice","text":" 準備歌曲中… "}');
    expect(on).toEqual({ type: "notice", text: "準備歌曲中…" });
    expect(parseMessage('{"type":"notice"}')).toBeNull();
    const shown = run([on as Action]);
    expect(shown.notice).toBe("準備歌曲中…");
    expect(reduce(shown, on as Action)).toBe(shown);
    expect(run([{ type: "notice", text: "" }], shown).notice).toBeNull();
  });
});
