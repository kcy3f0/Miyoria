// Minimal timestamped logger; ms precision matters for latency notes.
export function log(tag: string, ...args: unknown[]): void {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`${t} [${tag}]`, ...args);
}

/** High-resolution clock in ms, for latency measurements. */
export const now = (): number => performance.now();

/** Filesystem-safe local timestamp, e.g. 20261101-153012-345. */
export function fileStamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}
