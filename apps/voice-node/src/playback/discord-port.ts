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
import { Readable } from "node:stream";
import { OpusCodec } from "../audio/opus.js";
import type { LevelPublisher, LevelTap } from "../levels/publisher.js";
import type { Logger } from "../log.js";
import { noopLogger } from "../log.js";
import type { PlayerHooks, PlayerPort } from "./queue.js";
import { FRAME_SAMPLES, OUT_RATE, type PlaybackSource } from "./source.js";

/** Opus packet for 20 ms of silence (same bytes @discordjs/voice uses). */
const OPUS_SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

/** Object-mode Readable of Opus packets, pulled frame by frame from a {@link PlaybackSource}. */
export class OpusFrameStream extends Readable {
  private readonly encoder: OpusCodec;
  private deleted = false;

  constructor(
    private readonly source: PlaybackSource,
    /** Receives every frame pulled (lip-sync levels). Optional. */
    private readonly tap?: LevelTap,
  ) {
    super({ objectMode: true, highWaterMark: 1 });
    this.encoder = new OpusCodec(OUT_RATE, 2);
    this.encoder.setBitrate(96_000);
  }

  override _read(): void {
    try {
      const r = this.source.readFrame();
      if (r.kind === "audio") {
        // A play with a levels track (a song's vocals) moves her mouth with that, not the mix.
        this.tap?.frame(r.levels ?? r.pcm);
        this.push(this.encoder.encode(r.pcm, FRAME_SAMPLES)); // already a copy
      } else if (r.kind === "silence") {
        this.tap?.silence(FRAME_SAMPLES);
        this.push(OPUS_SILENCE);
      } else {
        this.tap?.end();
        this.push(null);
      }
    } catch (err) {
      this.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.tap?.cancel();
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
    private readonly levels?: LevelPublisher,
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
    const stream = new OpusFrameStream(source, this.levels?.begin());
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
