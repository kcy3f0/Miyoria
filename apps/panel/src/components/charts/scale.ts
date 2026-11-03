// Scales, ticks and path building for the hand-drawn SVG charts.

export type Domain = readonly [number, number];

export function linear(domain: Domain, range: readonly [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Round step (1, 2, 2.5, 5 × 10ⁿ) for about `count` ticks. */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** Ticks covering `domain` at round values. */
export function ticks(domain: Domain, count = 4): number[] {
  const [d0, d1] = domain;
  if (d1 <= d0) return [d0];
  const step = niceStep(d1 - d0, count);
  const out: number[] = [];
  for (let v = Math.ceil(d0 / step) * step; v <= d1 + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

/** `[0, max]` extended to a round top, for counts and sums. */
export function niceMax(max: number, count = 4): Domain {
  if (!(max > 0)) return [0, 1];
  const step = niceStep(max, count);
  return [0, Math.ceil(max / step) * step];
}

/** Auto domain of the finite values, padded and rounded. */
export function extent(values: Iterable<number | null>, pad = 0.08): Domain {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (lo === hi) return [lo - 1, hi + 1];
  const p = (hi - lo) * pad;
  const step = niceStep(hi - lo, 4);
  return [Math.floor((lo - p) / step) * step, Math.ceil((hi + p) / step) * step];
}

/** SVG path through the points, broken at `null`s. */
export function linePath(xs: readonly number[], ys: readonly (number | null)[]): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (y === null || y === undefined || !Number.isFinite(y)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${(xs[i] as number).toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** Closed area paths down to `base`, one per unbroken run. */
export function areaPath(xs: readonly number[], ys: readonly (number | null)[], base: number): string {
  let d = "";
  let run: [number, number][] = [];
  const flush = () => {
    if (run.length > 1) {
      const first = run[0] as [number, number];
      const last = run[run.length - 1] as [number, number];
      d += `M${first[0].toFixed(1)},${base.toFixed(1)}`;
      for (const [x, y] of run) d += `L${x.toFixed(1)},${y.toFixed(1)}`;
      d += `L${last[0].toFixed(1)},${base.toFixed(1)}Z`;
    }
    run = [];
  };
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (y === null || y === undefined || !Number.isFinite(y)) flush();
    else run.push([xs[i] as number, y]);
  }
  flush();
  return d;
}

/** A column with a 4px rounded data end and a square base. */
export function columnPath(x: number, y: number, w: number, h: number, round: boolean): string {
  if (h <= 0) return "";
  const r = round ? Math.min(4, w / 2, h) : 0;
  return (
    `M${x},${y + h}` +
    `L${x},${y + r}` +
    (r ? `Q${x},${y} ${x + r},${y}` : "") +
    `L${x + w - r},${y}` +
    (r ? `Q${x + w},${y} ${x + w},${y + r}` : "") +
    `L${x + w},${y + h}Z`
  );
}

/** Index of the value in sorted `xs` nearest to `x`. */
export function nearest(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] as number) < x) lo = mid;
    else hi = mid;
  }
  return Math.abs((xs[lo] as number) - x) <= Math.abs((xs[hi] as number) - x) ? lo : hi;
}

/** At most `max` evenly spaced indexes of `n` (always keeps the last). */
export function sampleIndexes(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(Math.round((k * (n - 1)) / (max - 1)));
  return [...new Set(out)];
}
