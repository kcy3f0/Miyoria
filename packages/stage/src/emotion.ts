// Emotion → VTube Studio expression / hotkey, with a hold time and a return to neutral.

import type { AvatarAction, AvatarProfile } from "./avatar.js";

/** A request the emotion controller wants sent to VTube Studio. */
export type VtsCommand =
  | { type: "expression"; file: string; active: boolean }
  | { type: "hotkey"; name: string };

interface Current {
  name: string;
  action: AvatarAction;
  /** Clock ms. */
  until: number;
}

/**
 * Keeps one main expression at a time.
 *
 * `neutral` is the resting state: an expression there is active while resting, a hotkey there
 * is fired to return to rest (e.g. a VTS "Remove all expressions" hotkey). Unmapped emotions
 * count as neutral. An emotion is held for `holdMs`, never ends while she speaks, and lasts at
 * least `afterSpeechMs` after she stops. Times are milliseconds of any monotonic clock.
 */
export class EmotionController {
  readonly #emotions: Map<string, AvatarAction>;
  readonly #neutral: AvatarAction | null;
  readonly #holdMs: number;
  readonly #afterSpeechMs: number;
  #current: Current | null = null;
  #speaking = false;

  constructor(profile: AvatarProfile, holdMs: number, afterSpeechMs: number) {
    this.#emotions = new Map(profile.emotions);
    this.#neutral = this.#emotions.get("neutral") ?? null;
    this.#emotions.delete("neutral");
    this.#holdMs = holdMs;
    this.#afterSpeechMs = afterSpeechMs;
  }

  /** The emotion being shown (`null` = neutral). */
  current(): string | null {
    return this.#current?.name ?? null;
  }

  /** When the current emotion ends (if she is not speaking then). */
  deadline(): number | null {
    return this.#current?.until ?? null;
  }

  /** Commands that put the model into the resting state (after connecting). */
  rest(): VtsCommand[] {
    const out: VtsCommand[] = [];
    const current = this.#current;
    this.#current = null;
    if (current) leave(current.action, out);
    if (this.#neutral) enter(this.#neutral, out);
    return out;
  }

  onEmotion(emotion: string, now: number): VtsCommand[] {
    const name = emotion.trim().toLowerCase();
    const action = this.#emotions.get(name);
    // `neutral` or unmapped.
    if (!action) return this.#returnToRest();
    const until = now + this.#holdMs;
    if (this.#current && this.#current.name === name) {
      this.#current.until = Math.max(this.#current.until, until);
      return [];
    }
    const out: VtsCommand[] = [];
    const previous = this.#current;
    if (previous) {
      leave(previous.action, out);
      // A hotkey effect is cleared through neutral's hotkey.
      if (previous.action.type === "hotkey" && this.#neutral?.type === "hotkey") {
        out.push({ type: "hotkey", name: this.#neutral.name });
      }
    } else if (this.#neutral?.type === "expression") {
      out.push({ type: "expression", file: this.#neutral.file, active: false });
    }
    enter(action, out);
    this.#current = { name, action, until };
    return out;
  }

  setSpeaking(speaking: boolean, now: number): void {
    if (this.#speaking && !speaking && this.#current) {
      this.#current.until = Math.max(this.#current.until, now + this.#afterSpeechMs);
    }
    this.#speaking = speaking;
  }

  /** Returns to neutral once the hold time is over. */
  tick(now: number): VtsCommand[] {
    const c = this.#current;
    if (c && !this.#speaking && now >= c.until) return this.#returnToRest();
    return [];
  }

  #returnToRest(): VtsCommand[] {
    const current = this.#current;
    if (!current) return [];
    this.#current = null;
    const out: VtsCommand[] = [];
    leave(current.action, out);
    if (this.#neutral) enter(this.#neutral, out);
    return out;
  }
}

function enter(action: AvatarAction, out: VtsCommand[]): void {
  out.push(
    action.type === "expression"
      ? { type: "expression", file: action.file, active: true }
      : { type: "hotkey", name: action.name },
  );
}

function leave(action: AvatarAction, out: VtsCommand[]): void {
  if (action.type === "expression")
    out.push({ type: "expression", file: action.file, active: false });
}
