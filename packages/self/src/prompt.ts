import type {
  DriveName,
  PromptContributor,
  PromptRequest,
  PromptSection,
  SelfState,
} from "@miyoria/types";

/** How a strong drive reads in the prompt. */
const WANTS: Record<DriveName, string> = {
  social: "很想跟人聊天",
  play: "很想玩遊戲",
  attention: "很想被大家注意",
  rest: "想休息",
  curiosity: "想做點新鮮的事",
};

/** Drives at or above this are mentioned. */
const STRONG = 0.65;
const MAX_AGENDA = 3;
const MAX_FEELINGS = 4;
const MAX_FEELING_CHARS = 80;

function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

function clock(ts: string, offsetMinutes: number): string {
  const d = new Date(Date.parse(ts) + offsetMinutes * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * Prompt contributor `self`: her boredom and strong drives, the talkativeness she set for this
 * place, open agenda items and her feelings about the people present. Her own state, kept short.
 */
export class SelfPrompt implements PromptContributor {
  static readonly KEY = "self";
  readonly key = SelfPrompt.KEY;

  constructor(
    private readonly self: SelfState,
    private readonly utcOffsetMinutes = 8 * 60,
  ) {}

  async contribute(request: PromptRequest): Promise<PromptSection[]> {
    const body = this.describe(request);
    if (body === "") return [];
    return [{ key: SelfPrompt.KEY, title: "你的內在", body, order: 35 }];
  }

  describe(request: PromptRequest): string {
    const lines: string[] = [];
    const snap = this.self.snapshot();
    const feel: string[] = [];
    if (snap.boredom >= 0.7) feel.push("很無聊");
    else if (snap.boredom >= 0.45) feel.push("有點無聊");
    const strong = (Object.entries(snap.drives) as [DriveName, number][])
      .filter(([, v]) => v >= STRONG)
      .sort((a, b) => b[1] - a[1]);
    for (const [name] of strong) feel.push(WANTS[name]);
    if (feel.length > 0) lines.push(`你現在${feel.join("、")}。`);

    const talk = this.self.talkativeness(request.context);
    if (talk) {
      const level =
        talk.level >= 0.7 ? "想多聊一點" : talk.level <= 0.3 ? "想安靜一點" : "照平常聊";
      const until = talk.until ? `,到 ${clock(talk.until, this.utcOffsetMinutes)}` : "";
      const why = talk.why ? `(${short(talk.why, 60)})` : "";
      lines.push(`你給自己定的方針:在這裡${level}${why}${until}。`);
    }

    const now = Date.parse(snap.at);
    const agenda = this.self
      .agenda()
      .filter((a) => a.due === null || Date.parse(a.due) <= now)
      .slice(0, MAX_AGENDA);
    if (agenda.length > 0) {
      lines.push("你打算做的事:");
      for (const a of agenda) lines.push(`- ${short(a.text, 80)}`);
    }

    const feelings: string[] = [];
    const seen = new Set<string>();
    for (const p of request.participants) {
      if (feelings.length >= MAX_FEELINGS) break;
      if (p.person === null || seen.has(p.person)) continue;
      seen.add(p.person);
      const f = this.self.feeling(p.person);
      if (f) feelings.push(`- ${short(p.display_name, 24)}:${short(f.text, MAX_FEELING_CHARS)}`);
    }
    if (feelings.length > 0) lines.push("你對在場的人的感覺:", ...feelings);
    if (lines.length === 0) return "";
    lines.push("(這是你自己的狀態,自然地影響語氣就好,不用說出來。)");
    return lines.join("\n");
  }
}
