// Her voice as a waveform along the left edge: the level history as horizontal strokes, the newest
// at the vertical centre and older ones drifting outward (up and down) while they fade. It follows
// the Stage's `levels` feed, which is delayed like her lip sync, so it moves with what viewers hear.
// Tinted with the emotion colour; it fades away entirely when she is quiet.

/** One history step (the strokes move this often). */
export const STEP_MS = 1000 / 60;
/** How far back the strokes reach, centre to either end. */
export const HISTORY_MS = 3200;
/** A level older than this counts as silence (the feed stops while nothing plays). */
const STALE_MS = 220;
/** dBFS mapped to 0 and 1. */
const FLOOR_DB = -52;
const CEIL_DB = -12;
/** Per-step smoothing towards a louder / quieter level. */
const ATTACK = 0.55;
const RELEASE = 0.14;
/** Below this the whole history counts as silent. */
const SILENT = 0.012;

/** Display value 0..1 of a level: a dB scale with a little expansion, so quiet speech stays small. */
export function levelValue(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  const v = Math.min(Math.max((db - FLOOR_DB) / (CEIL_DB - FLOOR_DB), 0), 1);
  return v ** 1.35;
}

/** Fixed-rate history of smoothed values, newest first. Pure: the view feeds it time and levels. */
export class WaveHistory {
  readonly values: Float32Array;
  #head = 0;
  #carry = 0;
  #current = 0;
  #target = 0;
  #targetAt = Number.NEGATIVE_INFINITY;

  constructor(readonly length = Math.round(HISTORY_MS / STEP_MS)) {
    this.values = new Float32Array(length);
  }

  /** A level from the feed at time `now` (ms). */
  push(rms: number, now: number): void {
    this.#target = levelValue(rms);
    this.#targetAt = now;
  }

  /** Advances the history to `now`, `dtMs` after the previous call. */
  advance(dtMs: number, now: number): void {
    this.#carry += Math.max(dtMs, 0);
    // A long gap (hidden tab) does not replay every step it missed.
    if (this.#carry > STEP_MS * this.length) this.#carry = STEP_MS * this.length;
    const target = now - this.#targetAt > STALE_MS ? 0 : this.#target;
    while (this.#carry >= STEP_MS) {
      this.#carry -= STEP_MS;
      const k = target > this.#current ? ATTACK : RELEASE;
      this.#current += (target - this.#current) * k;
      if (this.#current < 1e-4) this.#current = 0;
      this.#head = (this.#head + 1) % this.length;
      this.values[this.#head] = this.#current;
    }
  }

  /** Value `age` steps ago (0 = newest). */
  at(age: number): number {
    return this.values[(this.#head - age + this.length * 2) % this.length] ?? 0;
  }

  /** Nothing audible anywhere in the history. */
  silent(): boolean {
    for (const v of this.values) if (v > SILENT) return false;
    return true;
  }
}

/** Draws a `WaveHistory` into its own canvas. */
export class Wave {
  readonly element: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D | null;
  readonly #history = new WaveHistory();
  readonly #still: boolean;
  #accent = "oklch(0.72 0.012 275)";
  #idle = true;
  /** The canvas holds no strokes. */
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
    this.#still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }

  set hidden(v: boolean) {
    this.element.hidden = v;
  }

  /** Stroke colour (the emotion colour). */
  accent(color: string): void {
    this.#accent = color;
  }

  level(rms: number, now: number): void {
    this.#history.push(rms, now);
  }

  frame(dtMs: number, now: number): void {
    this.#history.advance(dtMs, now);
    const idle = this.#history.silent();
    if (idle !== this.#idle) {
      this.#idle = idle;
      this.element.classList.toggle("is-idle", idle);
    }
    // Nothing to draw once the strokes are gone and the canvas is clear.
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

    const h = this.#history;
    const x0 = 1.75 * rem;
    const reach = 6.25 * rem;
    const mid = this.#height / 2;
    const half = mid - 3 * rem;
    const n = this.#still ? 1 : h.length;
    const pitch = half / h.length;
    const thick = Math.max(1.25, pitch * 0.55);
    let drawn = false;

    ctx.fillStyle = this.#accent;
    for (let age = 0; age < n; age++) {
      const v = h.at(age);
      if (v <= SILENT) continue;
      drawn = true;
      const t = age / h.length;
      ctx.globalAlpha = 0.92 * (1 - t) ** 1.6;
      const len = Math.max(thick, v * reach);
      const dy = age * pitch;
      // Mirrored around the centre: newest in the middle, history moving out both ways.
      ctx.beginPath();
      ctx.roundRect(x0, mid - dy - thick / 2, len, thick, thick / 2);
      if (age > 0) ctx.roundRect(x0, mid + dy - thick / 2, len, thick, thick / 2);
      ctx.fill();
    }

    // The spine the strokes grow from: a hairline, strongest at the centre (now) and fading out
    // towards the ends like the history does.
    if (drawn) {
      const spine = ctx.createLinearGradient(0, mid - half, 0, mid + half);
      spine.addColorStop(0, "oklch(0.97 0.006 275 / 0)");
      spine.addColorStop(0.5, "oklch(0.97 0.006 275 / 0.22)");
      spine.addColorStop(1, "oklch(0.97 0.006 275 / 0)");
      ctx.globalAlpha = 1;
      ctx.fillStyle = spine;
      ctx.fillRect(x0 - 1, mid - half, 1, half * 2);
    }
    ctx.globalAlpha = 1;
    this.#cleared = !drawn;
  }
}
