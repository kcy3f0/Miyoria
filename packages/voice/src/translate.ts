// Speaking in another language: each line is translated right before TTS, the subtitles and the
// chat log keep the original. A voice reply usually writes the spoken line itself
// (`<voice>…</voice>`, see the agent's `Speech`); only lines without one take a translation call.

import { errorMessage, type Logger } from "@miyoria/kernel";
import { type LlmRouter, systemMessage, userMessage } from "@miyoria/llm";

/** Translations kept for lines that were prepared but not spoken yet (or spoken twice). */
const MAX_CACHED = 32;

/** The prompt for one line. */
export function translatePrompt(language: string): string {
  return [
    `Translate the line the user gives you into natural spoken ${language}.`,
    "It is something a streamer says out loud: keep her tone, attitude, interjections and stammers,",
    "and keep names, usernames and game terms as they are.",
    "Reply with the translation only: no quotes, notes, romanization or explanations.",
  ].join(" ");
}

/**
 * Translates lines for TTS. `prepare` starts a translation early (when the sentence is queued), so
 * by the time it is spoken the translation is usually done; `translate` awaits it. A failed
 * translation falls back to the original text: she still speaks, just untranslated.
 */
export class SpeechTranslator {
  readonly #pending = new Map<string, Promise<string>>();

  constructor(
    private readonly router: LlmRouter,
    private readonly purpose: string,
    readonly language: string,
    private readonly log: Logger,
  ) {}

  prepare(text: string): void {
    if (text.trim() === "" || this.#pending.has(text)) return;
    this.#keep(text, this.#run(text));
  }

  /** The reply already said `text` in the target language: no translation call for it. */
  provide(text: string, translation: string): void {
    if (text.trim() === "" || translation.trim() === "") return;
    this.#pending.delete(text);
    this.#keep(text, Promise.resolve(translation.trim()));
  }

  #keep(text: string, translation: Promise<string>): void {
    if (this.#pending.size >= MAX_CACHED) {
      const oldest = this.#pending.keys().next().value;
      if (oldest !== undefined) this.#pending.delete(oldest);
    }
    this.#pending.set(text, translation);
  }

  async translate(text: string, signal?: AbortSignal): Promise<string> {
    this.prepare(text);
    const pending = this.#pending.get(text) ?? this.#run(text);
    this.#pending.delete(text);
    if (!signal) return pending;
    signal.throwIfAborted();
    return Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    ]);
  }

  async #run(text: string): Promise<string> {
    try {
      const response = await this.router.complete(this.purpose, {
        messages: [systemMessage(translatePrompt(this.language)), userMessage(text)],
        temperature: 0.3,
        max_tokens: 400,
        thinking: false,
      });
      const out = response.text.trim();
      if (out === "") throw new Error("empty translation");
      return out;
    } catch (error) {
      this.log.warn(
        { err: errorMessage(error), text },
        "translation for speech failed, speaking the original",
      );
      return text;
    }
  }
}
