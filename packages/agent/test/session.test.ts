import { newId } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Session } from "../src/index.js";
import { tacc, tctx, tmsg } from "./fixtures.js";

const msg = (account: string, text: string) => tmsg("channel", account, text, { upper: true });
const me = tacc("her");

afterEach(() => {
  vi.useRealTimers();
});

describe("Session", () => {
  it("bounded_history_and_echo_dedup", () => {
    const s = new Session(tctx(), 3);
    s.recordMessage(msg("a", "1"), false);
    const action = newId();
    s.recordOwn("Her", me, "hi there", action, Date.now());
    s.recordMessage(msg("her", " hi there "), true);
    expect(s.history().length).toBe(2);
    expect(s.history()[1]?.pending).toBeNull();
    s.recordMessage(msg("b", "2"), false);
    s.recordMessage(msg("c", "3"), false);
    expect(s.history().length).toBe(3);
    expect(s.history()[0]?.text).toBe("hi there");
    expect(s.participants().length).toBe(3);
  });

  it("forgets_undelivered_replies", () => {
    const s = new Session(tctx(), 10);
    const action = newId();
    s.recordOwn("Her", me, "x", action, Date.now());
    expect(s.lastSelfAt()).not.toBeNull();
    s.forgetAction(action);
    expect(s.history()).toEqual([]);
    expect(s.lastSelfAt()).toBeNull();
  });

  it("speech_of_a_turn_is_joined_and_can_be_interrupted", () => {
    const s = new Session(tctx(), 10);
    const [t1, t2] = [newId(), newId()];
    s.recordSpeech("Her", me, "哼。", t1, Date.now());
    s.recordSpeech("Her", me, "才不是。", t1, Date.now());
    expect(s.history().length).toBe(1);
    expect(s.history()[0]?.text).toBe("哼。才不是。");
    expect(s.history()[0]?.spoken && s.lastSelfAt() !== null).toBe(true);

    s.recordInterruption("Her", me, "才不是。", t1, Date.now());
    expect(s.history()[0]?.interrupted).toBe(true);
    // Nothing more is appended to an interrupted entry.
    s.recordSpeech("Her", me, "其實", t1, Date.now());
    expect(s.history().length).toBe(2);

    // An interruption whose start was missed is still recorded.
    s.recordInterruption("Her", me, "等等", t2, Date.now());
    const last = s.history().at(-1);
    expect(last?.text).toBe("等等");
    expect(last?.interrupted && last.turn === t2).toBe(true);
  });

  it("voice_members_and_speaking", () => {
    vi.useFakeTimers();
    const s = new Session(tctx(), 10);
    const owen = tacc("owen");
    expect(s.someoneSpeaking()).toBe(false);
    s.setSpeaking(owen, true);
    expect(s.someoneSpeaking()).toBe(true);
    s.setVoiceMembers([]);
    expect(s.someoneSpeaking(), "people who left stop speaking").toBe(false);
    s.setVoiceMembers([
      { account: owen, display_name: "Owen", is_self: false, muted: false, deafened: false },
    ]);
    s.setSpeaking(owen, true);
    s.setSpeaking(owen, false);
    expect(s.someoneSpeaking()).toBe(false);
    expect(s.voiceMembers()[0]?.display_name).toBe("Owen");

    // A speaking signal older than 30 s is treated as lost.
    s.setSpeaking(owen, true);
    vi.advanceTimersByTime(29_000);
    expect(s.someoneSpeaking()).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(s.someoneSpeaking()).toBe(false);
  });

  it("self_share_pads_short_histories", () => {
    const s = new Session(tctx(), 50);
    s.recordMessage(msg("her", "a"), true);
    s.recordMessage(msg("x", "b"), false);
    expect(s.selfShare(20)).toBeCloseTo(0.05, 6);
    for (let i = 0; i < 20; i++) s.recordMessage(msg("her", "spam"), true);
    expect(s.selfShare(20)).toBeCloseTo(1.0, 6);
  });

  it("notes attachments inline and orders participants by recency", () => {
    const s = new Session(tctx(), 10);
    const withFile = {
      ...tmsg("channel", "a", " 看這個 ", { ts: 1000 }),
      attachments: [{ url: "u", filename: "cat.png", content_type: null }],
    };
    s.recordMessage(withFile, false);
    s.recordMessage(tmsg("channel", "b", "嗯", { ts: 2000 }), false);
    expect(s.history()[0]?.text).toBe("看這個 [附件: cat.png]");
    expect(s.participants().map((p) => p.displayName)).toEqual(["b", "a"]);
  });
});
