import type { PromptContributor, PromptRequest, PromptSection } from "@miyoria/types";
import type { Social } from "./engine.js";

/**
 * Prompt contributor `social`: the `在場的人` section (name, label, call name, tags, short
 * notes). Answers from memory.
 */
export class SocialPrompt implements PromptContributor {
  static readonly KEY = "social";
  readonly key = SocialPrompt.KEY;
  readonly #social: Social;

  constructor(social: Social) {
    this.#social = social;
  }

  async contribute(request: PromptRequest): Promise<PromptSection[]> {
    const lines = this.#social.describePeople(request.participants, request.speakers);
    if (lines.length === 0) return [];
    return [
      {
        key: SocialPrompt.KEY,
        title: "在場的人",
        body: `${lines.join("\n")}\n(標籤與印象只是參考,不要把這些資訊直接念出來。)`,
        order: 20,
      },
    ];
  }
}
