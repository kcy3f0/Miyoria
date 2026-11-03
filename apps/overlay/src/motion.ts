// One motion language for the whole overlay: nothing pops. Elements enter and leave through the
// `is-out` state class (opacity plus a small move, or a height fold), and are taken out of the
// layout (`hidden`) only once their exit has finished. Text that changes cross-fades. The timings
// live in style.css (`--t-enter`, `--t-exit`, ...); under `prefers-reduced-motion` they are 1 ms.

/** A motion token from style.css in ms (`--t-exit` → 200). */
export function motionMs(token: string, fallback = 200): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : n;
}

/** Root font size in px (rem follows the frame). */
export function remPx(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** Pending "take it out of the layout" timers, per element. */
const exits = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/** Lets the browser apply the current styles, so the next class change transitions from them. */
export function reflow(el: HTMLElement): void {
  void el.offsetWidth;
}

/** Whether `el` is (or is becoming) shown. */
export function isPresent(el: HTMLElement): boolean {
  return !el.hidden && !el.classList.contains("is-out");
}

/**
 * Shows or hides `el` with its transition. Created hidden: `class="… is-out"` and `hidden`.
 * `instant` skips the transition (e.g. inside a parent that is itself fading in).
 */
export function present(el: HTMLElement, on: boolean, instant = false): void {
  if (on === isPresent(el)) return;
  const pending = exits.get(el);
  if (pending !== undefined) clearTimeout(pending);
  exits.delete(el);
  if (instant) el.classList.add("no-motion");
  if (on) {
    if (el.hidden) {
      el.hidden = false;
      reflow(el);
    }
    el.classList.remove("is-out");
  } else {
    el.classList.add("is-out");
    exits.set(
      el,
      setTimeout(
        () => {
          exits.delete(el);
          if (el.classList.contains("is-out")) el.hidden = true;
        },
        instant ? 0 : motionMs("--t-exit") + 40,
      ),
    );
  }
  if (instant) {
    reflow(el);
    el.classList.remove("no-motion");
  }
}

/** Removes `el` once its exit transition is over (it must already be on its way out). */
export function removeAfterExit(el: HTMLElement): void {
  setTimeout(() => el.remove(), motionMs("--t-exit") + 40);
}

/**
 * Text that cross-fades when it changes: the old item fades out (and up) while the new one fades
 * in (from below) in the same grid cell, so the box does not jump in between.
 */
export class Swap {
  readonly el: HTMLElement;
  #current: HTMLElement | null = null;
  #key: string | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    el.classList.add("swap");
  }

  get current(): HTMLElement | null {
    return this.#current;
  }

  /**
   * Shows `build`'s content unless `key` is already shown; returns the new item (or null when
   * nothing changed). `instant`: replace without a cross-fade (the box is not visible).
   */
  set(key: string, build: (item: HTMLElement) => void, instant = false): HTMLElement | null {
    if (key === this.#key) return null;
    this.#key = key;
    const old = this.#current;
    const item = document.createElement("span");
    item.className = "swap__item";
    build(item);
    if (old !== null) {
      if (instant) old.remove();
      else {
        old.classList.add("is-leaving");
        old.setAttribute("aria-hidden", "true");
        removeAfterExit(old);
      }
    }
    if (old !== null && !instant) item.classList.add("is-out");
    this.el.append(item);
    if (item.classList.contains("is-out")) {
      reflow(item);
      item.classList.remove("is-out");
    }
    this.#current = item;
    return item;
  }

  /** Plain text. */
  text(value: string, instant = false): void {
    this.set(value, (item) => {
      item.textContent = value;
    }, instant);
  }
}
