// Voice capture: Discord Opus (per speaker) -> 16 kHz mono s16le frames for Core.
import { type AudioReceiveStream, EndBehaviorType, type VoiceReceiver } from "@discordjs/voice";
import { SampleFifo } from "./audio/fifo.js";
import { OpusCodec } from "./audio/opus.js";
import { bytesToInt16, int16ToBuffer, Resampler, stereoToMono } from "./audio/resampler.js";
import type { LinkSink } from "./link.js";
import type { Logger } from "./log.js";
import { noopLogger } from "./log.js";
import { CAPTURE_SAMPLE_RATE, encodeCaptureFrame, U32_MAX } from "./protocol.js";

const DISCORD_RATE = 48_000;
/** Samples in one 20 ms capture frame at 16 kHz (640 bytes). */
export const CAPTURE_FRAME_SAMPLES = (CAPTURE_SAMPLE_RATE * 20) / 1000;

export interface OpusDecoderLike {
  /** Opus packet -> interleaved stereo s16le @ 48 kHz. */
  decode(packet: Buffer): Buffer;
  delete(): void;
}

export function createOpusDecoder(): OpusDecoderLike {
  return new OpusCodec(DISCORD_RATE, 2);
}

/** Opus -> stereo 48k -> mono 48k -> mono 16k -> exact 20 ms frames. One per speaker stream. */
export class CapturePipeline {
  private readonly resampler = new Resampler(DISCORD_RATE, CAPTURE_SAMPLE_RATE);
  private readonly fifo = new SampleFifo();
  decodeErrors = 0;

  constructor(private readonly decoder: OpusDecoderLike) {}

  /** Feeds one Opus packet; returns zero or more complete 640-byte frames. */
  push(packet: Buffer): Buffer[] {
    let pcm: Buffer;
    try {
      pcm = this.decoder.decode(packet); // already a copy out of the WASM heap
    } catch {
      this.decodeErrors++;
      return [];
    }
    const mono48 = stereoToMono(bytesToInt16(pcm));
    this.fifo.push(this.resampler.process(mono48));
    return this.drain(false);
  }

  /** End of stream: flushes the resampler and returns the remaining (possibly short) frames. */
  finish(): Buffer[] {
    this.fifo.push(this.resampler.flush());
    return this.drain(true);
  }

  dispose(): void {
    try {
      this.decoder.delete();
    } catch {
      // already freed
    }
  }

  private drain(final: boolean): Buffer[] {
    const frames: Buffer[] = [];
    while (this.fifo.length >= CAPTURE_FRAME_SAMPLES) {
      frames.push(int16ToBuffer(this.fifo.take(CAPTURE_FRAME_SAMPLES)));
    }
    if (final && this.fifo.length > 0) frames.push(int16ToBuffer(this.fifo.take(this.fifo.length)));
    return frames;
  }
}

/** Incrementing u32 stream ids (wraps, skipping 0 so a zeroed id is never valid). */
export class StreamIdAllocator {
  constructor(private next = 1) {}
  take(): number {
    const id = this.next;
    this.next = this.next >= U32_MAX ? 1 : this.next + 1;
    return id;
  }
}

export interface SpeakerInfo {
  isBot: boolean;
  displayName: string;
}

export interface CaptureOptions {
  receiver: VoiceReceiver;
  link: LinkSink;
  guildId: string;
  /** Current channel id (can change if the self account is moved). */
  getChannelId: () => string;
  selfId: string;
  silenceMs: number;
  ids: StreamIdAllocator;
  /** Looks the speaker up (may be async if not cached). Return null if unknown. */
  resolveSpeaker: (userId: string) => SpeakerInfo | null | Promise<SpeakerInfo | null>;
  createDecoder?: () => OpusDecoderLike;
  log?: Logger;
}

interface ActiveStream {
  userId: string;
  displayName: string;
  pipeline: CapturePipeline;
  /** Core-visible stream id; undefined until stream_open has been sent. */
  id: number | undefined;
  closed: boolean;
  opus: AudioReceiveStream | undefined;
}

/** Wires a VoiceReceiver to the Voice Link: `speaking`, `stream_open`, audio frames, `stream_close`. */
export class CaptureManager {
  private readonly o: CaptureOptions;
  private readonly log: Logger;
  private readonly streams = new Map<string, ActiveStream>();
  private readonly speaking = new Set<string>();
  private readonly resolving = new Set<string>();
  private readonly createDecoder: () => OpusDecoderLike;
  private dropped = 0;
  private lastDropLog = 0;
  private started = false;

  private readonly onStart = (userId: string): void => {
    void this.handleSpeakingStart(userId);
  };
  private readonly onEnd = (userId: string): void => {
    if (this.speaking.delete(userId)) {
      this.o.link.send({ type: "speaking", guild: this.o.guildId, user_id: userId, speaking: false });
    }
  };

  constructor(opts: CaptureOptions) {
    this.o = opts;
    this.log = opts.log ?? noopLogger;
    this.createDecoder = opts.createDecoder ?? createOpusDecoder;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.o.receiver.speaking.on("start", this.onStart);
    this.o.receiver.speaking.on("end", this.onEnd);
  }

  /** Closes every open stream (sending stream_close) and detaches from the receiver. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.o.receiver.speaking.off("start", this.onStart);
    this.o.receiver.speaking.off("end", this.onEnd);
    for (const userId of [...this.speaking]) this.onEnd(userId);
    for (const s of [...this.streams.values()]) this.closeStream(s, true);
  }

  /**
   * The Core connection was re-established: it knows nothing about our open streams.
   * Keep decoding, but announce each one again (with a fresh id) on its next audio frame.
   */
  onLinkReset(): void {
    for (const s of this.streams.values()) s.id = undefined;
  }

  get activeStreams(): number {
    return this.streams.size;
  }

  private async handleSpeakingStart(userId: string): Promise<void> {
    if (userId === this.o.selfId) return;
    if (this.streams.has(userId) || this.resolving.has(userId)) {
      // Already capturing (pause shorter than the silence window): just report the edge.
      if (this.streams.has(userId) && !this.speaking.has(userId)) this.reportSpeaking(userId);
      return;
    }
    this.resolving.add(userId);
    let info: SpeakerInfo | null;
    try {
      info = await this.o.resolveSpeaker(userId);
    } catch (err) {
      this.log.debug(`resolve speaker ${userId} failed:`, err);
      info = null;
    } finally {
      this.resolving.delete(userId);
    }
    if (!this.started) return;
    if (info?.isBot) return;
    this.reportSpeaking(userId);
    if (!this.streams.has(userId)) this.openStream(userId, info?.displayName ?? userId);
  }

  private reportSpeaking(userId: string): void {
    this.speaking.add(userId);
    this.o.link.send({ type: "speaking", guild: this.o.guildId, user_id: userId, speaking: true });
  }

  private openStream(userId: string, displayName: string): void {
    const stream: ActiveStream = {
      userId,
      displayName,
      pipeline: new CapturePipeline(this.createDecoder()),
      id: undefined,
      closed: false,
      opus: undefined,
    };
    this.streams.set(userId, stream);

    const opus = this.o.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.o.silenceMs },
    });
    stream.opus = opus;
    opus.on("data", (packet: Buffer) => {
      if (stream.closed) return;
      this.sendFrames(stream, stream.pipeline.push(packet));
    });
    const done = (): void => this.closeStream(stream);
    opus.once("end", done);
    opus.once("close", done);
    opus.once("error", (err: Error) => {
      this.log.warn(`opus stream error for ${userId}:`, err.message);
      done();
    });
  }

  private sendFrames(stream: ActiveStream, frames: Buffer[]): void {
    if (frames.length === 0) return;
    if (stream.id === undefined) {
      const id = this.o.ids.take();
      const ok = this.o.link.send({
        type: "stream_open",
        stream: id,
        guild: this.o.guildId,
        channel: this.o.getChannelId(),
        user_id: stream.userId,
        display_name: stream.displayName,
        sample_rate: CAPTURE_SAMPLE_RATE,
      });
      if (!ok) return; // Core not connected: drop, try again on the next frame
      stream.id = id;
    }
    for (const f of frames) {
      if (!this.o.link.sendAudio(encodeCaptureFrame(stream.id, f))) this.noteDrop();
    }
  }

  private noteDrop(): void {
    this.dropped++;
    const now = Date.now();
    if (now - this.lastDropLog > 5000) {
      this.lastDropLog = now;
      this.log.warn(`dropping capture audio: Core link is slow or down (${this.dropped} frames dropped so far)`);
    }
  }

  private closeStream(stream: ActiveStream, destroyOpus = false): void {
    if (stream.closed) return;
    stream.closed = true;
    if (this.streams.get(stream.userId) === stream) this.streams.delete(stream.userId);
    // Only flush the tail if the stream was announced; a sub-frame blip is not worth opening for.
    const tail = stream.pipeline.finish();
    if (stream.id !== undefined) {
      this.sendFrames(stream, tail);
      this.o.link.send({ type: "stream_close", stream: stream.id });
    }
    if (stream.pipeline.decodeErrors > 0) {
      this.log.debug(`stream for ${stream.userId}: ${stream.pipeline.decodeErrors} undecodable packets`);
    }
    stream.pipeline.dispose();
    // The receiver's subscription ends itself after the silence window; only force it when stopping early.
    if (destroyOpus) stream.opus?.destroy();
  }
}
