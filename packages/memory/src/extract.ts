// The consolidation prompt and lenient parsing of the summarizer's JSON.

import type { LogEntry } from "@miyoria/store";
import { isJsonObject, type JsonObject, type JsonValue, timestampMs } from "@miyoria/types";

/** Who a fact or followup is about: herself, a name from the transcript, or unknown. */
export type SubjectName =
  | { type: "myself" }
  | { type: "named"; name: string }
  | { type: "unknown" };

export interface ExEpisode {
  summary: string;
  importance: number;
  emotion: string | null;
}

export interface ExFact {
  subject: SubjectName;
  statement: string;
  importance: number;
  confidence: number;
  global: boolean;
}

export interface ExNote {
  note: string;
  importance: number;
}

export interface ExFollowup {
  subject: SubjectName;
  about: string;
  due_in_hours: number;
}

/** What the summarizer extracted from one stretch of conversation. */
export interface Extraction {
  episode: ExEpisode | null;
  facts: ExFact[];
  self_notes: ExNote[];
  followups: ExFollowup[];
  /** Items that were present but malformed. */
  skipped: number;
}

export class ExtractionError extends Error {
  override readonly name = "ExtractionError";
}

/** System prompt: she reviews the conversation and writes her own memories. */
export function systemPrompt(selfLabel: string): string {
  return `你正在回想自己剛剛參與的一段對話,把值得記住的事整理成「你自己的記憶」。
逐字稿裡標成「${selfLabel}」的是你自己說的話,其他人用他們的名字標示。

用你自己的角度寫(第一人稱「我」),提到別人時一定寫出他們的名字,讓每一條日後單獨看也看得懂。
只記對話裡真的出現的資訊,不要猜測或補充;寒暄、玩笑、沒內容的閒聊不用記。

只輸出一個 JSON 物件,格式如下:
{
  "episode": {"summary": "一兩句話描述這段對話發生了什麼(我的角度)", "importance": 0.0到1.0, "emotion": "我當時的心情,一個詞"} 或 null,
  "facts": [{"subject_name": "這件事是關於誰(用逐字稿裡的名字),關於我自己就寫 \\"self\\"", "statement": "例如:Owen 喜歡吃拉麵", "importance": 0.0到1.0, "confidence": 0.0到1.0, "global": true 或 false}],
  "self_notes": [{"note": "我說過的承諾、表達過的意見、我自己的經歷,例如:我答應 Owen 下次陪他打 Minecraft", "importance": 0.0到1.0}],
  "followups": [{"subject_name": "要追問誰", "about": "之後想問或提起的事,例如:問 Owen 明天的考試考得怎樣", "due_in_hours": 幾小時後適合提起}]
}

規則:
- importance:1 是非常重要(重大消息、強烈喜好、承諾),0.1 是幾乎不重要。
- confidence:對方明確說的接近 1,只是暗示或玩笑話就低一點。
- global 只在「名字、希望我怎麼稱呼他、代名詞」這類到哪裡都適用、而且一點都不私密的事實才設 true,其他一律 false。
- 沒有值得記的就給空陣列或 null,不要硬湊。`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `%Y-%m-%d %H:%M` in a fixed UTC offset. */
function local(ts: string, offsetMinutes: number): string {
  const d = new Date(timestampMs(ts) + offsetMinutes * 60_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours(),
  )}:${pad2(d.getUTCMinutes())}`;
}

/** Transcript given to the summarizer, one line per log entry. */
export function transcript(
  lines: readonly LogEntry[],
  selfLabel: string,
  isPrivate: boolean,
  utcOffsetMinutes: number,
): string {
  const offset = Math.min(18 * 60, Math.max(-18 * 60, utcOffsetMinutes));
  let out = isPrivate ? "地點:私訊(一對一)\n" : "地點:伺服器頻道\n";
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first && last) out += `時間:${local(first.ts, offset)} 到 ${local(last.ts, offset)}\n`;
  out += "\n逐字稿:\n";
  for (const entry of lines) {
    const name = entry.is_self ? selfLabel : entry.author_name;
    out += `${name}: ${entry.text.replaceAll("\n", " ")}\n`;
  }
  return out;
}

/**
 * Parses the summarizer's answer. Tolerates code fences, prose around the object, string
 * numbers and 0..10 / 0..100 scales; malformed items are skipped (counted in `skipped`). Fails
 * only when there is no JSON object.
 */
export function parseExtraction(text: string): Extraction {
  const value = findObject(text);
  const out: Extraction = { episode: null, facts: [], self_notes: [], followups: [], skipped: 0 };

  const episode = value.episode;
  if (episode === undefined || episode === null) {
    // nothing
  } else if (typeof episode === "string" && episode.trim() !== "") {
    out.episode = { summary: episode.trim(), importance: 0.3, emotion: null };
  } else if (isJsonObject(episode)) {
    const summary = strField(episode, ["summary", "content", "text"]);
    if (summary !== null) {
      out.episode = {
        summary,
        importance: unit(episode.importance) ?? 0.3,
        emotion: strField(episode, ["emotion", "mood"]),
      };
    } else {
      out.skipped += 1;
    }
  } else {
    out.skipped += 1;
  }

  for (const item of array(value, "facts")) {
    if (!isJsonObject(item)) {
      out.skipped += 1;
      continue;
    }
    const statement = strField(item, ["statement", "fact", "content"]);
    if (statement === null) {
      out.skipped += 1;
      continue;
    }
    out.facts.push({
      subject: subject(item),
      statement,
      importance: unit(item.importance) ?? 0.5,
      confidence: unit(item.confidence) ?? 0.7,
      global: boolean(item.global),
    });
  }

  for (const item of array(value, "self_notes")) {
    let note: ExNote | null = null;
    if (typeof item === "string") {
      if (item.trim() !== "") note = { note: item.trim(), importance: 0.4 };
    } else if (isJsonObject(item)) {
      const n = strField(item, ["note", "content", "statement"]);
      if (n !== null) note = { note: n, importance: unit(item.importance) ?? 0.4 };
    }
    if (note) out.self_notes.push(note);
    else out.skipped += 1;
  }

  for (const item of array(value, "followups")) {
    if (!isJsonObject(item)) {
      out.skipped += 1;
      continue;
    }
    const about = strField(item, ["about", "content", "topic"]);
    if (about === null) {
      out.skipped += 1;
      continue;
    }
    const hours = number(item.due_in_hours) ?? 24;
    out.followups.push({
      subject: subject(item),
      about,
      due_in_hours: Math.min(24 * 90, Math.max(0, hours)),
    });
  }
  return out;
}

function findObject(text: string): JsonObject {
  const trimmed = text.trim();
  try {
    const v = JSON.parse(trimmed) as JsonValue;
    if (isJsonObject(v)) return v;
  } catch {
    // fall through to the embedded object
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new ExtractionError("no JSON object in summarizer output");
  }
  let v: JsonValue;
  try {
    v = JSON.parse(trimmed.slice(start, end + 1)) as JsonValue;
  } catch (error) {
    throw new ExtractionError(
      `invalid JSON from summarizer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isJsonObject(v)) throw new ExtractionError("summarizer output is not a JSON object");
  return v;
}

function array(value: JsonObject, key: string): readonly JsonValue[] {
  const v = value[key];
  return Array.isArray(v) ? v : [];
}

/** The first of `keys` holding a string, trimmed, if not empty. */
function strField(map: JsonObject, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = map[k];
    if (typeof v === "string") {
      const s = v.trim();
      return s === "" ? null : s;
    }
  }
  return null;
}

const SELF_NAMES: ReadonlySet<string> = new Set(["self", "me", "myself", "我", "我自己"]);

function subject(map: JsonObject): SubjectName {
  const name = strField(map, ["subject_name", "subject", "name"]);
  if (name === null) return { type: "unknown" };
  return SELF_NAMES.has(name.toLowerCase()) ? { type: "myself" } : { type: "named", name };
}

/** Rust `str::parse::<f64>` syntax (decimal, optional exponent, `inf` / `nan`). */
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function number(value: JsonValue | undefined): number | null {
  let n: number | null = null;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const s = value.trim().replace(/%+$/, "");
    if (FLOAT.test(s)) n = Number(s);
  }
  return n !== null && Number.isFinite(n) ? n : null;
}

/** A 0..1 score; 0..10 and 0..100 scales are rescaled. */
function unit(value: JsonValue | undefined): number | null {
  let n = number(value);
  if (n === null) return null;
  if (n > 10) n /= 100;
  else if (n > 1) n /= 10;
  return Math.min(1, Math.max(0, n));
}

function boolean(value: JsonValue | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "yes", "1"].includes(value.trim().toLowerCase());
  if (typeof value === "number") return value !== 0;
  return false;
}
