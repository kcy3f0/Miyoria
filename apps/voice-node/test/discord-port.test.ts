// Runs the real DiscordPlayerPort + @discordjs/voice AudioPlayer + opusscript (no network):
// with NoSubscriberBehavior.Play the player pulls Opus frames every 20 ms even without a voice connection.
import { createAudioPlayer, NoSubscriberBehavior } from "@discordjs/voice";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordPlayerPort } from "../src/playback/discord-port.js";
import { type PlaybackEvent, PlaybackQueue } from "../src/playback/queue.js";
import { PlaybackSource } from "../src/playback/source.js";

function pcm(ms: number, rate = 24_000): Buffer {
  const n = Math.round((ms * rate) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  return b;
}

function setup() {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play }, debug: false });
  const events: PlaybackEvent[] = [];
  const queue = new PlaybackQueue({
    port: new DiscordPlayerPort(player),
    onEvent: (e) => events.push(e),
    createSource: (sampleRate) =>
      new PlaybackSource({ sampleRate, maxBufferBytes: 10_000_000, prebufferMs: 20, maxStarveMs: 2000 }),
  });
  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timeout; events=${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { player, queue, events, waitFor };
}

let toStop: { stop(force?: boolean): boolean } | undefined;
afterEach(() => toStop?.stop(true));

describe("DiscordPlayerPort (real AudioPlayer)", () => {
  it("plays a resampled stream through to finished", async () => {
    const { player, queue, events, waitFor } = setup();
    toStop = player;
    queue.start(1, 24_000);
    queue.push(1, pcm(300));
    queue.end(1);
    await waitFor(() => events.some((e) => e.state === "finished"));
    expect(events.map((e) => e.state)).toEqual(["started", "finished"]);
  });

  it("queues a second playback behind the first", async () => {
    const { player, queue, events, waitFor } = setup();
    toStop = player;
    queue.start(1, 24_000);
    queue.start(2, 16_000);
    queue.push(1, pcm(120));
    queue.end(1);
    queue.push(2, pcm(120, 16_000));
    queue.end(2);
    await waitFor(() => events.filter((e) => e.state === "finished").length === 2);
    expect(events.map((e) => `${e.play}:${e.state}`)).toEqual(["1:started", "1:finished", "2:started", "2:finished"]);
  });

  it("fades out and reports interrupted on play_stop", async () => {
    const { player, queue, events, waitFor } = setup();
    toStop = player;
    queue.start(1, 24_000);
    queue.push(1, pcm(5000));
    await waitFor(() => events.some((e) => e.state === "started"));
    const t0 = Date.now();
    queue.stop(1, 100);
    await waitFor(() => events.some((e) => e.state === "interrupted"));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(events.map((e) => e.state)).toEqual(["started", "interrupted"]);
  });

  it("cuts immediately when fade_ms is 0", async () => {
    const { player, queue, events, waitFor } = setup();
    toStop = player;
    queue.start(1, 24_000);
    queue.push(1, pcm(5000));
    await waitFor(() => events.some((e) => e.state === "started"));
    queue.stop(1, 0);
    await waitFor(() => events.some((e) => e.state === "interrupted"));
    expect(events.map((e) => e.state)).toEqual(["started", "interrupted"]);
  });
});
