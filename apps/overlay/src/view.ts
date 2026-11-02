// DOM for the overlay. Holds the reducer state plus the time-based bits the reducer must not know about
// (typewriter position, linger timers) and paints them from one animation-frame loop.
import type { OverlayConfig } from "./config.js";
import { type Action, initialState, type OverlayState, reduce } from "./feed.js";
import { emotionColor } from "./emotion.js";
import {
  advance,
  cpLength,
  lingerMs,
  reconcile,
  splitAt,
  STALE_PARTIAL_MS,
} from "./typewriter.js";
import { Wave } from "./wave.js";

const QUEUE_SHOWN = 5;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: Element,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

export class Overlay {
  private state: OverlayState = initialState();

  // subtitle timing (ms on the rAF clock)
  private text = "";
  private turn = "";
  private final = false;
  private shown = 0; // code points revealed (fractional while stepping)
  private paintedShown = -1;
  private seenSeq = 0;
  private lastFrame = 0;
  private lastUpdateAt = 0;
  private completeAt: number | null = null;
  private quietSince = 0; // when her voice last stopped (or the subtitle last changed while silent)
  private visible = false;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly subtitle: HTMLElement;
  private readonly shownEl: HTMLElement;
  private readonly restEl: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly emotionRow: HTMLElement;
  private readonly emotionDot: HTMLElement;
  private readonly emotionName: HTMLElement;
  private readonly statusBox: HTMLElement;
  private readonly liveRow: HTMLElement;
  private readonly sceneEl: HTMLElement;
  private readonly chips: Record<"core" | "vts" | "obs", HTMLElement>;
  private readonly queueBox: HTMLElement;
  private readonly queueList: HTMLElement;
  private readonly queueMore: HTMLElement;
  private readonly offline: HTMLElement;
  private readonly wave: Wave;
  private readonly noticeEl: HTMLElement;
  private readonly noticeText: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly cfg: OverlayConfig,
  ) {
    root.replaceChildren();
    const main = el("main", "overlay", root);

    this.wave = new Wave(main);
    this.wave.hidden = !cfg.show.has("wave");

    this.subtitle = el("section", "subtitle is-hidden", main);
    const p = el("p", "subtitle__text", this.subtitle);
    this.shownEl = el("span", "subtitle__shown", p);
    this.restEl = el("span", "subtitle__rest", p);
    this.subtitle.hidden = !cfg.show.has("subtitles");

    this.panel = el("aside", "panel", main);
    this.panel.hidden = true;

    this.emotionRow = el("div", "emotion", this.panel);
    this.emotionDot = el("i", "emotion__dot", this.emotionRow);
    this.emotionName = el("span", "emotion__name", this.emotionRow);

    this.statusBox = el("div", "status", this.panel);
    this.liveRow = el("div", "status__live", this.statusBox);
    el("i", "status__pulse", this.liveRow);
    el("span", "", this.liveRow, "直播中");
    this.sceneEl = el("div", "status__scene", this.statusBox);
    const chips = el("div", "status__chips", this.statusBox);
    const chip = (label: string): HTMLElement => {
      const c = el("span", "chip", chips);
      el("i", "chip__dot", c);
      el("span", "", c, label);
      return c;
    };
    this.chips = { core: chip("Core"), vts: chip("VTS"), obs: chip("OBS") };

    this.queueBox = el("div", "queue", this.panel);
    el("h2", "queue__title", this.queueBox, "接下來");
    this.queueList = el("ol", "queue__list", this.queueBox);
    this.queueMore = el("div", "queue__more", this.queueBox);

    // A status line above the subtitles (「準備歌曲中…」 while her voice is away for a song).
    this.noticeEl = el("div", "notice", main);
    el("i", "notice__dot", this.noticeEl);
    this.noticeText = el("span", "notice__text", this.noticeEl);
    this.noticeEl.hidden = true;

    this.offline = el("div", "offline", main, "feed offline");
    this.offline.hidden = true;

    this.renderPanel();
  }

  dispatch(action: Action): void {
    if (action.type === "levels") {
      // Same clock as the rAF timestamps, but not tied to a frame having run.
      this.wave.level(action.rms, action.bands, performance.now());
      return;
    }
    const prev = this.state;
    this.state = reduce(prev, action);
    if (this.state === prev) return;
    if (action.type === "speaking" && !this.state.speaking) this.quietSince = this.lastFrame;
    if (this.state.subtitleSeq !== this.seenSeq) this.onSubtitle();
    this.renderPanel();
  }

  /** Call once per animation frame with the rAF timestamp. */
  frame(now: number): void {
    const dt = this.lastFrame === 0 ? 0 : Math.min(100, now - this.lastFrame);
    this.lastFrame = now;

    if (this.visible) {
      const total = cpLength(this.text);
      if (this.shown < total) {
        this.shown = advance({ shown: this.shown, total, dtMs: dt, final: this.final, cps: this.cfg.cps });
      }
      this.paintText();
      if (this.shown >= total) this.completeAt ??= now;
      this.maybeHide(now, total);
    }
    this.wave.frame(dt, now);
    this.offline.hidden = !(this.cfg.debug && !this.state.connected);
  }

  // ── subtitle ─────────────────────────────────────────────────────────────

  private onSubtitle(): void {
    const sub = this.state.subtitle;
    this.seenSeq = this.state.subtitleSeq;
    const now = this.lastFrame;
    if (!sub) {
      this.hide();
      return;
    }
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = undefined;

    const sameTurn = this.visible && sub.turn === this.turn;
    this.shown = sameTurn ? reconcile(this.shown, this.text, sub.text) : 0;
    this.text = sub.text;
    this.turn = sub.turn;
    this.final = sub.final;
    this.lastUpdateAt = now;
    this.completeAt = null;
    if (!this.state.speaking) this.quietSince = now;
    this.paintedShown = -1;
    if (!this.visible) {
      this.visible = true;
      this.subtitle.classList.remove("is-hidden");
    }
    this.subtitle.classList.toggle("is-final", sub.final);
    if (this.cfg.cps >= 200) this.shown = cpLength(sub.text); // effectively "no typewriter"
  }

  private maybeHide(now: number, total: number): void {
    if (this.state.speaking) return; // never take the words away while she is still saying them
    const quiet = Math.max(this.quietSince, this.lastUpdateAt);
    if (this.final) {
      if (this.completeAt !== null && this.shown >= total && now - Math.max(this.completeAt, quiet) > lingerMs(this.text)) {
        this.hide();
      }
    } else if (now - quiet > STALE_PARTIAL_MS) {
      this.hide();
    }
  }

  private hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.subtitle.classList.add("is-hidden");
    // Keep the words while the plate fades out, then drop them so the next line starts from a clean plate.
    this.clearTimer = setTimeout(() => {
      this.shownEl.textContent = "";
      this.restEl.textContent = "";
      this.paintedShown = -1;
    }, 600);
  }

  private paintText(): void {
    const n = Math.floor(this.shown);
    if (n === this.paintedShown) return;
    this.paintedShown = n;
    // The whole line is laid out from the first frame (the unrevealed part is transparent), so
    // words never jump to the next line while they are being typed.
    const [a, b] = splitAt(this.text, n);
    this.shownEl.textContent = a;
    this.restEl.textContent = b;
  }

  // ── side panel ───────────────────────────────────────────────────────────

  private renderPanel(): void {
    const { emotion, status, queue, notice } = this.state;
    const show = this.cfg.show;

    // Part of the subtitle area: shown wherever subtitles are.
    this.noticeEl.hidden = !(show.has("subtitles") && notice !== null);
    this.noticeText.textContent = notice ?? "";

    const emotionOn = show.has("emotion") && emotion !== null;
    this.emotionRow.hidden = !emotionOn;
    if (emotion) {
      this.emotionName.textContent = emotion.name;
      const c = emotionColor(emotion.name);
      this.emotionDot.style.setProperty("--dot", c);
      this.wave.accent(c);
      this.emotionDot.style.setProperty("--level", String(0.45 + 0.55 * emotion.intensity));
    }

    const statusOn = show.has("status") && status !== null;
    this.statusBox.hidden = !statusOn;
    if (status) {
      this.liveRow.hidden = !status.streaming;
      this.sceneEl.hidden = !status.scene;
      this.sceneEl.textContent = status.scene ?? "";
      for (const k of ["core", "vts", "obs"] as const) this.chips[k].classList.toggle("is-ok", status[k]);
    }

    const items = queue.slice(0, QUEUE_SHOWN);
    const queueOn = show.has("queue") && queue.length > 0;
    this.queueBox.hidden = !queueOn;
    if (queueOn) {
      this.queueList.replaceChildren(
        ...items.map((q, i) => {
          const li = el("li", "queue__item");
          el("span", "queue__n", li, String(i + 1));
          el("span", "queue__what", li, q.title);
          if (q.by) el("span", "queue__by", li, q.by);
          return li;
        }),
      );
      const more = queue.length - items.length;
      this.queueMore.hidden = more <= 0;
      this.queueMore.textContent = more > 0 ? `還有 ${more} 項` : "";
    }

    this.panel.hidden = !(emotionOn || statusOn || queueOn);
  }
}
