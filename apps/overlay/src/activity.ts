// The activity capsule (bottom left, right of the voice bars): what she is doing right now, with a
// progress bar inside it. Determinate progress eases to each new value; a song she sings runs its
// bar on this page's clock (a CSS animation from `elapsedMs` over `durationMs`); anything else is
// indeterminate (a slow shimmer). The label cross-fades and the capsule's width eases to the new
// label, so it never jumps.
import type { Activity } from "./feed.js";
import { isPresent, present, reflow, remPx, Swap } from "./motion.js";

/** Kinds without real progress (a shimmer instead of a bar). */
const BUSY = new Set(["thinking", "synthesizing", "notice"]);
/** A resent song whose position is off by more than this restarts its bar (ms). */
const RESYNC_MS = 750;

function span(className: string, parent: HTMLElement, text?: string): HTMLElement {
  const e = document.createElement("span");
  e.className = className;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
}

export class ActivityCapsule {
  readonly el: HTMLElement;
  readonly #label: Swap;
  readonly #track: HTMLElement;
  readonly #fill: HTMLElement;
  /** The song whose bar is running, and where it is on `performance.now()`'s clock. */
  #song: { key: string; startedAt: number; durationMs: number } | null = null;
  /** JSON of the activity shown (null: hidden). */
  #shown: string | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "activity is-out";
    this.el.hidden = true;
    this.el.setAttribute("role", "status");
    parent.append(this.el);
    span("activity__dot", this.el);
    this.#label = new Swap(span("activity__label", this.el));
    this.#track = span("activity__track", this.el);
    this.#fill = span("activity__fill", this.#track);
  }

  /** The emotion colour the dot and the bar are tinted with. */
  accent(color: string): void {
    this.el.style.setProperty("--dot", color);
  }

  show(activity: Activity | null): void {
    // The view repaints on every feed change; only a different activity touches the capsule (a
    // song's bar must not restart from the `elapsedMs` it was sent with).
    const shown = activity === null ? null : JSON.stringify(activity);
    if (shown === this.#shown) return;
    this.#shown = shown;
    if (activity === null) {
      present(this.el, false);
      return;
    }
    // Coming back from hidden: no cross-fade or width easing behind the fade-in (shown first,
    // so the new label can be measured).
    const instant = !isPresent(this.el);
    present(this.el, true);
    this.el.dataset.kind = activity.kind;
    this.#setLabel(activity, instant);
    this.#setProgress(activity, instant);
  }

  #setLabel(a: Activity, instant: boolean): void {
    const item = this.#label.set(
      `${a.label}\0${a.detail ?? ""}`,
      (it) => {
        it.classList.add("activity__item");
        span("activity__verb", it, a.label);
        if (a.detail) {
          span("activity__mark", it, "〈");
          span("activity__title", it, a.detail);
          span("activity__mark", it, "〉");
        }
      },
      instant,
    );
    if (item === null) return;
    // The label box eases to the new label's width (the capsule follows it).
    const box = this.#label.el;
    const width = item.getBoundingClientRect().width / remPx();
    if (instant) box.classList.add("no-motion");
    box.style.width = `${Math.ceil(width * 100) / 100}rem`;
    if (instant) {
      reflow(box);
      box.classList.remove("no-motion");
    }
  }

  #setProgress(a: Activity, instant: boolean): void {
    const fill = this.#fill;
    const busy = BUSY.has(a.kind) || (a.progress === null && a.durationMs === null);
    this.#track.classList.toggle("is-indeterminate", busy);
    this.el.classList.toggle("is-busy", busy);
    if (a.durationMs !== null) {
      this.#runSong(a, a.durationMs);
      return;
    }
    this.#song = null;
    if (fill.style.animationName !== "") {
      fill.style.animation = "";
      instant = true;
    }
    const p = busy ? 0 : (a.progress ?? 0);
    if (instant) fill.classList.add("no-motion");
    fill.style.transform = `scaleX(${p})`;
    if (instant) {
      reflow(fill);
      fill.classList.remove("no-motion");
    }
  }

  /** The bar of a song: one linear animation from where the song is to its end. */
  #runSong(a: Activity, durationMs: number): void {
    const now = performance.now();
    const elapsed = a.elapsedMs ?? 0;
    const key = `${a.label}\0${a.detail ?? ""}\0${durationMs}`;
    const s = this.#song;
    if (s !== null && s.key === key && Math.abs(now - s.startedAt - elapsed) < RESYNC_MS) return;
    this.#song = { key, startedAt: now - elapsed, durationMs };
    const fill = this.#fill;
    fill.style.animation = "none";
    fill.style.transform = "";
    reflow(fill);
    fill.style.animation = `activity-fill ${durationMs}ms linear ${-elapsed}ms both`;
  }
}
