import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { VoiceReceiver } from "@discordjs/voice";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_FRAME_SAMPLES,
  CaptureManager,
  CapturePipeline,
  type OpusDecoderLike,
  type SpeakerInfo,
  StreamIdAllocator,
} from "../src/capture.js";
import type { LinkSink } from "../src/link.js";
import { decodeBinaryFrame, FRAME_CAPTURE, type NodeMessage, U32_MAX } from "../src/protocol.js";

/** "Decodes" any packet into 20 ms of constant stereo 48 kHz audio. */
function fakeDecoder(value = 4000): OpusDecoderLike & { deleted: boolean; fail: boolean } {
  const d = {
    deleted: false,
    fail: false,
    decode(): Buffer {
      if (d.fail) throw new Error("corrupted stream");
      const b = Buffer.alloc(960 * 4);
      for (let i = 0; i < 960 * 2; i++) b.writeInt16LE(value, i * 2);
      return b;
    },
    delete(): void {
      d.deleted = true;
    },
  };
  return d;
}

describe("CapturePipeline", () => {
  it("turns 20 ms stereo/48k Opus packets into exact 640-byte mono/16k frames", () => {
    const p = new CapturePipeline(fakeDecoder());
    const frames: Buffer[] = [];
    for (let i = 0; i < 10; i++) frames.push(...p.push(Buffer.from([1])));
    frames.push(...p.finish());
    expect(frames.reduce((a, f) => a + f.length, 0)).toBe(10 * CAPTURE_FRAME_SAMPLES * 2);
    expect(frames.every((f) => f.length === 640)).toBe(true);
    // downmixed constant stays constant in the middle of the stream
    expect(frames[5]?.readInt16LE(100)).toBeGreaterThan(3900);
    expect(frames[5]?.readInt16LE(100)).toBeLessThan(4100);
  });

  it("flushes a short final frame", () => {
    const p = new CapturePipeline(fakeDecoder());
    p.push(Buffer.from([1])); // 960 samples @ 48k -> 320 @ 16k, minus filter delay: < 1 frame
    const tail = p.finish();
    expect(tail.reduce((a, f) => a + f.length, 0)).toBe(640);
  });

  it("counts undecodable packets instead of throwing", () => {
    const dec = fakeDecoder();
    const p = new CapturePipeline(dec);
    dec.fail = true;
    expect(p.push(Buffer.from([1]))).toEqual([]);
    expect(p.decodeErrors).toBe(1);
    p.dispose();
    expect(dec.deleted).toBe(true);
  });
});

describe("StreamIdAllocator", () => {
  it("counts up from 1 and wraps inside u32 without producing 0", () => {
    const a = new StreamIdAllocator();
    expect([a.take(), a.take(), a.take()]).toEqual([1, 2, 3]);
    const w = new StreamIdAllocator(U32_MAX - 1);
    expect([w.take(), w.take(), w.take()]).toEqual([U32_MAX - 1, U32_MAX, 1]);
  });
});

// ── CaptureManager with a fake receiver / link ──────────────────────────────

class FakeLink implements LinkSink {
  messages: NodeMessage[] = [];
  audio: Buffer[] = [];
  up = true;
  audioUp = true;
  send(msg: NodeMessage): boolean {
    if (!this.up) return false;
    this.messages.push(msg);
    return true;
  }
  sendAudio(frame: Buffer): boolean {
    if (!this.up || !this.audioUp) return false;
    this.audio.push(frame);
    return true;
  }
  types(): string[] {
    return this.messages.map((m) => m.type);
  }
}

function setup(resolve: (id: string) => SpeakerInfo | null = () => ({ isBot: false, displayName: "Alice" })) {
  const speaking = new EventEmitter();
  const streams = new Map<string, PassThrough>();
  const subscribeCalls: { userId: string; opts: unknown }[] = [];
  const receiver = {
    speaking,
    subscribe(userId: string, opts: unknown) {
      subscribeCalls.push({ userId, opts });
      const s = new PassThrough({ objectMode: true });
      streams.set(userId, s);
      return s;
    },
  } as unknown as VoiceReceiver;
  const link = new FakeLink();
  const decoders: ReturnType<typeof fakeDecoder>[] = [];
  const mgr = new CaptureManager({
    receiver,
    link,
    guildId: "G",
    getChannelId: () => "C",
    selfId: "SELF",
    silenceMs: 400,
    ids: new StreamIdAllocator(),
    resolveSpeaker: resolve,
    createDecoder: () => {
      const d = fakeDecoder();
      decoders.push(d);
      return d;
    },
  });
  mgr.start();
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { speaking, streams, subscribeCalls, link, mgr, decoders, settle };
}

const packets = (s: PassThrough, n: number) => {
  for (let i = 0; i < n; i++) s.write(Buffer.from([1, 2, 3]));
};

describe("CaptureManager", () => {
  it("opens a stream for a speaker, forwards 640-byte frames, and closes it", async () => {
    const t = setup();
    t.speaking.emit("start", "U1");
    await t.settle();
    expect(t.link.messages[0]).toEqual({ type: "speaking", guild: "G", user_id: "U1", speaking: true });
    expect(t.subscribeCalls).toHaveLength(1);
    expect(t.subscribeCalls[0]?.opts).toMatchObject({ end: { duration: 400 } });

    const s = t.streams.get("U1") as PassThrough;
    packets(s, 6);
    await t.settle();
    const open = t.link.messages.find((m) => m.type === "stream_open");
    expect(open).toEqual({
      type: "stream_open",
      stream: 1,
      guild: "G",
      channel: "C",
      user_id: "U1",
      display_name: "Alice",
      sample_rate: 16_000,
    });
    // stream_open precedes the audio
    expect(t.link.messages.map((m) => m.type)).toEqual(["speaking", "stream_open"]);
    expect(t.link.audio.length).toBeGreaterThanOrEqual(4);
    for (const f of t.link.audio) {
      const d = decodeBinaryFrame(f);
      expect(d.ok && d.value.kind).toBe(FRAME_CAPTURE);
      expect(d.ok && d.value.id).toBe(1);
      expect(d.ok && d.value.pcm.length).toBe(640);
    }

    s.end(); // receiver ended the subscription (AfterSilence)
    await t.settle();
    t.speaking.emit("end", "U1");
    expect(t.link.messages.map((m) => m.type)).toEqual(["speaking", "stream_open", "stream_close", "speaking"]);
    expect(t.link.messages.at(-2)).toEqual({ type: "stream_close", stream: 1 });
    expect(t.link.messages.at(-1)).toMatchObject({ speaking: false });
    expect(t.decoders[0]?.deleted).toBe(true);
    expect(t.mgr.activeStreams).toBe(0);
  });

  it("uses a new, incremented stream id for the next utterance", async () => {
    const t = setup();
    for (let round = 1; round <= 2; round++) {
      t.speaking.emit("start", "U1");
      await t.settle();
      const s = t.streams.get("U1") as PassThrough;
      packets(s, 4);
      s.end();
      await t.settle();
      t.speaking.emit("end", "U1");
      expect(t.link.messages.filter((m) => m.type === "stream_open").pop()).toMatchObject({ stream: round });
    }
  });

  it("keeps one stream across a short pause (speaking start while already capturing)", async () => {
    const t = setup();
    t.speaking.emit("start", "U1");
    await t.settle();
    packets(t.streams.get("U1") as PassThrough, 4);
    t.speaking.emit("end", "U1");
    t.speaking.emit("start", "U1");
    await t.settle();
    expect(t.subscribeCalls).toHaveLength(1);
    expect(t.link.messages.filter((m) => m.type === "speaking").map((m) => (m as { speaking: boolean }).speaking)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("ignores the self account and bots entirely", async () => {
    const t = setup((id) => ({ isBot: id === "BOT", displayName: id }));
    t.speaking.emit("start", "SELF");
    t.speaking.emit("start", "BOT");
    await t.settle();
    expect(t.subscribeCalls).toHaveLength(0);
    expect(t.link.messages).toEqual([]);
  });

  it("falls back to the user id as display name when the speaker is unknown", async () => {
    const t = setup(() => null);
    t.speaking.emit("start", "U9");
    await t.settle();
    packets(t.streams.get("U9") as PassThrough, 4);
    await t.settle();
    expect(t.link.messages.find((m) => m.type === "stream_open")).toMatchObject({ display_name: "U9" });
  });

  it("does not announce a stream it never sent audio for", async () => {
    const t = setup();
    t.speaking.emit("start", "U1");
    await t.settle();
    (t.streams.get("U1") as PassThrough).write(Buffer.from([1])); // one packet: less than a frame
    (t.streams.get("U1") as PassThrough).end();
    await t.settle();
    expect(t.link.types()).toEqual(["speaking"]);
  });

  it("drops audio while the link is down and opens the stream once it is back", async () => {
    const t = setup();
    t.speaking.emit("start", "U1");
    await t.settle();
    t.link.up = false;
    packets(t.streams.get("U1") as PassThrough, 4);
    await t.settle();
    expect(t.link.messages.filter((m) => m.type === "stream_open")).toHaveLength(0);
    t.link.up = true;
    packets(t.streams.get("U1") as PassThrough, 4);
    await t.settle();
    expect(t.link.messages.filter((m) => m.type === "stream_open")).toHaveLength(1);
    expect(t.link.audio.length).toBeGreaterThan(0);
  });

  it("re-announces open streams with a fresh id after the link was reset", async () => {
    const t = setup();
    t.speaking.emit("start", "U1");
    await t.settle();
    const s = t.streams.get("U1") as PassThrough;
    packets(s, 4);
    await t.settle();
    t.mgr.onLinkReset();
    packets(s, 4);
    await t.settle();
    const opens = t.link.messages.filter((m) => m.type === "stream_open");
    expect(opens.map((m) => (m as { stream: number }).stream)).toEqual([1, 2]);
  });

  it("stop() closes open streams and detaches", async () => {
    const t = setup();
    t.speaking.emit("start", "U1");
    await t.settle();
    packets(t.streams.get("U1") as PassThrough, 4);
    await t.settle();
    t.mgr.stop();
    expect(t.link.types()).toContain("stream_close");
    expect(t.speaking.listenerCount("start")).toBe(0);
    const before = t.link.messages.length;
    t.speaking.emit("start", "U2");
    await t.settle();
    expect(t.link.messages.length).toBe(before);
  });
});
