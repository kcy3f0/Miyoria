// Seeded randomness for the avatar: a small PRNG and smooth 1-D noise.
//
// Everything procedural on the avatar (blinks, saccades, idle drift, gesture choice) draws from
// a `Random`, so tests can fix the seed and the live Stage gets a different performance on
// every start.

/** A seeded pseudo-random source (mulberry32). */
export class Random {
  #state: number;

  constructor(seed: number = Date.now() ^ (Math.random() * 0x1_0000_0000)) {
    this.#state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** `true` with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Exponentially distributed with the given mean (gaps of a Poisson process). */
  exponential(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  /** Roughly normal (sum of four uniforms), mean 0, standard deviation `sd`. */
  gaussian(sd = 1): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * sd * Math.sqrt(3);
  }

  /** -1 or 1. */
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T {
    return items[Math.min(Math.floor(this.next() * items.length), items.length - 1)] as T;
  }

  /** A seed for a child source. */
  fork(): Random {
    return new Random(Math.floor(this.next() * 0x1_0000_0000));
  }
}

/**
 * Smooth noise in about -1..1: random values at knots `period` ms apart (jittered), joined with
 * smoothstep. Two octaves keep it from looking like a slow sine.
 */
export class SmoothNoise {
  readonly #random: Random;
  readonly #period: number;
  #knots: [number, number, number] = [0, 0, 0];
  #pos = 0;
  #len: number;

  constructor(random: Random, periodMs: number) {
    this.#random = random;
    this.#period = Math.max(periodMs, 1);
    this.#knots = [random.range(-1, 1), random.range(-1, 1), random.range(-1, 1)];
    this.#len = this.#nextLen();
  }

  #nextLen(): number {
    return this.#period * this.#random.range(0.6, 1.4);
  }

  /** Advances by `dtMs` and returns the value. */
  update(dtMs: number): number {
    this.#pos += Math.max(dtMs, 0);
    while (this.#pos >= this.#len) {
      this.#pos -= this.#len;
      this.#len = this.#nextLen();
      this.#knots = [this.#knots[1], this.#knots[2], this.#random.range(-1, 1)];
    }
    const u = this.#pos / this.#len;
    const s = u * u * (3 - 2 * u);
    const [a, b] = this.#knots;
    return a + (b - a) * s;
  }
}

/** Two octaves of `SmoothNoise`. */
export class Drift {
  readonly #slow: SmoothNoise;
  readonly #fast: SmoothNoise;

  constructor(random: Random, periodMs: number) {
    this.#slow = new SmoothNoise(random, periodMs);
    this.#fast = new SmoothNoise(random, periodMs / 2.7);
  }

  update(dtMs: number): number {
    return 0.75 * this.#slow.update(dtMs) + 0.25 * this.#fast.update(dtMs);
  }
}

/** One-pole low-pass towards a target. */
export function approach(value: number, target: number, dtMs: number, tauMs: number): number {
  const a = 1 - Math.exp(-Math.max(dtMs, 0) / Math.max(tauMs, 1e-3));
  return value + (target - value) * a;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** 0..1 smoothstep of `x` in 0..1. */
export function smoothstep(x: number): number {
  const u = clamp(x, 0, 1);
  return u * u * (3 - 2 * u);
}
