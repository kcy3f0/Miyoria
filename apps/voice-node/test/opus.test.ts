// OpusCodec against opusscript's WASM build: real encode/decode, no network.
import { describe, expect, it } from "vitest";
import { OpusCodec } from "../src/audio/opus.js";

const FRAME = 960; // 20 ms @ 48 kHz

/** One stereo 20 ms frame of a 440 Hz tone, s16le. */
function tone(frame: number, amplitude = 12_000): Buffer {
  const b = Buffer.alloc(FRAME * 4);
  for (let i = 0; i < FRAME; i++) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * (frame * FRAME + i)) / 48_000));
    b.writeInt16LE(v, i * 4);
    b.writeInt16LE(v, i * 4 + 2);
  }
  return b;
}

function energy(pcm: Buffer): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return sum;
}

describe("OpusCodec", () => {
  it("round_trips_a_tone_at_the_same_level", () => {
    const enc = new OpusCodec(48_000, 2);
    const dec = new OpusCodec(48_000, 2);
    enc.setBitrate(96_000);
    let input = 0;
    let output = 0;
    for (let f = 0; f < 30; f++) {
      const pcm = tone(f);
      const out = dec.decode(enc.encode(pcm, FRAME));
      expect(out.length).toBe(FRAME * 4);
      // Skip the codec's warm-up frames.
      if (f >= 5) {
        input += energy(pcm);
        output += energy(out);
      }
    }
    expect(output / input).toBeGreaterThan(0.8);
    expect(output / input).toBeLessThan(1.25);
    enc.delete();
    dec.delete();
  });

  it("survives_many_short_lived_decoders", () => {
    // One decoder per speaking burst; opusscript's own wrapper corrupted the WASM heap here
    // and a later constructor failed with "memory access out of bounds".
    const enc = new OpusCodec(48_000, 2);
    const packet = enc.encode(tone(0), FRAME);
    for (let i = 0; i < 1000; i++) {
      const dec = new OpusCodec(48_000, 2);
      dec.decode(packet);
      dec.delete();
    }
    expect(enc.encode(tone(1), FRAME).length).toBeGreaterThan(0);
    enc.delete();
  });

  it("rejects_short_pcm_and_use_after_delete", () => {
    const enc = new OpusCodec(48_000, 2);
    expect(() => enc.encode(Buffer.alloc(100), FRAME)).toThrow(RangeError);
    enc.delete();
    expect(() => enc.encode(tone(0), FRAME)).toThrow("deleted");
  });
});
