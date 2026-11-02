// Her voice as a column of bars on the left edge. The bars never move: each one only grows,
// shrinks and brightens with her voice. They are mirrored around the middle; the middle bars follow
// the low bands of the Stage's lip-sync levels and the outer ones the high bands, so the column
// takes the shape of what she is saying. Each bar has its own smoothing, so they do not move in
// lockstep. Tinted with the emotion colour, semi-transparent, and the whole column fades in when
// she starts and out when she stops.

/** Bars in the column (even: mirrored halves). */
export const BAR_COUNT = 26;
/** A level older than this counts as silence (the feed stops while nothing plays). */
const STALE_MS = 220;
/** dBFS mapped to 0 and 1. */
const FLOOR_DB = -52;
const CEIL_DB = -12;
/** Time constants (ms) towards a louder / quieter value. */
const ATTACK_MS = 45;
const RELEASE_MS = 240;
/** Below this every bar counts as quiet. */
const SILENT = 0.015;

/** Display value 0..1 of a level: a dB scale with a little expansion, so quiet speech stays small. */
export function levelValue(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  const v = Math.min(Math.max((db - FLOOR_DB) / (CEIL_DB - FLOOR_DB), 0), 1);
  return v ** 1.35;
}

/** Distance of bar `i` from the middle, 0 (centre) .. 1 (top / bottom end). */
export function barDistance(i: number, count = BAR_COUNT): number {
  const half = count / 2;
  const k = i < half ? half - 1 - i : i - half;
  return half <= 1 ? 0 : k / (half - 1);
}

/**
 * Bar values from a level: the band shape (each band against its own recent peak, so the shape
 * shows which bands are active rather than the voice's fixed tilt) spread over the bars by
 * distance from the middle, scaled by the overall level and by a gentle taper towards the ends.
 */
export function barTargets(
  value: number,
  bands: readonly number[] | null,
  out: Float32Array,
  peaks?: Float32Array,
  seed = 0,
): void {
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const d = barDistance(i, n);
    const taper = 0.45 + 0.55 * (1 - d * d);
    let shape: number;
    if (bands && bands.length > 0 && peaks) {
      const pos = d * (bands.length - 1);
      const a = Math.floor(pos);
      const b = Math.min(a + 1, bands.length - 1);
      const f = pos - a;
      const ra = (bands[a] ?? 0) / Math.max(peaks[a] ?? 0, 1e-6);
      const rb = (bands[b] ?? 0) / Math.max(peaks[b] ?? 0, 1e-6);
      shape = Math.min(1, Math.sqrt(ra * (1 - f) + rb * f));
    } else {
      // No band data: a slow, uneven ripple so the bars still differ from each other.
      shape = 0.7 + 0.3 * Math.sin(seed * 0.006 + i * 1.7) * Math.sin(seed * 0.0023 + i * 0.6);
    }
    out[i] = value * taper * (0.35 + 0.65 * shape);
  }
}

/** Smoothed bar values from the feed. Pure: the view feeds it time and levels. */
export class BarField {
  readonly values: Float32Array;
  readonly #targets: Float32Array;
  readonly #peaks = new Float32Array(16);
  readonly #speed: Float32Array;
  #value = 0;
  #bands: number[] | null = null;
  #at = Number.NEGATIVE_INFINITY;

  constructor(readonly count = BAR_COUNT) {
    this.values = new Float32Array(count);
    this.#targets = new Float32Array(count);
    // Each bar reacts a little faster or slower than the next (fixed, so it never flickers).
    this.#speed = Float32Array.from({ length: count }, (_, i) => 0.8 + 0.4 * ((i * 7919) % 13) / 12);
  }

  /** A level from the feed at time `now` (ms). */
  push(rms: number, bands: readonly number[] | null, now: number): void {
    this.#value = levelValue(rms);
    this.#bands = bands && bands.length <= this.#peaks.length ? [...bands] : null;
    this.#at = now;
  }

  /** Moves the bars `dtMs` towards the latest level (silence once it is stale). */
  advance(dtMs: number, now: number): void {
    const dt = Math.min(Math.max(dtMs, 0), 100);
    const fresh = now - this.#at <= STALE_MS;
    const bands = fresh ? this.#bands : null;
    if (bands) {
      // Each band's recent peak decays slowly, so the shape adapts to her voice and to songs.
      for (let k = 0; k < bands.length; k++) {
        const b = bands[k] ?? 0;
        const p = this.#peaks[k] ?? 0;
        this.#peaks[k] = b > p ? b : p * Math.exp(-dt / 2500);
      }
    }
    barTargets(fresh ? this.#value : 0, bands, this.#targets, this.#peaks, now);
    for (let i = 0; i < this.count; i++) {
      const v = this.values[i] ?? 0;
      const t = this.#targets[i] ?? 0;
      const tau = (t > v ? ATTACK_MS : RELEASE_MS) * (this.#speed[i] ?? 1);
      const next = v + (t - v) * (1 - Math.exp(-dt / tau));
      this.values[i] = next < 1e-4 ? 0 : next;
    }
  }

  /** Every bar is (nearly) still. */
  silent(): boolean {
    for (const v of this.values) if (v > SILENT) return false;
    return true;
  }
}

/** Draws a `BarField` into its own canvas. */
export class Wave {
  readonly element: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D | null;
  readonly #bars = new BarField();
  #accent = "oklch(0.72 0.012 275)";
  #idle = true;
  /** The canvas holds no bars. */
  #cleared = true;
  #width = 0;
  #height = 0;
  #dpr = 1;

  constructor(parent: Element) {
    this.element = document.createElement("canvas");
    this.element.className = "wave is-idle";
    this.element.setAttribute("aria-hidden", "true");
    parent.append(this.element);
    this.#ctx = this.element.getContext("2d");
  }

  set hidden(v: boolean) {
    this.element.hidden = v;
  }

  /** Bar colour (the emotion colour). */
  accent(color: string): void {
    this.#accent = color;
  }

  level(rms: number, bands: readonly number[] | null, now: number): void {
    this.#bars.push(rms, bands, now);
  }

  frame(dtMs: number, now: number): void {
    this.#bars.advance(dtMs, now);
    const idle = this.#bars.silent();
    if (idle !== this.#idle) {
      this.#idle = idle;
      this.element.classList.toggle("is-idle", idle);
    }
    // Nothing to draw once the bars are gone and the canvas is clear.
    if (idle && this.#cleared) return;
    this.#draw();
  }

  #fit(): boolean {
    const ctx = this.#ctx;
    if (!ctx) return false;
    const dpr = window.devicePixelRatio || 1;
    const w = this.element.clientWidth;
    const h = this.element.clientHeight;
    if (w === 0 || h === 0) return false;
    if (w !== this.#width || h !== this.#height || dpr !== this.#dpr) {
      this.#width = w;
      this.#height = h;
      this.#dpr = dpr;
      this.element.width = Math.round(w * dpr);
      this.element.height = Math.round(h * dpr);
    }
    return true;
  }

  #draw(): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#fit()) return;
    const dpr = this.#dpr;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.#width, this.#height);

    const values = this.#bars.values;
    const n = values.length;
    const pitch = 1.05 * rem;
    const thick = 0.46 * rem;
    const r = thick / 2;
    const rest = 0.5 * rem; // what still shows of a bar at rest, so the column keeps its outline
    const reach = 7.5 * rem;
    const top = this.#height / 2 - (pitch * (n - 1)) / 2;
    let drawn = false;

    ctx.fillStyle = this.#accent;
    for (let i = 0; i < n; i++) {
      const v = values[i] ?? 0;
      if (v <= 1e-3) continue;
      drawn = true;
      const y = top + i * pitch - r;
      const len = rest + v * reach;
      ctx.globalAlpha = Math.min(0.72, 0.16 + 0.62 * v);
      // Flush with the frame edge; only the end that reaches into the picture is round.
      ctx.beginPath();
      ctx.roundRect(-r, y, len + r, thick, r);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.#cleared = !drawn;
  }
}
