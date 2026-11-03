// Voice-first lines: she speaks the (Japanese) voice line first, the written (Chinese) sentence
// arrives as `agent.subtitle` and replaces it in the subtitle.

import { type ContextKey, customEvent, type Event } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { type CoreMessage, Forwarder, SUBTITLE_TOPIC } from "../src/index.js";

const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
const TURN = "01JTURN0000000000000000000";

const playback = (state: "started" | "finished", text: string): Event =>
  ({
    type: "voice_playback",
    data: { context: VOICE, turn: TURN, state, text, emotion: null },
  }) as Event;
const written = (spoken: string, text: string, turn = TURN): Event =>
  customEvent(SUBTITLE_TOPIC, { turn, context: { ...VOICE }, spoken, text });
const subtitles = (out: CoreMessage[]) => out.filter((m) => m.type === "subtitle");

describe("voice-first subtitles", () => {
  it("swaps the spoken line for its written sentence, then keeps it", () => {
    const f = new Forwarder(false);
    expect(subtitles(f.onEvent(playback("started", "こんにちは")))).toEqual([
      { type: "subtitle", turn: TURN, text: "こんにちは", final: false },
    ]);
    expect(f.onEvent(written("こんにちは", "你好"))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好", final: false },
    ]);
    f.onEvent(playback("finished", "こんにちは"));
    expect(subtitles(f.onEvent(playback("started", "元気?")))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好元気?", final: false },
    ]);
    f.onEvent(written("元気?", "還好嗎?"));
    f.onEvent(playback("finished", "元気?"));
    const done = f.onEvent({
      type: "agent_turn_completed",
      data: { turn: TURN, context: VOICE, text: "你好還好嗎?" },
    } as Event);
    expect(subtitles(done)).toEqual([
      { type: "subtitle", turn: TURN, text: "你好還好嗎?", final: true },
    ]);
  });

  it("a written sentence that comes before the line plays is used when it plays", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(written("おはよう", "早安"))).toEqual([]);
    expect(subtitles(f.onEvent(playback("started", "おはよう")))).toEqual([
      { type: "subtitle", turn: TURN, text: "早安", final: false },
    ]);
  });

  it("after the final subtitle the correction is final too; junk is ignored", () => {
    const f = new Forwarder(false);
    f.onEvent(playback("started", "ありがとう"));
    f.onEvent({
      type: "agent_turn_completed",
      data: { turn: TURN, context: VOICE, text: "" },
    } as Event);
    expect(subtitles(f.onEvent(playback("finished", "ありがとう")))).toEqual([
      { type: "subtitle", turn: TURN, text: "ありがとう", final: true },
    ]);
    expect(f.onEvent(written("ありがとう", "謝謝"))).toEqual([
      { type: "subtitle", turn: TURN, text: "謝謝", final: true },
    ]);
    expect(f.onEvent(customEvent(SUBTITLE_TOPIC, { turn: TURN, spoken: "", text: "x" }))).toEqual(
      [],
    );
    expect(f.onEvent(customEvent(SUBTITLE_TOPIC, "junk"))).toEqual([]);
  });
});
