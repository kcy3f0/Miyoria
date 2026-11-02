// Windowed RMS of the PCM that is being sent to Discord (lip-sync levels for the Stage).
//
// The framer is purely arithmetic: feed it interleaved s16le and it returns one point per full
// window (default 10 ms). `t` is the START of the window in ms since the framer was (re)set, so it
// follows the audio's own timeline - underruns that are padded with silence still advance it.
//
// With `bands`, every point also carries the RMS of the mono signal in a few band-pass bands
// (formant regions) after pre-emphasis, measured over the last `bandWindows` windows (default
// 2 = 20 ms at a 10 ms hop). The Stage turns their shape into vowel weights (A / I / U / E / O); the absolute level of
// the bands does not matter, only how they compare.

export interface LevelPoint {
  /** ms since playback start (start of the window). */
  t: number;
  /** 0..1, RMS of the window relative to full scale. */
  rms: number;
  /** RMS per band (relative to full scale, no gain), lowest band first. Only with `bands`. */
  bands?: number[];
}

/** Band centres (Hz): F1 of /i u/, F1 of /e o/, F1 of /a/ and F2 of /o/, F2 of /a u/, F2 of /e/, F2 of /i/. */
export const DEFAULT_BAND_CENTERS: readonly number[] = [300, 550, 850, 1300, 2000, 3000];
/** Quality factor of the band-pass filters (bandwidth ≈ centre / Q). */
export const DEFAULT_BAND_Q = 1.5;

export interface RmsFramerOptions {
  sampleRate: number;
  /** Interleaved channels in the input (they are averaged before the RMS). */
  channels: number;
  /** Window length. Default 10 ms. */
  windowMs?: number;
  /** Multiplier applied to the RMS (result is clamped to 1). Default 1. */
  gain?: number;
  /** Also measure band energies: `true` for `DEFAULT_BAND_CENTERS`, or the centres in Hz. */
  bands?: boolean | readonly number[];
  /** Band analysis length in windows (default 2). */
  bandWindows?: number;
}

/** RBJ band-pass biquad (constant 0 dB peak gain), transposed direct form II. */
class Biquad {
  private readonly b0: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private z1 = 0;
  private z2 = 0;

  constructor(center: number, q: number, sampleRate: number) {
    const w0 = (2 * Math.PI * Math.min(center, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  step(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = -this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

/**
 * Two cascaded band-pass biquads: 12 dB / octave skirts, so the strong first formant does not
 * leak into the upper bands.
 */
class BandPass {
  private readonly a: Biquad;
  private readonly b: Biquad;

  constructor(center: number, q: number, sampleRate: number) {
    this.a = new Biquad(center, q, sampleRate);
    this.b = new Biquad(center, q, sampleRate);
  }

  step(x: number): number {
    return this.b.step(this.a.step(x));
  }

  reset(): void {
    this.a.reset();
    this.b.reset();
  }
}

/** Pre-emphasis coefficient (+6 dB / octave above ~250 Hz): flattens the voice's spectral tilt. */
const PRE_EMPHASIS = 0.97;

export class RmsFramer {
  readonly windowSamples: number;
  readonly windowMs: number;
  private readonly channels: number;
  private readonly gain: number;
  private readonly filters: BandPass[];
  private readonly bandWindows: number;
  /** Squared band sums of the current window. */
  private readonly bandSq: Float64Array;
  /** Squared band sums of the last completed windows, newest last. */
  private bandHistory: Float64Array[] = [];
  private prev = 0; // last mono sample (pre-emphasis)
  private sumSq = 0;
  private count = 0; // samples (per channel) in the current window
  private windows = 0; // completed windows

  constructor(opts: RmsFramerOptions) {
    this.windowMs = opts.windowMs ?? 10;
    this.channels = opts.channels;
    this.gain = opts.gain ?? 1;
    this.windowSamples = Math.max(1, Math.round((opts.sampleRate * this.windowMs) / 1000));
    const centers = opts.bands === true ? DEFAULT_BAND_CENTERS : opts.bands === false || opts.bands === undefined ? [] : opts.bands;
    this.filters = centers.map((c) => new BandPass(c, DEFAULT_BAND_Q, opts.sampleRate));
    this.bandSq = new Float64Array(this.filters.length);
    this.bandWindows = Math.max(1, Math.floor(opts.bandWindows ?? 2));
  }

  /** Time of the next window boundary the framer has not completed yet, in ms. */
  get positionMs(): number {
    return this.windows * this.windowMs;
  }

  reset(): void {
    this.sumSq = 0;
    this.count = 0;
    this.windows = 0;
    this.bandSq.fill(0);
    this.bandHistory = [];
    this.prev = 0;
    for (const f of this.filters) f.reset();
  }

  /** Feeds interleaved s16le bytes; returns the windows completed by them. A trailing partial sample frame is ignored. */
  pushPcm(pcm: Uint8Array): LevelPoint[] {
    const out: LevelPoint[] = [];
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const stride = this.channels * 2;
    const frames = Math.floor(pcm.byteLength / stride);
    const inv = 1 / this.channels;
    const filters = this.filters;
    const bands = filters.length;
    const bandSq = this.bandSq;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      const base = i * stride;
      for (let c = 0; c < this.channels; c++) sum += view.getInt16(base + c * 2, true);
      const m = sum * inv;
      this.sumSq += m * m;
      const x = m - PRE_EMPHASIS * this.prev;
      this.prev = m;
      for (let b = 0; b < bands; b++) {
        const y = (filters[b] as BandPass).step(x);
        bandSq[b] = (bandSq[b] as number) + y * y;
      }
      if (++this.count === this.windowSamples) out.push(this.complete());
    }
    return out;
  }

  /** Feeds `frames` samples of digital silence (per channel). */
  pushSilence(frames: number): LevelPoint[] {
    const out: LevelPoint[] = [];
    let left = Math.max(0, Math.floor(frames));
    // The filters ring out within a few ms; starting them from rest is close enough.
    if (left > 0) {
      for (const f of this.filters) f.reset();
      this.prev = 0;
    }
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
    if (this.filters.length > 0) {
      this.bandHistory.push(Float64Array.from(this.bandSq));
      if (this.bandHistory.length > this.bandWindows) this.bandHistory.shift();
      const n = this.bandHistory.length * this.count;
      point.bands = this.filters.map((_, b) => {
        let s = 0;
        for (const w of this.bandHistory) s += w[b] as number;
        return Math.sqrt(s / n) / 32768;
      });
      this.bandSq.fill(0);
    }
    this.windows++;
    this.sumSq = 0;
    this.count = 0;
    return point;
  }
}
