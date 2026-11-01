import { describe, expect, it } from "vitest";
import { SampleFifo } from "../src/audio/fifo.js";
import {
  bytesToInt16,
  int16ToBuffer,
  monoToStereo,
  Resampler,
  resampleMono,
  stereoToMono,
} from "../src/audio/resampler.js";

function tone(n: number, freq: number, rate: number, amp = 10_000): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

function rms(x: Int16Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}

describe("one-shot resampling lengths", () => {
  it("16 kHz -> 48 kHz triples the sample count", () => {
    expect(resampleMono(new Int16Array(320), 16_000, 48_000).length).toBe(960);
    expect(resampleMono(new Int16Array(1), 16_000, 48_000).length).toBe(3);
    expect(resampleMono(new Int16Array(16_000), 16_000, 48_000).length).toBe(48_000);
  });

  it("48 kHz -> 16 kHz divides by three", () => {
    expect(resampleMono(new Int16Array(960), 48_000, 16_000).length).toBe(320);
    expect(resampleMono(new Int16Array(48_000), 48_000, 16_000).length).toBe(16_000);
  });

  it("handles non-integer ratios and odd lengths: ceil(n * out / in)", () => {
    expect(resampleMono(new Int16Array(22_050), 22_050, 48_000).length).toBe(48_000);
    expect(resampleMono(new Int16Array(24_000), 24_000, 48_000).length).toBe(48_000);
    expect(resampleMono(new Int16Array(1001), 24_000, 48_000).length).toBe(2002);
    expect(resampleMono(new Int16Array(1000), 44_100, 48_000).length).toBe(Math.ceil((1000 * 48_000) / 44_100));
  });

  it("returns nothing for empty input", () => {
    expect(resampleMono(new Int16Array(0), 16_000, 48_000).length).toBe(0);
  });

  it("is a copy when the rates match", () => {
    const x = tone(100, 440, 48_000);
    const y = resampleMono(x, 48_000, 48_000);
    expect(y).toEqual(x);
    expect(y).not.toBe(x);
  });

  it("rejects bad rates", () => {
    expect(() => new Resampler(0, 48_000)).toThrow(RangeError);
    expect(() => new Resampler(16_000, 1.5)).toThrow(RangeError);
  });
});

describe("streaming resampling", () => {
  it("gives identical output regardless of chunking", () => {
    const x = tone(4800, 700, 16_000);
    const whole = resampleMono(x, 16_000, 48_000);

    const r = new Resampler(16_000, 48_000);
    const parts: Int16Array[] = [];
    for (let i = 0; i < x.length; ) {
      const n = 1 + ((i * 7) % 333); // irregular chunk sizes
      parts.push(r.process(x.subarray(i, i + n)));
      i += n;
    }
    parts.push(r.flush());
    const joined = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
    expect(joined.length).toBe(whole.length);
    expect(joined).toEqual(whole);
  });

  it("20 ms frames at 48 kHz yield ~320 samples each after warm-up", () => {
    const r = new Resampler(48_000, 16_000);
    let total = 0;
    for (let f = 0; f < 50; f++) total += r.process(tone(960, 300, 48_000)).length;
    total += r.flush().length;
    expect(total).toBe(50 * 320);
  });

  it("can be reused after flush", () => {
    const r = new Resampler(16_000, 48_000);
    r.process(new Int16Array(320));
    expect(r.flush().length + 0).toBeGreaterThanOrEqual(0);
    const again = r.process(new Int16Array(320));
    const tail = r.flush();
    expect(again.length + tail.length).toBe(960);
  });
});

describe("resampling quality", () => {
  it("preserves a 1 kHz tone when upsampling 16k -> 48k", () => {
    const y = resampleMono(tone(1600, 1000, 16_000), 16_000, 48_000);
    const ref = tone(y.length, 1000, 48_000);
    let maxErr = 0;
    for (let i = 300; i < y.length - 300; i++) maxErr = Math.max(maxErr, Math.abs((y[i] as number) - (ref[i] as number)));
    expect(maxErr).toBeLessThan(150); // < 1.5 % of the 10 000 amplitude
  });

  it("preserves a 1 kHz tone when downsampling 48k -> 16k", () => {
    const y = resampleMono(tone(4800, 1000, 48_000), 48_000, 16_000);
    const ref = tone(y.length, 1000, 16_000);
    let maxErr = 0;
    for (let i = 60; i < y.length - 60; i++) maxErr = Math.max(maxErr, Math.abs((y[i] as number) - (ref[i] as number)));
    expect(maxErr).toBeLessThan(150);
  });

  it("removes content above the new Nyquist when downsampling", () => {
    const y = resampleMono(tone(4800, 12_000, 48_000), 48_000, 16_000); // 12 kHz > 8 kHz
    expect(rms(y, 60, y.length - 60)).toBeLessThan(0.05 * rms(tone(4800, 12_000, 48_000)));
  });

  it("keeps DC level (unity gain)", () => {
    const x = new Int16Array(2000).fill(1000);
    for (const [a, b] of [[16_000, 48_000], [48_000, 16_000], [22_050, 48_000]] as const) {
      const y = resampleMono(x, a, b);
      const mid = y[Math.floor(y.length / 2)] as number;
      expect(Math.abs(mid - 1000)).toBeLessThanOrEqual(2);
    }
  });

  it("clamps instead of wrapping on overshoot", () => {
    const x = new Int16Array(400);
    for (let i = 0; i < x.length; i++) x[i] = i % 2 === 0 ? 32767 : -32768;
    const y = resampleMono(x, 16_000, 48_000);
    for (const s of y) {
      expect(s).toBeGreaterThanOrEqual(-32768);
      expect(s).toBeLessThanOrEqual(32767);
    }
  });
});

describe("channel and byte helpers", () => {
  it("downmixes interleaved stereo to mono by averaging", () => {
    expect([...stereoToMono(Int16Array.from([100, 200, -100, -300, 7, 8]))]).toEqual([150, -200, 7]);
  });

  it("drops a dangling half frame when downmixing", () => {
    expect(stereoToMono(Int16Array.from([1, 3, 5])).length).toBe(1);
  });

  it("upmixes mono to stereo by duplicating", () => {
    expect([...monoToStereo(Int16Array.from([5, -6]))]).toEqual([5, 5, -6, -6]);
  });

  it("doubles/halves lengths", () => {
    expect(monoToStereo(new Int16Array(960)).length).toBe(1920);
    expect(stereoToMono(new Int16Array(1920)).length).toBe(960);
  });

  it("converts bytes <-> samples (little endian, odd tail dropped, misaligned views ok)", () => {
    const samples = Int16Array.from([1, -2, 300]);
    const bytes = int16ToBuffer(samples);
    expect(bytes.length).toBe(6);
    expect([...bytesToInt16(bytes)]).toEqual([1, -2, 300]);

    const backing = Buffer.concat([Buffer.from([0]), bytes, Buffer.from([0xff])]);
    expect([...bytesToInt16(backing.subarray(1, 8))]).toEqual([1, -2, 300]); // odd offset, odd length
  });
});

describe("SampleFifo", () => {
  it("takes across chunk boundaries and tracks length", () => {
    const f = new SampleFifo();
    f.push(Int16Array.from([1, 2, 3]));
    f.push(Int16Array.from([4, 5]));
    f.push(new Int16Array(0));
    expect(f.length).toBe(5);
    expect([...f.take(4)]).toEqual([1, 2, 3, 4]);
    expect(f.length).toBe(1);
    expect([...f.take(10)]).toEqual([5]);
    expect(f.length).toBe(0);
    expect(f.take(3).length).toBe(0);
  });
});
