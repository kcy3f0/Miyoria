// Cuts streamed reply text into sentences, so each one can be sent to TTS as soon as it is
// complete.
//
// Sentences end at `。！？!?…~～` and line breaks (a run such as `……` or `?!` stays together,
// as do closing quotes and brackets after it). A clause that grew past `LONG_CLAUSE_CHARS` is
// also cut at the next comma.

import { isAlphanumeric } from "./util.js";

/** Characters that end a sentence. */
const SENTENCE_ENDS = new Set(["。", "！", "？", "!", "?", "…", "~", "～", "\n"]);
/** Commas that end a clause once it is long. */
const CLAUSE_BREAKS = new Set(["，", ","]);
/** Kept with the sentence they follow. */
const CLOSERS = new Set(["」", "』", "）", ")", "】", '"', "”", "’", "'"]);

/** A clause this long (in characters) is cut at the next comma. */
export const LONG_CLAUSE_CHARS = 40;

/** Incremental splitter: `push` text as it streams in, then `flush` the rest at the end. */
export class SentenceSplitter {
  #buf = "";

  /** Adds text; returns the sentences it completed (trimmed, non-empty). */
  push(text: string): string[] {
    this.#buf += text;
    const out: string[] = [];
    for (let end = this.#cut(); end !== null; end = this.#cut()) {
      const sentence = this.#buf.slice(0, end).trim();
      this.#buf = this.#buf.slice(end);
      if (sentence !== "") out.push(sentence);
    }
    return out;
  }

  /**
   * Takes the held text if it is a finished sentence (it ends with an end mark that was waiting
   * for more input), e.g. before a new emotion starts.
   */
  flushComplete(): string | null {
    const last = [...this.#buf.trimEnd()].at(-1);
    if (last === undefined) return null;
    return SENTENCE_ENDS.has(last) || CLOSERS.has(last) ? this.flush() : null;
  }

  /** Takes the unfinished rest as a sentence, if there is any text. */
  flush(): string | null {
    const rest = this.#buf.trim();
    this.#buf = "";
    return rest === "" ? null : rest;
  }

  /**
   * Index just past the first complete sentence in the buffer. A sentence end at the very end
   * of the buffer is not complete yet: more end marks (`…` after `…`) may follow in the next
   * chunk.
   */
  #cut(): number | null {
    const leading = this.#buf.length - this.#buf.trimStart().length;
    const body = this.#buf.slice(leading);
    let n = 0;
    let i = 0;
    for (const c of body) {
      const ends = SENTENCE_ENDS.has(c) || (n >= LONG_CLAUSE_CHARS && CLAUSE_BREAKS.has(c));
      if (ends) {
        let end = i + c.length;
        for (const next of body.slice(end)) {
          if (SENTENCE_ENDS.has(next) || CLOSERS.has(next)) end += next.length;
          else break;
        }
        return end < body.length ? leading + end : null;
      }
      n++;
      i += c.length;
    }
    return null;
  }
}

/**
 * Whether `text` has anything a TTS engine can say (letters or digits in any script, not just
 * punctuation or symbols).
 */
export function isSpeakable(text: string): boolean {
  for (const c of text) if (isAlphanumeric(c)) return true;
  return false;
}
