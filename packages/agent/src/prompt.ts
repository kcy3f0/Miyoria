// Prompt assembly, ordered for provider prefix caching: the stable persona prompt first, then
// the conversation history (which only grows at the end), and the per-turn situation (current
// time, addressing, mood, attitudes and the sections of prompt contributors) last.

import {
  assistantMessage,
  type ChatMessage,
  type ChatRole,
  systemMessage,
  userMessage,
} from "@miyoria/llm";
import type { ContextKey, PromptSection } from "@miyoria/types";
import type { HistoryEntry } from "./session.js";
import { charCount, utf8Len } from "./util.js";

export const SITUATION = `# 目前情境
- 現在時間:{time}
- 地點:{platform} 的{place}
- 最近在場的人:{present}
- {addressing}

# 規則
- 這是即時聊天,回覆要簡短自然,通常一到三句,除非有人認真問問題。
- 對話紀錄裡別人的訊息格式是「名字: 內容」;你自己的回覆直接寫內容,不要加名字前綴。
- 可以用 <emo:名稱> 標記情緒變化。
- 不需要或不想回的時候,只輸出 <silence/>。`;

export const ADDRESSED = "有人直接叫你、回覆你或私訊你,請回應對方。";
export const AMBIENT = "沒有人直接叫你。只有在你真的想插話時才開口,否則只輸出 <silence/>。";

export const VOICE_SITUATION = `# 目前情境
- 現在時間:{time}
- 地點:{platform} 的語音頻道 {channel},大家正在即時語音聊天
- 語音頻道裡的人:{present}
- {addressing}

# 規則
- 你說的話會直接用語音念出來。只說一到兩句簡短、口語的句子。
- 不要用 emoji、顏文字、markdown、列點或網址,只寫念得出來的文字。
- 對話紀錄裡別人說的話格式是「名字(語音): 內容」,是語音辨識的結果,可能有錯字;你自己的話直接寫內容,不要加名字前綴。
- 標著「(被打斷)」的是你講到一半被打斷的話。
- 可以用 <emo:名稱> 標記情緒變化。
- 不需要或不想開口的時候,只輸出 <silence/>。`;

export const INITIATIVE = "現在沒有人在跟你說話,是你自己想主動開啟話題。";
export const VOICE_INITIATIVE = "大家現在沒有在跟你說話,是你自己想主動用說的開個話題。";
export const INITIATIVE_HINT = "你想到可以聊的:";
export const INITIATIVE_SILENCE = "如果覺得現在不適合開口,只輸出 <silence/>。";

export const VOICE_ADDRESSED = "有人在叫你或問你問題,請用說的回應對方。";
export const VOICE_AMBIENT =
  "沒有人直接叫你,大家在聊天。只有在你真的想插一句話時才開口,否則只輸出 <silence/>。";

/** Appended to her speech that was cut off. */
export const INTERRUPTED = "(被打斷)";

const CHECK_SYSTEM =
  "你負責判斷聊天室裡的角色「{name}」現在要不要開口。" +
  "她不是每句都回;只有在話題跟她有關、有人似乎在等她回應、或她插話會自然有趣時才回。" +
  '只回傳 JSON:{"respond": true 或 false, "reason": "簡短理由"}';

const CHECK_USER = "最近的對話(最後幾則是最新的):\n{lines}\n\n{name} 要回應嗎?";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

export interface Situation {
  context: ContextKey;
  /**
   * Display names of people recently active, most recent first (in a voice channel: the
   * people in it).
   */
  present: readonly string[];
  direct: boolean;
  /** She starts the conversation on her own; what she might bring up (may be empty). */
  initiative: string | null;
  /** Extra lines under the situation (mood, attitudes towards people). */
  notes: readonly string[];
}

const HINT_ENDS = ["。", "!", "?", "!", "?", "."];

/**
 * The addressing line plus the notes, as `- ` list items (the template supplies the first
 * `- `).
 */
function addressing(s: Situation, voice: boolean): string {
  let out: string;
  if (s.initiative !== null) {
    out = voice ? VOICE_INITIATIVE : INITIATIVE;
    const hint = s.initiative.trim();
    if (hint !== "") {
      out += INITIATIVE_HINT + hint;
      if (!HINT_ENDS.some((end) => hint.endsWith(end))) out += "。";
    }
    out += INITIATIVE_SILENCE;
  } else if (voice) {
    out = s.direct ? VOICE_ADDRESSED : VOICE_AMBIENT;
  } else {
    out = s.direct ? ADDRESSED : AMBIENT;
  }
  for (const note of s.notes) {
    if (note.trim() === "") continue;
    out += `\n- ${note.trim()}`;
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The per-turn situation message. `now` is shown in the time zone `utcOffsetMinutes` east of
 * UTC (default: the local time zone, like Rust `Local::now()`).
 */
export function situationPrompt(
  s: Situation,
  now: Date,
  utcOffsetMinutes: number = -now.getTimezoneOffset(),
): string {
  const local = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  const weekday = WEEKDAYS[(local.getUTCDay() + 6) % 7];
  const time =
    `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ` +
    `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}(星期${weekday})`;
  const ctx = s.context;
  const place =
    ctx.kind === "dm"
      ? "私訊"
      : ctx.kind === "channel"
        ? `頻道 ${ctx.channel}`
        : ctx.kind === "thread"
          ? `討論串 ${ctx.channel}`
          : `語音頻道 ${ctx.channel}`;
  const present = s.present.length === 0 ? "(不清楚)" : s.present.join("、");
  const voice = ctx.kind === "voice";
  const template = voice ? VOICE_SITUATION : SITUATION;
  // `{addressing}` last: notes come from other modules and must not be treated as
  // placeholders.
  return template
    .replaceAll("{time}", () => time)
    .replaceAll("{platform}", () => ctx.platform)
    .replaceAll("{channel}", () => ctx.channel)
    .replaceAll("{place}", () => place)
    .replaceAll("{present}", () => present)
    .replaceAll("{addressing}", () => addressing(s, voice));
}

/**
 * Contributed sections as `## {title}\n{body}` blocks, lowest `order` first (ties by key), at
 * most `maxChars` characters in total. A section that does not fit is cut short and the rest is
 * dropped. `null` if nothing remains.
 */
export function renderSections(
  sections: readonly PromptSection[],
  maxChars: number,
): string | null {
  const sorted = sections
    .filter((s) => s.body.trim() !== "")
    .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let out = "";
  let used = 0;
  for (const section of sorted) {
    const sep = out === "" ? "" : "\n\n";
    const block = `${sep}## ${section.title.trim()}\n${section.body.trim()}`;
    const len = charCount(block);
    if (used + len <= maxChars) {
      out += block;
      used += len;
      continue;
    }
    const room = Math.max(maxChars - used, 0);
    // Only worth it if the heading and a bit of the body fit.
    const heading = charCount(sep) + charCount(section.title.trim()) + 4;
    if (room > heading + 20) {
      out += [...block].slice(0, room - 1).join("");
      out += "…";
    }
    break;
  }
  return out === "" ? null : out;
}

/**
 * `[persona, history..., situation]`. Her messages become `assistant`, everyone else's `user`
 * as `"{name}: {text}"` (`"{name}(語音): {text}"` when spoken); consecutive messages of the same
 * role are merged.
 */
export function buildMessages(
  persona: string,
  situation: string,
  history: Iterable<HistoryEntry>,
): ChatMessage[] {
  const tail: ChatMessage[] = [];
  for (const entry of history) {
    const role: ChatRole = entry.isSelf ? "assistant" : "user";
    const line = entry.isSelf ? ownLine(entry) : otherLine(entry);
    const last = tail.at(-1);
    if (last && last.role === role) {
      last.content += `\n${line}`;
    } else {
      tail.push(role === "assistant" ? assistantMessage(line) : userMessage(line));
    }
  }
  return [systemMessage(persona), ...tail, systemMessage(situation)];
}

/** Messages for the `fast` model's respond / stay-quiet check. */
export function checkMessages(name: string, history: Iterable<HistoryEntry>): ChatMessage[] {
  const lines: string[] = [];
  for (const e of history) {
    lines.push(e.isSelf ? `${name}(她自己): ${ownLine(e)}` : otherLine(e));
  }
  return [
    systemMessage(CHECK_SYSTEM.replaceAll("{name}", () => name)),
    userMessage(
      CHECK_USER.replaceAll("{lines}", () => lines.join("\n")).replaceAll("{name}", () => name),
    ),
  ];
}

/**
 * A history entry as one transcript line (`"{name}: {text}"`), for prompt contributors;
 * `name` is hers.
 */
export function transcriptLine(entry: HistoryEntry, name: string): string {
  return entry.isSelf ? `${name}: ${ownLine(entry)}` : otherLine(entry);
}

function ownLine(entry: HistoryEntry): string {
  return entry.interrupted ? `${entry.text}${INTERRUPTED}` : entry.text;
}

function otherLine(entry: HistoryEntry): string {
  return entry.spoken ? `${entry.author}(語音): ${entry.text}` : `${entry.author}: ${entry.text}`;
}

function asciiEqualIgnoreCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x >= 65 && x <= 90) x += 32;
    if (y >= 65 && y <= 90) y += 32;
    if (x !== y) return false;
  }
  return true;
}

/** Removes a leading `"{her name}:"` the model may copy from the history format. */
export function cleanReply(text: string, names: readonly string[]): string {
  let t = text.trim();
  for (const name of names) {
    if (utf8Len(t) < utf8Len(name)) continue;
    const head = t.slice(0, name.length);
    if (!asciiEqualIgnoreCase(head, name)) continue;
    const rest = t.slice(name.length).trimStart();
    if (rest.startsWith(":")) {
      t = rest.slice(1).trimStart();
      break;
    }
  }
  return t.trim();
}

const CUT_SETS: readonly (readonly string[])[] = [
  ["\n"],
  ["。", "!", "?", "!", "?", ".", "…"],
  [" ", ","],
];

/**
 * Splits `text` into chunks of at most `maxChars` characters, preferring line breaks, then
 * sentence ends, then spaces.
 */
export function splitMessage(text: string, maxChars: number): string[] {
  const max = Math.max(maxChars, 1);
  const out: string[] = [];
  let rest = [...text.trim()];
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // Byte offsets, like the Rust implementation (`min` is half the window's bytes).
    const offsets: number[] = [];
    let bytes = 0;
    for (const c of window) {
      offsets.push(bytes);
      bytes += utf8Len(c);
    }
    const min = Math.floor(bytes / 2);
    let cut = window.length;
    outer: for (const set of CUT_SETS) {
      for (let i = window.length - 1; i >= 0; i--) {
        if (set.includes(window[i] as string) && (offsets[i] as number) >= min) {
          cut = i + 1;
          break outer;
        }
      }
    }
    const chunk = rest.slice(0, cut).join("").trim();
    if (chunk !== "") out.push(chunk);
    rest = [...rest.slice(cut).join("").trimStart()];
  }
  const last = rest.join("");
  if (last !== "") out.push(last);
  return out;
}
