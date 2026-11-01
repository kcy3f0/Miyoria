// PlayerPort backed by a real @discordjs/voice AudioPlayer.
//
// We encode to Opus ourselves (one 20 ms packet per pull, tiny look-ahead) and hand the player
// an Opus object stream (`StreamType.Opus`). Compared to feeding `StreamType.Raw` through
// prism-media's encoder this keeps latency to ~1 frame, which is what makes the barge-in fade
// (`play_stop`) land on time, and lets us pad underruns with Opus silence frames ourselves.
import {
  type AudioPlayer,
  AudioPlayerStatus,
  createAudioResource,
  StreamType,
  type AudioResource,
} from "@discordjs/voice";
import OpusScript from "opusscript";
import { Readable } from "node:stream";
import type { Logger } from "../log.js";
import { noopLogger } from "../log.js";
import type { PlayerHooks, PlayerPort } from "./queue.js";
import { FRAME_SAMPLES, OUT_RATE, type PlaybackSource } from "./source.js";

/** Opus packet for 20 ms of silence (same bytes @discordjs/voice uses). */
const OPUS_SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

/** Object-mode Readable of Opus packets, pulled frame by frame from a {@link PlaybackSource}. */
export class OpusFrameStream extends Readable {
  private readonly encoder: OpusScript;
  private deleted = false;

  constructor(private readonly source: PlaybackSource) {
    super({ objectMode: true, highWaterMark: 1 });
    this.encoder = new OpusScript(OUT_RATE, 2, OpusScript.Application.AUDIO);
    this.encoder.setBitrate(96_000);
  }

  override _read(): void {
    try {
      const r = this.source.readFrame();
      if (r.kind === "audio") {
        // Buffer.from copies out of the WASM heap before the next encode reuses it.
        this.push(Buffer.from(this.encoder.encode(r.pcm, FRAME_SAMPLES)));
      } else if (r.kind === "silence") {
        this.push(OPUS_SILENCE);
      } else {
        this.push(null);
      }
    } catch (err) {
      this.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.deleted) {
      this.deleted = true;
      try {
        this.encoder.delete();
      } catch {
        // already freed
      }
    }
    callback(error);
  }
}

interface Current {
  resource: AudioResource;
  hooks: PlayerHooks;
  started: boolean;
  error?: Error;
}

export class DiscordPlayerPort implements PlayerPort {
  private current: Current | undefined;

  constructor(
    private readonly player: AudioPlayer,
    private readonly log: Logger = noopLogger,
  ) {
    player.on("stateChange", (oldState, newState) => {
      const cur = this.current;
      if (!cur) return;
      if (
        newState.status === AudioPlayerStatus.Playing &&
        oldState.status !== AudioPlayerStatus.Playing &&
        newState.resource === cur.resource &&
        !cur.started
      ) {
        cur.started = true;
        cur.hooks.started();
      }
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        // The player only goes idle for the resource it was given.
        this.current = undefined;
        cur.hooks.ended(cur.error);
      }
    });
    player.on("error", (err) => {
      this.log.warn("audio player error:", err.message);
      if (this.current) this.current.error = err;
    });
  }

  play(source: PlaybackSource, hooks: PlayerHooks): void {
    const stream = new OpusFrameStream(source);
    const resource = createAudioResource(stream, {
      inputType: StreamType.Opus,
      silencePaddingFrames: 5,
    });
    this.current = { resource, hooks, started: false };
    this.player.play(resource);
  }

  stop(): void {
    this.player.stop(true);
  }
}
