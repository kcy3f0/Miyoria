// Splits one speaker's audio stream into utterances.

import type { Vad } from "./vad.js";

/** Utterance boundaries, in milliseconds. */
export interface SegmenterConfig {
  sampleRate: number;
  /** Low energy for this long ends an utterance. */
  endSilenceMs: number;
  /** Utterances are cut at this length. */
  maxUtteranceMs: number;
  /** Shorter utterances (speech part, without trailing silence) are dropped. */
  minUtteranceMs: number;
  /** Utterances with less voiced audio than this are dropped. */
  minVoicedMs: number;
  /** Audio kept from before speech onset. */
  preRollMs: number;
  /** Trailing silence kept at the end of an utterance. */
  tailMs: number;
  /** Consecutive speech frames needed to start an utterance. */
  onsetFrames: number;
  /** Gaps up to this long do not reset `Segmenter.speechRunMs`. */
  runGapMs: number;
}

export const DEFAULT_SEGMENTER: Readonly<SegmenterConfig> = Object.freeze({
  sampleRate: 16_000,
  endSilenceMs: 600,
  maxUtteranceMs: 15_000,
  minUtteranceMs: 300,
  minVoicedMs: 200,
  preRollMs: 200,
  tailMs: 200,
  onsetFrames: 2,
  runGapMs: 250,
});

/** A finished utterance. */
export interface Utterance {
  samples: Int16Array;
  /** Speech part, from onset (incl. pre-roll) to the last voiced frame. */
  speechMs: number;
  /** Sum of voiced frames. */
  voicedMs: number;
  /**
   * Silence between the last voiced frame and the end-of-utterance decision (only part of it is
   * kept in `samples`).
   */
  trailingSilenceMs: number;
}

/** A growable `Int16Array`. */
class SampleBuf {
  #data = new Int16Array(4096);
  length = 0;

  push(samples: Int16Array): void {
    if (this.length + samples.length > this.#data.length) {
      let size = this.#data.length * 2;
      while (size < this.length + samples.length) size *= 2;
      const next = new Int16Array(size);
      next.set(this.#data.subarray(0, this.length));
      this.#data = next;
    }
    this.#data.set(samples, this.length);
    this.length += samples.length;
  }

  /** A copy of the first `n` samples; clears the buffer. */
  take(n: number): Int16Array {
    const out = this.#data.slice(0, Math.min(n, this.length));
    this.length = 0;
    return out;
  }

  clear(): void {
    this.length = 0;
  }
}

/**
 * Feed PCM with `push`; finished utterances come back as they are detected. Call `finish` when
 * the stream closes.
 */
export class Segmenter<V extends Vad = Vad> {
  readonly #vad: V;
  readonly #config: SegmenterConfig;
  readonly #frameLen: number;
  readonly #frameMs: number;
  /** Leftover samples that do not fill a frame yet. */
  #partial = new Int16Array(0);
  /** Recent non-speech frames, kept as pre-roll. */
  #preRoll: Int16Array[] = [];
  /** Speech frames in a row before onset. */
  #onset: Int16Array[] = [];
  #active = false;
  readonly #buf = new SampleBuf();
  /** `buf` length at the last voiced frame. */
  #speechEnd = 0;
  #voicedMs = 0;
  #silenceMs = 0;
  #runMs = 0;
  #gapMs = 0;

  constructor(vad: V, config: Partial<SegmenterConfig> = {}) {
    this.#vad = vad;
    this.#config = { ...DEFAULT_SEGMENTER, ...config };
    this.#frameLen = Math.max(1, vad.frameLen);
    this.#frameMs = Math.max(
      1,
      Math.floor((this.#frameLen * 1000) / Math.max(1, this.#config.sampleRate)),
    );
  }

  /** An utterance is in progress. */
  isActive(): boolean {
    return this.#active;
  }

  /**
   * How long the speaker has been talking continuously (short gaps tolerated). Used for
   * barge-in.
   */
  speechRunMs(): number {
    return this.#runMs;
  }

  push(samples: Int16Array): Utterance[] {
    const out: Utterance[] = [];
    let data = samples;
    if (this.#partial.length > 0) {
      data = new Int16Array(this.#partial.length + samples.length);
      data.set(this.#partial);
      data.set(samples, this.#partial.length);
    }
    let start = 0;
    while (data.length - start >= this.#frameLen) {
      const frame = data.slice(start, start + this.#frameLen);
      start += this.#frameLen;
      const u = this.#frame(frame);
      if (u) out.push(u);
    }
    this.#partial = data.slice(start);
    return out;
  }

  /** Ends the stream: returns the utterance in progress, if it qualifies. */
  finish(): Utterance | null {
    const partial = this.#partial;
    this.#partial = new Int16Array(0);
    if (this.#active && partial.length > 0) this.#buf.push(partial);
    const out = this.#active ? this.#emit() : null;
    this.#reset();
    this.#preRoll = [];
    return out;
  }

  #frame(frame: Int16Array): Utterance | null {
    const speech = this.#vad.isSpeech(frame);
    this.#trackRun(speech);
    if (!this.#active) {
      if (speech) {
        this.#onset.push(frame);
        if (this.#onset.length >= Math.max(1, this.#config.onsetFrames)) this.#begin();
      } else {
        // A lone blip is not an onset; keep it as pre-roll.
        for (const f of this.#onset.splice(0)) this.#remember(f);
        this.#remember(frame);
      }
      return null;
    }

    this.#buf.push(frame);
    if (speech) {
      this.#voicedMs += this.#frameMs;
      this.#silenceMs = 0;
      this.#speechEnd = this.#buf.length;
    } else {
      this.#silenceMs += this.#frameMs;
    }
    const lenMs = this.#ms(this.#buf.length);
    if (this.#silenceMs >= this.#config.endSilenceMs || lenMs >= this.#config.maxUtteranceMs) {
      const out = this.#emit();
      this.#reset();
      return out;
    }
    return null;
  }

  #trackRun(speech: boolean): void {
    if (speech) {
      this.#runMs += this.#frameMs + this.#gapMs;
      this.#gapMs = 0;
    } else if (this.#runMs > 0) {
      this.#gapMs += this.#frameMs;
      if (this.#gapMs > this.#config.runGapMs) {
        this.#runMs = 0;
        this.#gapMs = 0;
      }
    }
  }

  #remember(frame: Int16Array): void {
    this.#preRoll.push(frame);
    const keep = Math.floor(this.#config.preRollMs / this.#frameMs);
    while (this.#preRoll.length > keep) this.#preRoll.shift();
  }

  #begin(): void {
    this.#active = true;
    this.#buf.clear();
    for (const f of this.#preRoll.splice(0)) this.#buf.push(f);
    const onset = this.#onset.splice(0);
    this.#voicedMs = this.#frameMs * onset.length;
    for (const f of onset) this.#buf.push(f);
    this.#speechEnd = this.#buf.length;
    this.#silenceMs = 0;
  }

  #emit(): Utterance | null {
    const speechMs = this.#ms(this.#speechEnd);
    const trailing = this.#ms(Math.max(0, this.#buf.length - this.#speechEnd));
    if (speechMs < this.#config.minUtteranceMs || this.#voicedMs < this.#config.minVoicedMs) {
      return null;
    }
    const tail = Math.floor((this.#config.tailMs * this.#config.sampleRate) / 1000);
    const end = Math.min(this.#speechEnd + tail, this.#buf.length);
    return {
      samples: this.#buf.take(end),
      speechMs,
      voicedMs: this.#voicedMs,
      trailingSilenceMs: trailing,
    };
  }

  #reset(): void {
    this.#active = false;
    this.#buf.clear();
    this.#onset = [];
    this.#speechEnd = 0;
    this.#voicedMs = 0;
    this.#silenceMs = 0;
  }

  #ms(samples: number): number {
    return Math.floor((samples * 1000) / Math.max(1, this.#config.sampleRate));
  }
}
