// Buffered, pull-based audio source for one playback.
//
// Core pushes mono s16le at `sampleRate`; the Discord side pulls 20 ms frames of 48 kHz
// stereo. Resampling happens lazily at pull time, so the WebSocket handler only does an
// O(chunk) copy and the buffer stays at the (smaller) source size.
import { SampleFifo } from "../audio/fifo.js";
import { bytesToInt16, Resampler } from "../audio/resampler.js";

export const OUT_RATE = 48_000;
export const FRAME_MS = 20;
/** Samples per channel in one 20 ms frame at 48 kHz. */
export const FRAME_SAMPLES = 960;
/** Bytes in one frame of interleaved s16le stereo. */
export const FRAME_BYTES = FRAME_SAMPLES * 2 * 2;

export type SourceEndReason = "drained" | "faded" | "stopped" | "starved" | "overflow";

export type WriteResult = "ok" | "ignored" | "overflow";

export type FrameResult =
  | { kind: "audio"; pcm: Buffer } // FRAME_BYTES of s16le stereo @ 48 kHz
  | { kind: "silence" } // underrun: the player should emit a silence frame
  | { kind: "end"; reason: SourceEndReason };

export interface SourceOptions {
  /** Sample rate of the mono PCM being written. */
  sampleRate: number;
  /** Cap on buffered audio, in bytes of source PCM. Exceeding it ends the source with `overflow`. */
  maxBufferBytes: number;
  /** Audio (ms) that must be buffered before {@link PlaybackSource.canStart} is true. */
  prebufferMs: number;
  /** Consecutive underrun time (ms) after which the source gives up with `starved`. */
  maxStarveMs: number;
}

export class PlaybackSource {
  private readonly opts: SourceOptions;
  private readonly resampler: Resampler;
  private readonly pending: Int16Array[] = [];
  private pendingSamples = 0;
  private readonly fifo = new SampleFifo(); // mono @ 48 kHz, resampled but not yet framed
  private oddByte: number | undefined;

  private inputEnded = false;
  private flushed = false;
  private starvedFrames = 0;
  private fadeTotal = 0;
  private fadeIdx = 0;
  private pendingEnd: SourceEndReason | undefined;
  private finished: SourceEndReason | undefined;

  constructor(opts: SourceOptions) {
    this.opts = opts;
    this.resampler = new Resampler(opts.sampleRate, OUT_RATE);
  }

  /** Why the source ended, once {@link readFrame} has returned `end`. */
  get endReason(): SourceEndReason | undefined {
    return this.finished;
  }

  get inputDone(): boolean {
    return this.inputEnded;
  }

  /** Buffered, not yet played audio in milliseconds. */
  get bufferedMs(): number {
    return (this.pendingSamples / this.opts.sampleRate + this.fifo.length / OUT_RATE) * 1000;
  }

  /** Approximate memory held, in bytes of source-rate PCM. */
  private get bufferedBytes(): number {
    return this.pendingSamples * 2 + Math.ceil((this.fifo.length * this.opts.sampleRate) / OUT_RATE) * 2;
  }

  canStart(): boolean {
    return this.inputEnded || this.pendingEnd !== undefined || this.bufferedMs >= this.opts.prebufferMs;
  }

  /**
   * Appends mono s16le PCM at the source rate.
   *  - `ok`: buffered.
   *  - `ignored`: the source already ended / is stopping, the data is dropped.
   *  - `overflow`: the buffer limit was exceeded; buffered audio is discarded and the source
   *    will end with `overflow`.
   */
  write(bytes: Uint8Array): WriteResult {
    if (this.inputEnded || this.pendingEnd !== undefined || this.finished) return "ignored";
    let data = bytes;
    if (this.oddByte !== undefined) {
      const joined = new Uint8Array(bytes.byteLength + 1);
      joined[0] = this.oddByte;
      joined.set(bytes, 1);
      data = joined;
      this.oddByte = undefined;
    }
    if (data.byteLength & 1) {
      this.oddByte = data[data.byteLength - 1];
      data = data.subarray(0, data.byteLength - 1);
    }
    if (data.byteLength === 0) return "ok";
    if (this.bufferedBytes + data.byteLength > this.opts.maxBufferBytes) {
      this.pending.length = 0;
      this.pendingSamples = 0;
      this.fifo.clear();
      this.pendingEnd = "overflow";
      return "overflow";
    }
    const samples = bytesToInt16(data);
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    return "ok";
  }

  /** No more input: play what is buffered, then end with `drained`. */
  end(): void {
    this.inputEnded = true;
  }

  /** Ramp the volume to zero over `ms`, then end with `faded`. `ms <= 0` aborts immediately. */
  fadeOut(ms: number): void {
    if (this.finished || this.pendingEnd !== undefined) return;
    if (ms <= 0) {
      this.abort();
      return;
    }
    if (this.fadeTotal > 0) return; // already fading
    this.fadeTotal = Math.max(1, Math.round(ms / FRAME_MS));
    this.fadeIdx = 0;
  }

  /** Stop right away (next pull returns `end: stopped`). */
  abort(): void {
    if (this.finished) return;
    this.pending.length = 0;
    this.pendingSamples = 0;
    this.fifo.clear();
    this.pendingEnd = "stopped";
  }

  /** Pulls one 20 ms frame. Never throws; never blocks. */
  readFrame(): FrameResult {
    if (this.finished) return { kind: "end", reason: this.finished };
    if (this.pendingEnd !== undefined) return this.finish(this.pendingEnd);

    this.fill(FRAME_SAMPLES);

    let mono: Int16Array | undefined;
    if (this.fifo.length >= FRAME_SAMPLES) {
      mono = this.fifo.take(FRAME_SAMPLES);
    } else if (this.inputEnded && this.pending.length === 0) {
      if (!this.flushed) {
        this.flushed = true;
        this.fifo.push(this.resampler.flush());
      }
      if (this.fifo.length > 0) {
        const rest = this.fifo.take(this.fifo.length);
        mono = new Int16Array(FRAME_SAMPLES); // zero padded last frame
        mono.set(rest);
      } else {
        return this.finish("drained");
      }
    }

    if (!mono) {
      if (this.fadeTotal > 0) return this.finish("faded"); // nothing left to fade
      this.starvedFrames++;
      if (this.starvedFrames * FRAME_MS > this.opts.maxStarveMs) return this.finish("starved");
      return { kind: "silence" };
    }
    this.starvedFrames = 0;

    let g0 = 1;
    let g1 = 1;
    if (this.fadeTotal > 0) {
      g0 = 1 - this.fadeIdx / this.fadeTotal;
      this.fadeIdx++;
      g1 = 1 - this.fadeIdx / this.fadeTotal;
      if (this.fadeIdx >= this.fadeTotal) this.pendingEnd = "faded";
    }

    const out = Buffer.allocUnsafe(FRAME_BYTES);
    const step = (g1 - g0) / FRAME_SAMPLES;
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const g = g0 + step * i;
      let s = Math.round((mono[i] as number) * g);
      s = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
      out.writeInt16LE(s, i * 4);
      out.writeInt16LE(s, i * 4 + 2);
    }
    return { kind: "audio", pcm: out };
  }

  private finish(reason: SourceEndReason): FrameResult {
    this.finished = reason;
    this.pending.length = 0;
    this.pendingSamples = 0;
    this.fifo.clear();
    return { kind: "end", reason };
  }

  /** Resample pending input until the FIFO holds at least `need` samples (or input runs out). */
  private fill(need: number): void {
    const ratio = this.opts.sampleRate / OUT_RATE;
    while (this.fifo.length < need && this.pending.length > 0) {
      const wantIn = Math.max(16, Math.ceil((need - this.fifo.length) * ratio) + 4);
      const head = this.pending[0] as Int16Array;
      let chunk: Int16Array;
      if (head.length <= wantIn) {
        chunk = head;
        this.pending.shift();
      } else {
        chunk = head.subarray(0, wantIn);
        this.pending[0] = head.subarray(wantIn);
      }
      this.pendingSamples -= chunk.length;
      this.fifo.push(this.resampler.process(chunk));
    }
  }
}
