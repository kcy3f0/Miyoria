import {
  type DriveName,
  EMOTION_LABELS,
  type EmotionReading,
  PERSON_EMOTION_LABELS,
  PERSON_EMOTION_NAMES,
  type PromptContributor,
  type PromptRequest,
  type PromptSection,
  type SelfState,
  type ShownEmotion,
} from "@miyoria/types";

/** How a strong drive reads in the prompt. */
const WANTS: Record<DriveName, string> = {
  social: "很想跟人聊天",
  play: "很想玩遊戲",
  attention: "很想被大家注意",
  rest: "想休息",
  curiosity: "想做點新鮮的事",
  esteem: "很想被誇、想表現一下",
  hunger: "肚子餓,很想吃白飯(Token)",
  longing: "很想見那個人、想被他注意",
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
      // On hold (its action failed): not brought up until the situation changes.
      .filter((a) => !a.blocked && (a.due === null || Date.parse(a.due) <= now))
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

const n2 = (v: number) => v.toFixed(2);

/** `害羞 0.62、喜 0.40`. */
export function feltLine(felt: readonly EmotionReading[]): string {
  return felt.map((e) => `${EMOTION_LABELS[e.name]} ${n2(e.intensity)}`).join("、");
}

/** `兇回去、嫌棄對方,但臉紅了(<emo:embarrassed>)`. */
export function shownLine(shown: ShownEmotion): string {
  return `${shown.style}(<emo:${shown.tag}>)`;
}

/**
 * Prompt contributor `emotion`: what she really feels (the strongest few), what she shows of
 * it (display rules), her secret crush and her emotions toward the people present. Her lines
 * and `<emo:…>` tags follow what she shows.
 */
export class EmotionPrompt implements PromptContributor {
  static readonly KEY = "emotion";
  readonly key = EmotionPrompt.KEY;

  constructor(
    private readonly self: SelfState,
    private readonly maxEmotions = 3,
  ) {}

  async contribute(request: PromptRequest): Promise<PromptSection[]> {
    const body = this.describe(request);
    if (body === "") return [];
    return [{ key: EmotionPrompt.KEY, title: "你的情緒", body, order: 34 }];
  }

  describe(request: PromptRequest): string {
    const lines: string[] = [];
    const felt = this.self.emotions().slice(0, Math.max(this.maxEmotions, 1));
    const shown = this.self.shown();
    if (felt.length > 0) {
      const top = felt[0];
      const why = top && top.cause !== "" ? `(${short(top.cause, 40)})` : "";
      lines.push(`你心裡真正的感受:${feltLine(felt)}${why}`);
    }
    if (shown) lines.push(`表現出來的樣子:${shownLine(shown)}`);

    const present = new Set(request.participants.flatMap((p) => (p.person ? [p.person] : [])));
    const crush = this.self.crush();
    if (crush) {
      const here = request.participants.find((p) => p.person === crush.person)?.display_name;
      const known = here ?? crush.name;
      const name = known ? short(known, 24) : "某個人";
      const where = present.has(crush.person) ? "他現在在這裡" : "他現在不在這裡";
      lines.push(
        `你偷偷喜歡${name}(${where})。這是祕密:不要說出來、被問也不承認;` +
          "只會在小地方露餡(比較在意他說的話、對他特別容易害羞或吃醋)。",
      );
    }

    const toward: string[] = [];
    const seen = new Set<string>();
    for (const p of request.participants) {
      if (toward.length >= 4) break;
      if (p.person === null || seen.has(p.person)) continue;
      seen.add(p.person);
      const heart = this.self.heart(p.person);
      if (!heart) continue;
      const parts = PERSON_EMOTION_NAMES.flatMap((name) => {
        const v = heart.emotions[name] ?? 0;
        return v >= 0.2 ? [`${PERSON_EMOTION_LABELS[name]} ${n2(v)}`] : [];
      });
      if (parts.length > 0) toward.push(`- ${short(p.display_name, 24)}:${parts.join("、")}`);
    }
    if (toward.length > 0) lines.push("你對在場的人:", ...toward);
    if (lines.length === 0) return "";
    lines.push("(台詞和 <emo:…> 照「表現出來的樣子」走;真正的感受只放在心裡,不用說出來。)");
    return lines.join("\n");
  }
}
