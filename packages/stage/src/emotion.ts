// Emotion → VTube Studio accent expression / hotkey, with a hold time and a return to neutral.
// (The emotion's parameter pose is blended by `PoseBlender`, following `current()`.)

import type { AvatarAction, AvatarProfile } from "./avatar.js";

/** A request the emotion controller wants sent to VTube Studio. */
export type VtsCommand =
  | { type: "expression"; file: string; active: boolean }
  | { type: "hotkey"; name: string };

interface Current {
  name: string;
  /** The accent shown, `null` when the emotion has none (or was too weak for it). */
  action: AvatarAction | null;
  /** Clock ms. */
  until: number;
}

/**
 * Keeps one main emotion (and its accent expression) at a time.
 *
 * `neutral` is the resting state: an expression there is active while no accent is shown, a
 * hotkey there is fired to return to rest (e.g. a VTS "Remove all expressions" hotkey).
 * Emotions with neither an accent nor a pose count as neutral. An emotion is held for `holdMs`,
 * never ends while she speaks, and lasts at least `afterSpeechMs` after she stops. Its accent
 * is skipped below the pose's `accentMin` intensity. Times are milliseconds of any monotonic
 * clock.
 */
export class EmotionController {
  readonly #emotions: Map<string, AvatarAction>;
  readonly #known: Set<string>;
  readonly #profile: AvatarProfile;
  readonly #neutral: AvatarAction | null;
  readonly #holdMs: number;
  readonly #afterSpeechMs: number;
  #current: Current | null = null;
  #speaking = false;
  /** The resting expression (when `neutral` is one) is believed active. */
  #neutralOn = false;

  constructor(profile: AvatarProfile, holdMs: number, afterSpeechMs: number) {
    this.#emotions = new Map(profile.emotions);
    this.#neutral = this.#emotions.get("neutral") ?? null;
    this.#emotions.delete("neutral");
    this.#known = profile.knownEmotions();
    this.#profile = profile;
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
    if (current?.action) leave(current.action, out);
    if (this.#neutral) enter(this.#neutral, out);
    this.#neutralOn = true;
    return out;
  }

  /** A new emotion marker. `intensity` (0..1) decides whether the accent is shown. */
  onEmotion(emotion: string, now: number, intensity = 1): VtsCommand[] {
    const name = emotion.trim().toLowerCase();
    // `neutral` or unmapped.
    if (!this.#known.has(name)) return this.#returnToRest();
    const mapped = this.#emotions.get(name) ?? null;
    const action = mapped && intensity >= this.#profile.poseFor(name).accentMin ? mapped : null;
    let until = now + this.#holdMs;
    const current = this.#current;
    if (current && current.name === name) {
      until = Math.max(current.until, until);
      // Same emotion: extend it (and add the accent if it is strong enough now).
      if (current.action !== null || action === null) {
        current.until = until;
        return [];
      }
    }
    const out: VtsCommand[] = [];
    if (current?.action) {
      leave(current.action, out);
      // A hotkey effect is cleared through neutral's hotkey.
      if (current.action.type === "hotkey" && this.#neutral?.type === "hotkey") {
        out.push({ type: "hotkey", name: this.#neutral.name });
      }
    }
    if (action) {
      if (this.#neutral?.type === "expression" && this.#neutralOn) {
        out.push({ type: "expression", file: this.#neutral.file, active: false });
        this.#neutralOn = false;
      }
      enter(action, out);
    } else if (this.#neutral?.type === "expression" && !this.#neutralOn) {
      // No accent: the resting expression stays.
      enter(this.#neutral, out);
      this.#neutralOn = true;
    }
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
    if (current.action) leave(current.action, out);
    if (this.#neutral?.type === "hotkey") {
      if (current.action) enter(this.#neutral, out);
    } else if (this.#neutral && !this.#neutralOn) {
      enter(this.#neutral, out);
    }
    this.#neutralOn = true;
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
