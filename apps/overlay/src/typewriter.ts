// Typewriter reveal. Pure functions over "how many characters are shown" so they can be tested
// without a DOM. Characters are counted as code points, so emoji and rare CJK are never split.

/** Base reveal speed (code points per second). Chinese reads fast; this is roughly speaking pace. */
export const DEFAULT_CPS = 14;

/**
 * Code points of text that are still hidden before the reveal speeds up to catch the stream.
 * Below this the reveal runs at the base speed; every further point of backlog adds speed so
 * the subtitle never lags more than a second or two behind what she is saying.
 */
const CATCH_UP_FROM = 6;
const CATCH_UP_GAIN = 1.4; // extra cps per hidden code point beyond the threshold
const FINAL_MIN_CPS = 110; // a finished turn finishes its reveal quickly: 40 characters in about 0.4 s

export interface RevealInput {
  /** Code points currently shown. */
  shown: number;
  /** Code points in the full text. */
  total: number;
  /** Time since the last step, ms. */
  dtMs: number;
  /** The turn is complete: no more text is coming, so finish promptly. */
  final: boolean;
  cps?: number;
}

export function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Splits `text` after `n` code points. */
export function splitAt(text: string, n: number): [string, string] {
  if (n <= 0) return ["", text];
  let i = 0;
  let count = 0;
  for (const ch of text) {
    if (count === n) break;
    i += ch.length;
    count++;
  }
  return [text.slice(0, i), text.slice(i)];
}

/** Number of leading code points two strings share. */
export function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done || x.value !== y.value) return n;
    n++;
  }
}

/** The text was revised (a correction, or a new turn): keep what is still the same, re-reveal the rest. */
export function reconcile(shown: number, prev: string, next: string): number {
  return Math.min(shown, commonPrefixLength(prev, next));
}

/** New reveal position after `dtMs`. May return a fractional position; the view floors it. */
export function advance(i: RevealInput): number {
  if (i.shown >= i.total) return i.total;
  const hidden = i.total - i.shown;
  const base = i.cps ?? DEFAULT_CPS;
  let cps = base + Math.max(0, hidden - CATCH_UP_FROM) * CATCH_UP_GAIN;
  if (i.final) cps = Math.max(cps, FINAL_MIN_CPS);
  const next = i.shown + (cps * i.dtMs) / 1000;
  return next >= i.total ? i.total : next;
}

/** How long a finished subtitle stays after it is fully shown and her voice has stopped. */
export function lingerMs(text: string): number {
  const n = cpLength(text);
  return Math.min(9000, 2200 + n * 55);
}

/** A partial subtitle that gets no update for this long (and nobody is speaking) is dropped. */
export const STALE_PARTIAL_MS = 8000;
