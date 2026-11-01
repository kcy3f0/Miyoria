// Turns the frames the Discord player pulls into timed level points for the Stage.
//
// A playback has its own timeline (t = 0 at its first frame). Each 10 ms window is sent at
// `origin + t` on the wall clock, where `origin` is the moment the first frame was pulled, so the
// stream is evenly paced however bursty the player's reads are (it reads ahead a little when a
// playback starts). If the player stalls and resumes, the origin is shifted so the levels stay with
// the audio instead of arriving as a burst. Only one playback drives the levels at a time; a newer
// one takes over from an older one.
import { OUT_RATE } from "../playback/source.js";
import { type LevelPoint, RmsFramer } from "./rms.js";

export interface LevelSink {
  send(point: LevelPoint): void;
}

export type Schedule = (fn: () => void, ms: number) => { cancel(): void };

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

/** Falling behind the wall clock by more than this re-anchors the timeline. */
const LATE_MS = 60;

export interface LevelPublisherOptions {
  sink: LevelSink;
  /** RMS multiplier (`STAGE_LEVELS_GAIN`). */
  gain?: number;
  windowMs?: number;
  /** Test hooks. */
  schedule?: Schedule;
  now?: () => number;
}

export class LevelPublisher {
  private readonly o: LevelPublisherOptions;
  private active: LevelTap | undefined;

  constructor(opts: LevelPublisherOptions) {
    this.o = opts;
  }

  /** Starts a new playback timeline (t = 0). Whatever the previous one still had pending is dropped. */
  begin(): LevelTap {
    this.active?.supersede();
    const tap = new LevelTap(
      this.o.sink,
      new RmsFramer({ sampleRate: OUT_RATE, channels: 2, windowMs: this.o.windowMs ?? 10, gain: this.o.gain ?? 1 }),
      this.o.schedule ?? defaultSchedule,
      this.o.now ?? (() => performance.now()),
      (t) => {
        if (this.active === t) this.active = undefined;
      },
    );
    this.active = tap;
    return tap;
  }
}

type TapState = "active" | "ended" | "closed";

export class LevelTap {
  private state: TapState = "active";
  private origin: number | undefined;
  private readonly pending = new Set<{ cancel(): void }>();

  constructor(
    private readonly sink: LevelSink,
    private readonly framer: RmsFramer,
    private readonly schedule: Schedule,
    private readonly now: () => number,
    private readonly onClosed: (tap: LevelTap) => void,
  ) {}

  /** A frame of interleaved s16le stereo @ 48 kHz that was just handed to the player. */
  frame(pcm: Uint8Array): void {
    if (this.state !== "active") return;
    this.emit(this.framer.pushPcm(pcm));
  }

  /** The player was fed a silence frame (underrun) of `samples` per channel. */
  silence(samples = 960): void {
    if (this.state !== "active") return;
    this.emit(this.framer.pushSilence(samples));
  }

  /** The audio is over (drained, faded or stopped at the source): a final zero once the last window is due. */
  end(): void {
    if (this.state !== "active") return;
    this.state = "ended";
    this.at(this.framer.positionMs, { t: this.framer.positionMs, rms: 0 });
  }

  /** Abrupt end (player destroyed, connection lost): drop what is pending and zero the mouth now. */
  cancel(): void {
    if (this.state !== "active") return; // "ended" finishes by itself
    this.drop();
    this.sink.send({ t: this.framer.positionMs, rms: 0 });
    this.onClosed(this);
  }

  /** A newer playback took over: drop everything silently, its own t = 0 point resets the Stage. */
  supersede(): void {
    if (this.state === "closed") return;
    this.drop();
    this.onClosed(this);
  }

  private drop(): void {
    this.state = "closed";
    for (const p of this.pending) p.cancel();
    this.pending.clear();
  }

  private emit(points: LevelPoint[]): void {
    const first = points[0];
    if (!first) return;
    const now = this.now();
    this.origin ??= now - first.t;
    const lag = now - (this.origin + first.t);
    if (lag > LATE_MS) this.origin += lag;
    for (const p of points) this.at(p.t, p);
  }

  /** Sends `point` when the wall clock reaches origin + t. */
  private at(t: number, point: LevelPoint): void {
    const origin = this.origin ?? this.now() - t;
    this.origin ??= origin;
    const wait = origin + t - this.now();
    if (wait <= 0) {
      this.fire(point);
      return;
    }
    const h = this.schedule(() => {
      this.pending.delete(h);
      this.fire(point);
    }, wait);
    this.pending.add(h);
  }

  private fire(point: LevelPoint): void {
    if (this.state === "closed") return;
    this.sink.send(point);
    if (this.state === "ended" && this.pending.size === 0 && point.rms === 0 && point.t >= this.framer.positionMs) {
      this.state = "closed";
      this.onClosed(this);
    }
  }
}
