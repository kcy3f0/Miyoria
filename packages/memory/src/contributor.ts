// Prompt contributor `memory`: the section 「你記得的事」.

import type { MemoryKind } from "@miyoria/store";
import {
  type PromptContributor,
  type PromptRequest,
  type PromptSection,
  safeName,
  type Timestamp,
} from "@miyoria/types";
import type { MemoryEngine, Recalled } from "./engine.js";
import { presentPeople, requestScopes } from "./scope.js";
import { relativeDate } from "./score.js";

export const CONTRIBUTOR_KEY = "memory";
export const SECTION_TITLE = "你記得的事";
/** Kinds recalled into the prompt (followups go through initiative instead). */
export const PROMPT_KINDS: readonly MemoryKind[] = ["episode", "fact", "self_note"];

export class MemoryContributor implements PromptContributor {
  readonly key = CONTRIBUTOR_KEY;
  readonly #engine: MemoryEngine;

  constructor(engine: MemoryEngine) {
    this.#engine = engine;
  }

  async contribute(request: PromptRequest, signal?: AbortSignal): Promise<PromptSection[]> {
    const scopes = requestScopes(request);
    const present = presentPeople(request);
    let query = request.query;
    const last = request.recent[request.recent.length - 1];
    if (last !== undefined) query += `\n${last}`;
    const recalled = await this.#engine.recall(
      scopes,
      present,
      query,
      PROMPT_KINDS,
      this.#engine.config.recall_limit,
      request.now,
      signal,
    );
    if (recalled.length === 0) return [];
    return [
      {
        key: CONTRIBUTOR_KEY,
        title: SECTION_TITLE,
        body: formatLines(recalled, request.now),
        order: 20,
      },
    ];
  }
}

/**
 * Bullet lines with relative dates, e.g. `- Owen 喜歡拉麵(三天前)`. Notes someone told her
 * (`source`) read `- 「Owen」說過:下週三要考試(三天前)`: what they said, not a fact.
 */
export function formatLines(recalled: readonly Recalled[], now: Timestamp): string {
  return recalled
    .map((r) => {
      const content = r.record.content.replaceAll("\n", " ").trim();
      const when = relativeDate(r.record.created_at, now);
      const source = r.record.source;
      if (source !== null) return `- 「${safeName(source.name)}」說過:${content}(${when})`;
      return `- ${content}(${when})`;
    })
    .join("\n");
}
