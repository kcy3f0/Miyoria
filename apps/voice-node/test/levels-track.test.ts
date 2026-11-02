// A play's levels track (0x03 frames, `play_start.levels`): lip sync follows it instead of the
// audio, frame by frame, with the same fades.
import { describe, expect, it } from "vitest";
import { decodeBinaryFrame, FRAME_LEVELS, parseCoreMessage } from "../src/protocol.js";
import { FRAME_BYTES, PlaybackSource } from "../src/playback/source.js";

function pcm(samples: number, value: number): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(value, i * 2);
  return b;
}

function source(): PlaybackSource {
  return new PlaybackSource({ sampleRate: 48_000, maxBufferBytes: 10_000_000, prebufferMs: 20, maxStarveMs: 2000 });
}

describe("levels track", () => {
  it("parses play_start.levels and 0x03 frames", () => {
    const start = parseCoreMessage(JSON.stringify({ type: "play_start", play: 3, guild: "1", sample_rate: 48000, levels: true }));
    expect(start).toEqual({ ok: true, value: { type: "play_start", play: 3, guild: "1", sample_rate: 48000, levels: true } });
    const plain = parseCoreMessage(JSON.stringify({ type: "play_start", play: 3, guild: "1", sample_rate: 48000 }));
    expect(plain.ok && "levels" in plain.value).toBe(false);
    const f = decodeBinaryFrame(Buffer.from([0x03, 3, 0, 0, 0, 1, 0]));
    expect(f.ok && f.value.kind).toBe(FRAME_LEVELS);
    expect(f.ok && f.value.id).toBe(3);
  });

  it("frames carry the levels track next to the audio", () => {
    const s = source();
    s.enableLevels();
    s.writeLevels(pcm(960, 500));
    s.write(pcm(960, 9000));
    s.writeLevels(pcm(480, 700)); // short: the rest of the frame is silence
    s.write(pcm(960, 9000));
    s.end();
    const a = s.readFrame();
    expect(a.kind).toBe("audio");
    if (a.kind !== "audio") return;
    expect(a.pcm.readInt16LE(0)).toBe(9000);
    expect(a.levels?.length).toBe(FRAME_BYTES);
    expect(a.levels?.readInt16LE(400)).toBe(500);
    const b = s.readFrame();
    if (b.kind !== "audio") throw new Error("expected audio");
    expect(b.levels?.readInt16LE(4 * 100)).toBe(700);
    expect(b.levels?.readInt16LE(4 * 900)).toBe(0);
  });

  it("plays without a levels track keep the audio for lip sync", () => {
    const s = source();
    s.writeLevels(pcm(960, 500)); // ignored: not enabled
    s.write(pcm(960, 9000));
    s.end();
    const a = s.readFrame();
    expect(a.kind === "audio" && a.levels).toBeUndefined();
  });
});
