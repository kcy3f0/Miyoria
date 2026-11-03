// Signals from other modules that shape her behaviour: how she feels about people
// (`SocialSignals`), her mood (`MoodSignals`) and the LLM budget (`llm.budget` events).

import {
  type HerStatus,
  type Mood,
  neutralize,
  type RaisedTopic,
  type ShownEmotion,
} from "@miyoria/types";
import { ParseError } from "./config.js";

/**
 * Topic of the `custom` event the LLM layer publishes when its budget state changes; the
 * payload is `{"state": "ok" | "degraded" | "exhausted", ...}`.
 */
export const BUDGET_TOPIC = "llm.budget";

/**
 * What she says (at most once per context per notice interval) when the LLM budget is
 * exhausted. Constant: no model is involved.
 */
export const EXHAUSTED_LINE = "哼……今天的能量用完了啦,才、才不是想偷懶!明天再陪你們聊。";

/**
 * State of the LLM budget as reported on `llm.budget`.
 * `degraded`: save tokens (ambient channels act like mention-only, no initiative).
 * `exhausted`: no generation at all; a canned line now and then instead.
 */
export type BudgetState = "ok" | "degraded" | "exhausted";

/** Throws `ParseError`. */
export function parseBudgetState(s: string): BudgetState {
  const v = s.trim().toLowerCase();
  if (v === "ok" || v === "degraded" || v === "exhausted") return v;
  throw new ParseError(`unknown budget state \`${v}\``);
}

/** Her actual voice / stream / game state, for the situation (so she never claims otherwise). */
export function herStatusHint(her: HerStatus): string {
  const voice =
    her.voice === null ? "不在語音頻道" : `在語音頻道 ${her.voice_name ?? her.voice.channel}`;
  const live =
    her.golive === "live" || her.golive === "starting"
      ? "正在 Go Live 直播"
      : her.streaming
        ? "OBS 正在直播"
        : "沒有在直播";
  const game = her.game === null ? "沒有在玩遊戲" : `正在玩 ${her.game}`;
  return `你現在${voice}、${live}、${game}。`;
}

/** Topics listed at most. */
const MAX_UNANSWERED = 3;

/**
 * What she raised here on her own recently and nobody picked up (her own lines, short), with
 * the rule not to bring it up again; empty when there is nothing.
 */
export function unansweredHint(topics: readonly RaisedTopic[]): string {
  const lines = topics
    .slice(0, MAX_UNANSWERED)
    .map((t) => {
      const chars = [...neutralize(t.text).replace(/\s+/g, " ").trim()];
      return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : chars.join("");
    })
    .filter((t) => t !== "");
  if (lines.length === 0) return "";
  return `你最近在這裡自己提過、沒人接的話題:${lines.map((l) => `「${l}」`).join("、")}。一陣子內不要再提(換句話說也一樣);沒人接就放下,跟著大家現在聊的事,或換個話題。`;
}

/**
 * What she shows of her emotion (the `self` module's display rules), so her lines and her
 * `<emo:…>` tags follow it rather than what she really feels. Only fixed text: no names.
 */
export function shownHint(shown: ShownEmotion): string {
  const tag = /^[a-z_]{1,32}$/.test(shown.tag) ? shown.tag : "neutral";
  const style = neutralize(shown.style).replace(/\s+/g, " ").trim().slice(0, 80);
  const hide = shown.masked ? ";心裡真正的感受藏起來,不要直接說出來" : "";
  return `你現在表現出來的樣子:${style}。台詞和 <emo:…> 照這個走(多半是 <emo:${tag}>)${hide}`;
}

/**
 * One line describing her mood, e.g. `"你現在的狀態:心情不錯、平靜、有點累"` (the fallback
 * while `AffectState` is not running; its `mood_line` replaces it).
 */
export function moodHint(mood: Mood): string {
  const valence = mood.valence < -0.3 ? "心情不太好" : mood.valence > 0.3 ? "心情不錯" : "心情普通";
  const arousal = mood.arousal > 0.7 ? "有點興奮" : mood.arousal < 0.3 ? "平靜" : "還算放鬆";
  const energy = mood.energy < 0.3 ? "有點累" : mood.energy > 0.7 ? "精神很好" : "精神普通";
  return `你現在的狀態:${valence}、${arousal}、${energy}`;
}
