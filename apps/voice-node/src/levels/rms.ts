// Windowed RMS of the PCM that is being sent to Discord (lip-sync levels for the Stage).
//
// The framer is purely arithmetic: feed it interleaved s16le and it returns one point per full
// window (default 10 ms). `t` is the START of the window in ms since the framer was (re)set, so it
// follows the audio's own timeline - underruns that are padded with silence still advance it.

export interface LevelPoint {
  /** ms since playback start (start of the window). */
  t: number;
  /** 0..1, RMS of the window relative to full scale. */
  rms: number;
}

export interface RmsFramerOptions {
  sampleRate: number;
  /** Interleaved channels in the input (they are averaged before the RMS). */
  channels: number;
  /** Window length. Default 10 ms. */
  windowMs?: number;
  /** Multiplier applied to the RMS (result is clamped to 1). Default 1. */
  gain?: number;
}

export class RmsFramer {
  readonly windowSamples: number;
  readonly windowMs: number;
  private readonly channels: number;
  private readonly gain: number;
  private sumSq = 0;
  private count = 0; // samples (per channel) in the current window
  private windows = 0; // completed windows

  constructor(opts: RmsFramerOptions) {
    this.windowMs = opts.windowMs ?? 10;
    this.channels = opts.channels;
    this.gain = opts.gain ?? 1;
    this.windowSamples = Math.max(1, Math.round((opts.sampleRate * this.windowMs) / 1000));
  }

  /** Time of the next window boundary the framer has not completed yet, in ms. */
  get positionMs(): number {
    return this.windows * this.windowMs;
  }

  reset(): void {
    this.sumSq = 0;
    this.count = 0;
    this.windows = 0;
  }

  /** Feeds interleaved s16le bytes; returns the windows completed by them. A trailing partial sample frame is ignored. */
  pushPcm(pcm: Uint8Array): LevelPoint[] {
    const out: LevelPoint[] = [];
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const stride = this.channels * 2;
    const frames = Math.floor(pcm.byteLength / stride);
    const inv = 1 / this.channels;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      const base = i * stride;
      for (let c = 0; c < this.channels; c++) sum += view.getInt16(base + c * 2, true);
      const m = sum * inv;
      this.sumSq += m * m;
      if (++this.count === this.windowSamples) out.push(this.complete());
    }
    return out;
  }

  /** Feeds `frames` samples of digital silence (per channel). */
  pushSilence(frames: number): LevelPoint[] {
    const out: LevelPoint[] = [];
    let left = Math.max(0, Math.floor(frames));
    while (left > 0) {
      const take = Math.min(left, this.windowSamples - this.count);
      this.count += take;
      left -= take;
      if (this.count === this.windowSamples) out.push(this.complete());
    }
    return out;
  }

  private complete(): LevelPoint {
    const rms = Math.sqrt(this.sumSq / this.count) / 32768;
    const point: LevelPoint = {
      t: this.windows * this.windowMs,
      rms: Math.min(1, rms * this.gain),
    };
    this.windows++;
    this.sumSq = 0;
    this.count = 0;
    return point;
  }
}
