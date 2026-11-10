// The tool loop inside a turn (docs/design/v4-plan.md §4.2).
//
// V3 made one call a turn: every tool went to the hands and its result came back in a turn of its
// own, with a prompt built again from scratch, so a lookup in three steps was three turns that did
// not know what the step before had thought. Now the tools that answer at once (`loop_tools`: a
// search, a page, a memory, a wallet, a note, a short program) run inside the turn: her call and
// its result stay in the messages and she goes on in the same chain, up to `max_tool_steps` rounds.
// Activities that take minutes (a game, a song, going live, joining voice) stay with the hands.
//
// The outer walls do not move: the tools on offer are still the Directives' list, every call still
// goes through `#tryTool` (whose permission it is), every line still through the gate, the ledger
// and moderation, and the decision of the turn is still logged once, with every tool it used.

import { REASONING_LEVELS, type ReasoningLevel } from "@miyoria/types";
import { charCount } from "../util.js";
import { COMMIT_TOOL } from "./output.js";

/** Sentences of `text`, punctuation kept. */
export function sentences(text: string): string[] {
  return (text.match(/[^。!?!?\n]+[。!?!?\n]*/g) ?? []).filter((s) => s.trim() !== "");
}

/** `[llm.reasoning]` purpose of a call that reads what her tools brought back (v4 §4.4). */
export const TOOL_STEP_PURPOSE = "chat_tools";
/** `[llm.reasoning]` purpose of a text reply to a real question (v4 §4.4). */
export const QUESTION_PURPOSE = "chat_question";

/** What a call left to the hands answers in the loop: it is out, not done. */
export const HANDED_OVER = "交出去了,還沒完成;結果回來會再叫你。";
/** What `commit` answers in the loop. */
export const COMMITTED = "記下了,到期會提醒你。";
/** Said after a loop tool that only got something started. */
export const STILL_RUNNING = "(受理了,還沒完成;結果回來會再叫你)";

/** The tool message for a call of this round that is not the loop's. */
export function handedOver(tool: string): string {
  return tool === COMMIT_TOOL ? COMMITTED : HANDED_OVER;
}

/** The higher of two reasoning levels. */
export function higher(a: ReasoningLevel, b: ReasoningLevel): ReasoningLevel {
  return REASONING_LEVELS.indexOf(a) >= REASONING_LEVELS.indexOf(b) ? a : b;
}

/** What is asked, not just said: a question mark, a question word, a request to explain. */
const QUESTION =
  /[??]|[嗎呢]\s*$|為什麼|為何|怎麼|如何|什麼是|是什麼|差在哪|差別|比較|解釋|請問|教我|幫我(?:查|算|看|想)/;
/** Shorter than this is small talk (「你在幹嘛?」), not a question to think about. */
const QUESTION_CHARS = 12;

/** A message that asks her something worth thinking about (v4 §4.4: text replies, `low`). */
export function asksSeriously(text: string): boolean {
  const t = text.trim();
  return charCount(t) >= QUESTION_CHARS && QUESTION.test(t);
}

/** A sentence as compared for repeats: no tags, spaces or punctuation. */
function plain(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

/** Shorter than this, only the same sentence counts as a repeat (「好啊」 may be said twice). */
const REPEAT_CHARS = 4;

/**
 * `text` without the sentences she already said in an earlier round of the turn (`earlier`). The
 * model sees its own words in the transcript and still starts the next round with 「我查一下」
 * again; people would read or hear it twice.
 */
export function withoutRepeats(text: string, earlier: readonly string[]): string {
  const said = earlier.map(plain).filter((s) => s !== "");
  if (said.length === 0) return text;
  const all = said.join("\n");
  const parts = sentences(text);
  if (parts.length === 0) return text;
  return parts
    .filter((s) => {
      const p = plain(s);
      if (p === "") return true;
      return !(said.includes(p) || ([...p].length >= REPEAT_CHARS && all.includes(p)));
    })
    .join("");
}
