// PCM helpers: s16le byte conversions, mono <-> stereo, and a streaming windowed-sinc
// (Lanczos) resampler for arbitrary integer sample-rate pairs.
//
// All PCM here is signed 16-bit. We assume a little-endian host (x86 / ARM), which is
// what Buffer<->Int16Array reinterpretation relies on.

/** Copies the bytes of an s16le buffer into a (properly aligned) Int16Array. A trailing odd byte is dropped. */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const n = bytes.byteLength >> 1;
  const out = new Int16Array(n);
  new Uint8Array(out.buffer).set(bytes.subarray(0, n * 2));
  return out;
}

/** Views an Int16Array as a Buffer (no copy). */
export function int16ToBuffer(samples: Int16Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

/** Interleaved stereo -> mono (average of L and R). A dangling half-frame is dropped. */
export function stereoToMono(stereo: Int16Array): Int16Array {
  const frames = stereo.length >> 1;
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    mono[i] = ((stereo[2 * i] as number) + (stereo[2 * i + 1] as number)) >> 1;
  }
  return mono;
}

/** Mono -> interleaved stereo (L = R). */
export function monoToStereo(mono: Int16Array): Int16Array {
  const stereo = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    const s = mono[i] as number;
    stereo[2 * i] = s;
    stereo[2 * i + 1] = s;
  }
  return stereo;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

const LOBES = 8; // Lanczos "a": kernel half-width in output-rate-limited sample periods

/**
 * Streaming mono resampler (s16 in, s16 out).
 *
 * Output sample n sits at input position n * inRate / outRate. Each output is a windowed-sinc
 * weighted sum of the surrounding input samples; when downsampling the sinc is widened to
 * band-limit below the new Nyquist. The input->output ratio is rational (p/q), so the kernel
 * only depends on `n mod q` and is cached per phase.
 *
 * Output lags the input by `latency` input samples until {@link flush} is called; the total
 * output length after flush is exactly ceil(totalIn * outRate / inRate).
 */
export class Resampler {
  readonly inRate: number;
  readonly outRate: number;
  /** Input samples of look-ahead the kernel needs (half the tap count). */
  readonly latency: number;

  private readonly p: number; // inRate / gcd
  private readonly q: number; // outRate / gcd
  private readonly cutoff: number;
  private readonly weights: (Float32Array | undefined)[];
  private readonly passthrough: boolean;

  private carry: Float32Array;
  private pos: number; // next output position, in 1/q input samples, relative to `carry`
  private inTotal = 0;
  private outTotal = 0;

  constructor(inRate: number, outRate: number) {
    if (!Number.isInteger(inRate) || !Number.isInteger(outRate) || inRate <= 0 || outRate <= 0) {
      throw new RangeError(`sample rates must be positive integers (got ${inRate} -> ${outRate})`);
    }
    this.inRate = inRate;
    this.outRate = outRate;
    this.passthrough = inRate === outRate;
    const g = gcd(inRate, outRate);
    this.p = inRate / g;
    this.q = outRate / g;
    this.cutoff = Math.min(1, outRate / inRate);
    this.latency = Math.ceil(LOBES / this.cutoff);
    this.weights = new Array<Float32Array | undefined>(this.q).fill(undefined);
    this.carry = new Float32Array(this.latency); // zero history before the first sample
    this.pos = this.latency * this.q;
  }

  private kernel(phase: number): Float32Array {
    const cached = this.weights[phase];
    if (cached) return cached;
    const taps = 2 * this.latency;
    const w = new Float32Array(taps);
    const frac = phase / this.q;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const d = frac + this.latency - 1 - j; // distance from the output position to tap j
      const u = d * this.cutoff;
      const v = Math.abs(u) >= LOBES ? 0 : this.cutoff * sinc(u) * sinc(u / LOBES);
      w[j] = v;
      sum += v;
    }
    if (sum !== 0) for (let j = 0; j < taps; j++) w[j] = (w[j] as number) / sum; // unity DC gain
    this.weights[phase] = w;
    return w;
  }

  /** Resamples a chunk. Safe to call with any chunk size (including 0). */
  process(input: Int16Array): Int16Array {
    if (this.passthrough) {
      this.inTotal += input.length;
      this.outTotal += input.length;
      return input.slice();
    }
    this.inTotal += input.length;
    return this.run(input, Number.POSITIVE_INFINITY);
  }

  /** Emits the tail that is still held back by the kernel. Call once, at end of stream. */
  flush(): Int16Array {
    if (this.passthrough) return new Int16Array(0);
    const limit = Math.ceil((this.inTotal * this.q) / this.p);
    const out = this.run(new Int16Array(this.latency), limit);
    // After a flush the stream is over; reset so the instance could be reused.
    this.carry = new Float32Array(this.latency);
    this.pos = this.latency * this.q;
    this.inTotal = 0;
    this.outTotal = 0;
    return out;
  }

  private run(input: Int16Array, outLimit: number): Int16Array {
    const keep = this.carry.length;
    const total = keep + input.length;
    const b = new Float32Array(total);
    b.set(this.carry);
    for (let i = 0; i < input.length; i++) b[keep + i] = input[i] as number;

    const { p, q, latency: hw } = this;
    const out = new Int16Array(Math.max(0, Math.ceil((total * q) / p) + 2));
    let n = 0;
    let pos = this.pos;
    while (this.outTotal < outLimit) {
      const i = Math.floor(pos / q);
      if (i + hw > total - 1) break;
      const w = this.kernel(pos - i * q);
      const base = i - hw + 1;
      let sum = 0;
      for (let j = 0; j < w.length; j++) sum += (b[base + j] as number) * (w[j] as number);
      out[n++] = sum >= 32767 ? 32767 : sum <= -32768 ? -32768 : Math.round(sum);
      pos += p;
      this.outTotal++;
    }
    const keepFrom = Math.min(total, Math.max(0, Math.floor(pos / q) - hw + 1));
    this.carry = b.slice(keepFrom, total);
    this.pos = pos - keepFrom * q;
    return out.subarray(0, n);
  }
}

/** One-shot resample of a whole mono buffer (flushes the tail). */
export function resampleMono(input: Int16Array, inRate: number, outRate: number): Int16Array {
  const r = new Resampler(inRate, outRate);
  const head = r.process(input);
  const tail = r.flush();
  const out = new Int16Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}
