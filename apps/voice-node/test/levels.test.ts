import type { AddressInfo } from "node:net";
import { createAudioPlayer, NoSubscriberBehavior } from "@discordjs/voice";
import { afterEach, describe, expect, it } from "vitest";
import { type RawData, WebSocketServer } from "ws";
import { encodeLevel, LevelsClient } from "../src/levels/client.js";
import { LevelPublisher, type Schedule } from "../src/levels/publisher.js";
import { type LevelPoint, RmsFramer } from "../src/levels/rms.js";
import { DiscordPlayerPort } from "../src/playback/discord-port.js";
import { PlaybackQueue } from "../src/playback/queue.js";
import { FRAME_BYTES, PlaybackSource } from "../src/playback/source.js";

/** Interleaved s16le: `n` frames of constant value (same on every channel). */
function constant(value: number, frames: number, channels = 2): Buffer {
  const b = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames * channels; i++) b.writeInt16LE(value, i * 2);
  return b;
}

function sine(amplitude: number, frames: number, rate = 48_000, hz = 440): Buffer {
  const b = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
    b.writeInt16LE(s, i * 4);
    b.writeInt16LE(s, i * 4 + 2);
  }
  return b;
}

const framer = (over: Partial<ConstructorParameters<typeof RmsFramer>[0]> = {}) =>
  new RmsFramer({ sampleRate: 48_000, channels: 2, ...over });

describe("RmsFramer", () => {
  it("uses 10 ms windows: 480 samples at 48 kHz", () => {
    expect(framer().windowSamples).toBe(480);
    expect(framer({ sampleRate: 16_000, channels: 1 }).windowSamples).toBe(160);
  });

  it("cuts a 20 ms frame into two windows with t = 0 and 10", () => {
    const pts = framer().pushPcm(constant(16384, 960));
    expect(pts.map((p) => p.t)).toEqual([0, 10]);
    expect(pts.every((p) => Math.abs(p.rms - 0.5) < 1e-9)).toBe(true);
  });

  it("measures full-scale DC as 1, silence as 0, a sine as amplitude / sqrt(2)", () => {
    expect(framer().pushPcm(constant(-32768, 480))[0]?.rms).toBe(1);
    expect(framer().pushPcm(constant(0, 480))[0]?.rms).toBe(0);
    const [p] = framer().pushPcm(sine(20000, 480)); // 480 samples = 4.4 periods; allow partial-period error
    expect(p?.rms).toBeGreaterThan(0.4);
    expect(p?.rms).toBeLessThan(0.45); // 20000 / 32768 / sqrt(2) = 0.4316
    const whole = framer({ sampleRate: 48_000, channels: 2, windowMs: 100 }).pushPcm(sine(20000, 4800))[0];
    expect(whole?.rms).toBeCloseTo(20000 / 32768 / Math.SQRT2, 3);
  });

  it("carries a partial window over to the next push", () => {
    const f = framer();
    expect(f.pushPcm(constant(8000, 300))).toEqual([]);
    const pts = f.pushPcm(constant(8000, 700));
    expect(pts.map((p) => p.t)).toEqual([0, 10]); // 1000 samples = two windows, 40 left over
    expect(f.pushPcm(constant(8000, 440)).map((p) => p.t)).toEqual([20]);
    expect(f.positionMs).toBe(30);
  });

  it("averages the channels before the RMS (L = -R cancels)", () => {
    const b = Buffer.alloc(480 * 4);
    for (let i = 0; i < 480; i++) {
      b.writeInt16LE(10000, i * 4);
      b.writeInt16LE(-10000, i * 4 + 2);
    }
    expect(framer().pushPcm(b)[0]?.rms).toBe(0);
    expect(framer({ channels: 1 }).pushPcm(constant(16384, 480, 1))[0]?.rms).toBeCloseTo(0.5, 9);
  });

  it("ignores a trailing partial sample frame and works on unaligned views", () => {
    const f = framer();
    const backing = Buffer.concat([Buffer.from([1]), constant(8192, 480), Buffer.from([7, 7, 7])]);
    const view = backing.subarray(1, 1 + 480 * 4 + 3); // odd byte offset, 3 stray bytes
    const pts = f.pushPcm(view);
    expect(pts).toHaveLength(1);
    expect(pts[0]?.rms).toBeCloseTo(0.25, 9);
  });

  it("advances over silence and applies gain with a clamp at 1", () => {
    const f = framer({ gain: 4 });
    expect(f.pushSilence(960).map((p) => [p.t, p.rms])).toEqual([[0, 0], [10, 0]]);
    expect(f.pushPcm(constant(16384, 480))[0]).toEqual({ t: 20, rms: 1 });
    expect(framer({ gain: 0.5 }).pushPcm(constant(16384, 480))[0]?.rms).toBeCloseTo(0.25, 9);
  });

  it("reset() restarts the timeline", () => {
    const f = framer();
    f.pushPcm(constant(1, 960));
    f.reset();
    expect(f.pushPcm(constant(1, 480))[0]?.t).toBe(0);
  });
});

describe("LevelPublisher", () => {
  function setup(gain = 1) {
    let clock = 1000;
    const sent: (LevelPoint & { at: number })[] = [];
    const timers: { fn: () => void; due: number; cancelled: boolean }[] = [];
    const schedule: Schedule = (fn, ms) => {
      const t = { fn, due: clock + ms, cancelled: false };
      timers.push(t);
      return { cancel: () => (t.cancelled = true) };
    };
    const pub = new LevelPublisher({
      sink: { send: (p) => sent.push({ ...p, at: clock }) },
      gain,
      schedule,
      now: () => clock,
    });
    /** Advances the fake clock, firing due timers in order. */
    const advance = (ms: number) => {
      const target = clock + ms;
      for (;;) {
        const next = timers.filter((t) => !t.cancelled && t.due <= target).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        clock = Math.max(clock, next.due);
        next.fn();
      }
      clock = target;
    };
    return { pub, sent, advance, timers, now: () => clock };
  }

  it("paces windows 10 ms apart on the wall clock; silence is rms 0", () => {
    const { pub, sent, advance } = setup();
    const tap = pub.begin();
    tap.frame(constant(16384, 960));
    expect(sent.map((p) => [p.t, p.at])).toEqual([[0, 1000]]);
    advance(10);
    expect(sent.map((p) => [p.t, p.at])).toEqual([[0, 1000], [10, 1010]]);
    advance(10);
    tap.silence(960);
    advance(20);
    expect(sent.slice(2).map((p) => [p.t, p.rms, p.at])).toEqual([[20, 0, 1020], [30, 0, 1030]]);
  });

  it("keeps the points evenly spaced and in order when the player reads ahead in a burst", () => {
    const { pub, sent, advance } = setup();
    const tap = pub.begin();
    for (let i = 0; i < 4; i++) tap.frame(constant(16384, 960)); // 80 ms of audio pulled at once
    expect(sent.map((p) => p.t)).toEqual([0]);
    advance(80);
    expect(sent.map((p) => [p.t, p.at])).toEqual(
      [0, 10, 20, 30, 40, 50, 60, 70].map((t) => [t, 1000 + t]),
    );
  });

  it("re-anchors the timeline after a stall instead of bursting", () => {
    const { pub, sent, advance } = setup();
    const tap = pub.begin();
    tap.frame(constant(16384, 960));
    advance(500); // the player stalled for half a second
    tap.frame(constant(16384, 960)); // t = 20, 480 ms late
    advance(10);
    const late = sent.filter((p) => p.t >= 20);
    expect(late.map((p) => p.t)).toEqual([20, 30]);
    expect(late[1]!.at - late[0]!.at).toBe(10);
  });

  it("a natural end sends the last windows, then a zero at the end of the audio", () => {
    const { pub, sent, advance } = setup();
    const tap = pub.begin();
    tap.frame(constant(16384, 960));
    tap.end();
    expect(sent.map((p) => p.t)).toEqual([0]);
    advance(20);
    expect(sent.map((p) => [p.t, p.rms > 0])).toEqual([[0, true], [10, true], [20, false]]);
    tap.frame(constant(16384, 960)); // ignored after end
    advance(100);
    expect(sent).toHaveLength(3);
  });

  it("cancel() drops pending windows and zeroes the mouth now; it does not cut a natural end short", () => {
    const a = setup();
    const t1 = a.pub.begin();
    t1.frame(constant(16384, 960));
    t1.cancel();
    expect(a.sent.at(-1)).toMatchObject({ t: 20, rms: 0, at: 1000 });
    a.advance(100);
    expect(a.sent).toHaveLength(2); // the second window never fired
    t1.cancel();
    expect(a.sent).toHaveLength(2);

    const b = setup();
    const t2 = b.pub.begin();
    t2.frame(constant(16384, 960));
    t2.end();
    t2.cancel(); // what the stream's destroy does after a natural end
    b.advance(20);
    expect(b.sent.map((p) => p.t)).toEqual([0, 10, 20]);
  });

  it("a newer playback restarts t at 0 and silently replaces the older one", () => {
    const { pub, sent, advance } = setup();
    const a = pub.begin();
    a.frame(constant(8000, 960));
    const b = pub.begin();
    advance(5);
    b.frame(constant(8000, 480));
    advance(50);
    a.frame(constant(8000, 480)); // a is over; ignored
    advance(50);
    expect(sent.map((p) => p.t)).toEqual([0, 0]); // a's t = 0, b's t = 0; nothing else (no stray zero)
  });
});

describe("encodeLevel", () => {
  it("formats the Stage's wire frame", () => {
    expect(encodeLevel({ t: 20, rms: 0.123456 })).toBe('{"t":20,"rms":0.1235}');
    expect(JSON.parse(encodeLevel({ t: 0, rms: 0 }))).toEqual({ t: 0, rms: 0 });
    expect(encodeLevel({ t: 9.6, rms: 1 })).toBe('{"t":10,"rms":1}');
  });
});

describe("LevelsClient", () => {
  let server: WebSocketServer | undefined;
  let client: LevelsClient | undefined;
  afterEach(async () => {
    client?.stop();
    client = undefined;
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  const until = async (cond: () => boolean, ms = 4000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("connects, sends JSON level frames, and drops points while disconnected", async () => {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => server?.once("listening", () => r()));
    const port = (server.address() as AddressInfo).port;
    const got: unknown[] = [];
    server.on("connection", (ws) => ws.on("message", (d: RawData) => got.push(JSON.parse(d.toString()))));

    client = new LevelsClient({ url: `ws://127.0.0.1:${port}/levels`, backoffMinMs: 10, backoffMaxMs: 50 });
    client.send({ t: 0, rms: 0.5 }); // not started yet: dropped
    client.start();
    await until(() => client?.connected === true);
    client.send({ t: 10, rms: 0.25 });
    client.send({ t: 20, rms: 0 });
    await until(() => got.length === 2);
    expect(got).toEqual([{ t: 10, rms: 0.25 }, { t: 20, rms: 0 }]);
  });

  it("keeps retrying quietly while the Stage is down, then connects when it appears", async () => {
    // Reserve a port, free it, and start the server late.
    const probe = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => probe.once("listening", () => r()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const warnings: unknown[][] = [];
    const log = { error() {}, info() {}, debug() {}, warn: (...a: unknown[]) => warnings.push(a) };
    client = new LevelsClient({ url: `ws://127.0.0.1:${port}/levels`, log, backoffMinMs: 10, backoffMaxMs: 30 });
    client.start();
    await new Promise((r) => setTimeout(r, 250)); // many failed attempts
    expect(client.connected).toBe(false);
    expect(warnings).toHaveLength(1); // one warning per outage, not one per attempt

    const got: unknown[] = [];
    server = new WebSocketServer({ port, host: "127.0.0.1" });
    server.on("connection", (ws) => ws.on("message", (d: RawData) => got.push(JSON.parse(d.toString()))));
    await until(() => client?.connected === true);
    client.send({ t: 1, rms: 0.1 });
    await until(() => got.length === 1);
  });
});

describe("DiscordPlayerPort levels (real AudioPlayer)", () => {
  it("reports levels of the audio actually pulled, then a final zero", async () => {
    const sent: LevelPoint[] = [];
    const pub = new LevelPublisher({ sink: { send: (p) => sent.push(p) } });
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const events: string[] = [];
    const queue = new PlaybackQueue({
      port: new DiscordPlayerPort(player, undefined, pub),
      onEvent: (e) => events.push(e.state),
      createSource: (sampleRate) =>
        new PlaybackSource({ sampleRate, maxBufferBytes: 10_000_000, prebufferMs: 20, maxStarveMs: 2000 }),
    });
    try {
      // 200 ms of a half-scale-ish sine at 24 kHz (resampled to 48 kHz by the source).
      const n = 4800;
      const pcm = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(16000 * Math.sin((2 * Math.PI * 300 * i) / 24_000)), i * 2);
      queue.start(1, 24_000);
      queue.push(1, pcm);
      queue.end(1);
      const t0 = Date.now();
      while (!events.includes("finished")) {
        if (Date.now() - t0 > 4000) throw new Error(`timeout ${events.join(",")}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 80)); // the last windows and the final zero are paced on the wall clock
      const loud = sent.filter((p) => p.rms > 0.2);
      expect(loud.length).toBeGreaterThanOrEqual(15); // ~200 ms = 20 windows
      expect(sent[0]?.t).toBe(0);
      // Window starts are 10 ms apart and in order for the audio part.
      const ts = sent.map((p) => p.t);
      expect([...ts].sort((a, b) => a - b)).toEqual(ts);
      expect(sent.at(-1)?.rms).toBe(0);
      expect(sent.at(-1)?.t).toBeGreaterThanOrEqual(190);
      expect(FRAME_BYTES).toBe(3840);
    } finally {
      player.stop(true);
    }
  });
});
