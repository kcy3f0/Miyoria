import { describe, expect, it } from "vitest";
import { initialState, parseMessage, reduce } from "../src/feed.js";
import { levelValue, STEP_MS, WaveHistory } from "../src/wave.js";

describe("levels feed", () => {
  it("parses levels, clamps rms and drops odd bands", () => {
    expect(parseMessage('{"type":"levels","rms":0.12,"bands":[0.1,0.2]}')).toEqual({
      type: "levels",
      rms: 0.12,
      bands: [0.1, 0.2],
    });
    expect(parseMessage('{"type":"levels","rms":3}')).toEqual({ type: "levels", rms: 1, bands: null });
    expect(parseMessage('{"type":"levels","rms":0.1,"bands":["x"]}')).toMatchObject({ bands: null });
    expect(parseMessage('{"type":"levels"}')).toBeNull();
  });

  it("never changes the reduced state", () => {
    const s = initialState();
    expect(reduce(s, { type: "levels", rms: 0.5, bands: null })).toBe(s);
  });
});

describe("waveform", () => {
  it("maps levels on a dB scale: silence 0, loud speech near 1", () => {
    expect(levelValue(0)).toBe(0);
    expect(levelValue(10 ** (-60 / 20))).toBe(0);
    expect(levelValue(10 ** (-12 / 20))).toBeCloseTo(1);
    const quiet = levelValue(10 ** (-40 / 20));
    const loud = levelValue(10 ** (-20 / 20));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet * 3);
  });

  it("moves at a fixed rate, rises fast, falls slowly and goes quiet when the feed stops", () => {
    const h = new WaveHistory(60);
    let now = 0;
    const step = (ms: number) => {
      now += ms;
      h.advance(ms, now);
    };
    expect(h.silent()).toBe(true);
    h.push(0.2, now);
    step(STEP_MS);
    const first = h.at(0);
    expect(first).toBeGreaterThan(0.4 * levelValue(0.2));
    for (let i = 0; i < 3; i++) step(STEP_MS);
    expect(h.at(0)).toBeGreaterThan(first);
    expect(h.at(3)).toBeCloseTo(first);
    expect(h.silent()).toBe(false);
    // No new level for longer than the stale window: it decays, then the history scrolls clear.
    step(1000);
    expect(h.at(0)).toBeLessThan(0.01);
    step(STEP_MS * 60);
    expect(h.silent()).toBe(true);
  });

  it("does not replay a long gap step by step", () => {
    const h = new WaveHistory(10);
    h.push(0.2, 0);
    h.advance(60_000, 60_000);
    expect(h.silent()).toBe(true);
  });
});
