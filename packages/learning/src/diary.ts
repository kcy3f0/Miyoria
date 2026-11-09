// Her diary: after the daily reflection she writes a short entry about her day in her own voice
// and posts it to `[modules.reflect.diary] channel` (off while it is empty).
//
// The entry is written from what the reflection already put in her words (its summary, what she
// felt, what she learned), never from raw chat. Those can come from DMs and private talk, so the
// rules forbid naming what was said in private and the post goes through the platform sink, which
// runs moderation like every other line of hers; the owner chooses the channel.

import { errorMessage, getLogger } from "@miyoria/kernel";
import { type LlmRouter, systemMessage, userMessage, withLlmTag } from "@miyoria/llm";
import {
  type ContextKey,
  characterCore,
  type PlatformSinks,
  type ReflectionRun,
} from "@miyoria/types";
import type { DiaryConfig } from "./config.js";
import { parseContextString } from "./reflect.js";

const log = getLogger("learning.diary");

/** How long writing may take. */
const WRITE_TIMEOUT_MS = 60_000;

/** The rules of an entry. */
export function diaryRules(maxChars: number): string {
  return `你要寫今天的日記,會公開貼在大家看得到的頻道。
- 用第一人稱、你平常說話的口吻,像真的在寫日記,${maxChars} 字以內,可以分兩三段。
- 寫今天發生的事、你的心情、想記住的小事;可以提到大家知道的名字。
- 私訊裡說的事、別人的秘密或隱私、任何你不確定能公開的事都不要寫。
- 不寫數字分數,不提「反省」「系統」「模型」「提示詞」這類字眼,不要寫標題或日期。
- 只回日記本文。`;
}

/** What the reflection said, as the entry's material. */
export function diaryMaterial(run: ReflectionRun): string {
  const lines = [`今天的回顧:${run.summary.trim()}`];
  if (run.feelings.length > 0) lines.push(`心情:${run.feelings.join("、")}`);
  if (run.lessons.length > 0) lines.push(`學到的事:${run.lessons.join("、")}`);
  if (run.goals.length > 0) lines.push(`接下來想做的:${run.goals.join("、")}`);
  return lines.join("\n");
}

/** The entry cut to `maxChars` (at a sentence end when there is one in the last third). */
export function fitEntry(text: string, maxChars: number): string {
  const clean = text.replace(/^["「『]+|["」』]+$/g, "").trim();
  const chars = [...clean];
  if (chars.length <= maxChars) return clean;
  const cut = chars.slice(0, maxChars).join("");
  const end = Math.max(...["。", "!", "?", "!", "?", "~", "…"].map((p) => cut.lastIndexOf(p)));
  return end >= Math.floor(cut.length * 0.66) ? cut.slice(0, end + 1) : `${cut}…`;
}

export interface DiaryDeps {
  router: () => LlmRouter | undefined;
  sinks: () => PlatformSinks | undefined;
  /** Her persona prompt (its character core is used). */
  persona: () => string;
  name: string;
}

/** Writes and posts the entry of a daily reflection. */
export class Diary {
  #lastDay: string | null = null;

  constructor(
    private readonly config: DiaryConfig,
    private readonly d: DiaryDeps,
  ) {}

  /** The channel entries go to, or `null` when the diary is off. */
  where(): ContextKey | null {
    const raw = this.config.channel.trim();
    return raw === "" ? null : parseContextString(raw);
  }

  /** Writes and posts the entry for `run`; returns the text posted, or `null`. */
  async write(run: ReflectionRun, signal?: AbortSignal): Promise<string | null> {
    const where = this.where();
    if (where === null || run.kind !== "daily" || run.error !== null) return null;
    if (run.summary.trim() === "") return null;
    const day = run.at.slice(0, 10);
    if (this.#lastDay === day) return null;
    const router = this.d.router();
    const sink = this.d.sinks()?.get(where.platform);
    if (!router || !sink) return null;
    const who = characterCore(this.d.persona()) || `你是${this.d.name}。`;
    try {
      const timeout = AbortSignal.timeout(WRITE_TIMEOUT_MS);
      const response = await withLlmTag({ module: "learning", label: "diary" }, () =>
        router.complete(
          "chat",
          {
            messages: [
              systemMessage(`${who}\n\n${diaryRules(this.config.max_chars)}`),
              userMessage(diaryMaterial(run)),
            ],
            reasoning_purpose: "diary",
            max_tokens: 800,
          },
          signal ? AbortSignal.any([signal, timeout]) : timeout,
        ),
      );
      const entry = fitEntry(response.text, this.config.max_chars);
      if (entry === "") return null;
      const text = this.config.heading ? `${this.config.heading}\n${entry}` : entry;
      // Unprompted: posted without a notification (`proactive`, see the Discord sink).
      const message = { text, reply_to: null, proactive: true };
      const sent = await sink.send(where, message, signal);
      if (sent.blocked) log.info({ blocked: sent.blocked }, "moderation changed her diary entry");
      this.#lastDay = day;
      return text;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "she could not write her diary");
      return null;
    }
  }
}
