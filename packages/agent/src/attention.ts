// Attention: should she respond to this turn?
//
// Layer 1 are hard rules (channel mode, direct address, anti-spam share, cooldown), layer 2 a
// cheap salience score. Layer 3, the optional `fast` LLM check for ambient gray-zone turns, runs
// in the turn itself.
//
// Social signals scale the reply probability by how much she likes the speakers (direct
// address is only ignored at very low affinity), and her energy scales the ambient probability
// and cooldown a little.
//
// How eager she is to join in is her own choice: the talkativeness she set for the context
// (`SelfState`, docs/design/autonomy.md §6) scales the ambient probability, the cooldown, the
// gray-zone thresholds and how much she joins in while someone in voice is still talking.
// Without one, the configured activeness and voice numbers apply as before. The hard limits
// stay config: her maximum share of recent messages and a minimum cooldown.
//
// Voice turns add `VoiceAttention`: a question right after she spoke addresses her, she never
// joins in while someone is speaking and ambient probabilities are scaled down.

import { type IncomingMessage, type Mood, timestampMs } from "@miyoria/types";
import {
  type Activeness,
  type AttentionConfig,
  type ChannelMode,
  cooldownFactor,
  probabilityFactor,
} from "./config.js";
import type { Session } from "./session.js";
import {
  affinityAmbientFactor,
  affinityDirectFactor,
  energyCooldownFactor,
  energyProbabilityFactor,
  IGNORE_DIRECT_AFFINITY,
} from "./signals.js";
import {
  accountId,
  fixed,
  isAlphanumeric,
  isAsciiAlphanumeric,
  isWhitespace,
  signed,
} from "./util.js";

/** Source of uniform randomness in `[0, 1)` for the final decision. */
export interface RandomSource {
  nextF32(): number;
}

const MASK64 = (1n << 64n) - 1n;

/** Small deterministic generator (SplitMix64), identical to the Rust one. */
export class SeededRandom implements RandomSource {
  #state: bigint;

  /** `seed` is a u64 (number or bigint). */
  constructor(seed: number | bigint) {
    this.#state = BigInt(seed) & MASK64;
  }

  static fromEntropy(): SeededRandom {
    const nanos = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
    return new SeededRandom((nanos ^ 0x9e37_79b9_7f4a_7c15n) & MASK64);
  }

  nextF32(): number {
    this.#state = (this.#state + 0x9e37_79b9_7f4a_7c15n) & MASK64;
    let z = this.#state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK64;
    z ^= z >> 31n;
    return Number(z >> 40n) / (1 << 24);
  }
}

/** What layers 1 and 2 concluded. */
export type Gate =
  | { kind: "ignore" }
  /** Respond with this probability. */
  | { kind: "sample"; probability: number }
  /** Gray zone: ask the `fast` model, otherwise sample with the score. */
  | { kind: "ask_llm" };

export interface Assessment {
  direct: boolean;
  score: number;
  gate: Gate;
  reasons: string[];
  /**
   * Multiplier for ambient probabilities decided later (after the LLM check): activeness,
   * voice factor, affinity and energy.
   */
  ambientScale: number;
}

/** Extra rules for voice contexts. */
export interface VoiceAttention {
  /** Someone other than her is speaking right now. */
  someoneSpeaking: boolean;
  /** Multiplies the ambient reply probability. */
  ambientFactor: number;
  /** A question this soon (ms) after she spoke addresses her. */
  questionWindowMs: number;
  /** Multiplies the ambient probability while someone speaks; 0 = never join in over them. */
  interruptScale: number;
  /** People in the voice channel besides her (`null` = unknown). */
  others: number | null;
}

/** The talkativeness she set for a context (0 = silent, 0.5 = as usual, 1 = very chatty). */
export interface TalkLevel {
  level: number;
  /** The scope it was set for (for the decision trace). */
  scope: string;
}

/** At or below this talkativeness she does not join in at all. */
export const SILENT_TALKATIVENESS = 0.05;

/** Ambient probability multiplier of a talkativeness: ×0.25 at 0, ×1 at 0.5, ×4 at 1. */
export function talkFactor(level: number): number {
  return 4 ** (2 * clamp01(level) - 1);
}

/** Cooldown multiplier: ×4 at 0, ×1 at 0.5, ×0.25 at 1. */
export function talkCooldownFactor(level: number): number {
  return 4 ** (1 - 2 * clamp01(level));
}

/** Gray-zone threshold multiplier: ×2 at 0, ×1 at 0.5, ×0.5 at 1. */
export function talkThresholdFactor(level: number): number {
  return 2 ** (1 - 2 * clamp01(level));
}

/** Ambient multiplier while someone else in voice is still talking: 0.2 at 0 → 0.8 at 1. */
export function talkInterruptScale(level: number): number {
  return 0.2 + 0.6 * clamp01(level);
}

export interface AttentionInput {
  config: AttentionConfig;
  mode: ChannelMode;
  /** Scales the ambient reply probability and cooldown (when `talkativeness` is `null`). */
  activeness: Activeness;
  /**
   * Her own talkativeness for this context; replaces `activeness` and the voice ambient
   * factor and interrupt scale. `null`: she set none.
   */
  talkativeness?: TalkLevel | null;
  names: readonly string[];
  /** The profile's interests; matched like `config.keywords`. */
  interests: readonly string[];
  maxShare: number;
  session: Session;
  /** The messages that make up this turn (already in the session history). */
  inputs: readonly IncomingMessage[];
  /** Epoch ms. */
  now: number;
  /** Set for voice contexts. */
  voice: VoiceAttention | null;
  /** Mean affinity of the turn's speakers, if social signals are available. */
  affinity: number | null;
  /** Her mood, if mood signals are available. */
  mood: Mood | null;
}

function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

/**
 * Multiplier for ambient probabilities: her talkativeness (or activeness and the voice
 * factor), affinity and energy.
 */
export function ambientScale(input: AttentionInput): number {
  const affinity = input.affinity === null ? 1 : affinityAmbientFactor(input.affinity);
  const energy = input.mood === null ? 1 : energyProbabilityFactor(input.mood);
  const talk = input.talkativeness ?? null;
  if (talk !== null) {
    const speaking = input.voice?.someoneSpeaking ? talkInterruptScale(talk.level) : 1;
    return talkFactor(talk.level) * speaking * affinity * energy;
  }
  const voice = input.voice
    ? input.voice.ambientFactor * (input.voice.someoneSpeaking ? input.voice.interruptScale : 1)
    : 1;
  return probabilityFactor(input.activeness) * voice * affinity * energy;
}

/**
 * Minimum time (ms) between her ambient replies: the base cooldown scaled by her talkativeness
 * (never below `minMs`) or by activeness, and by her energy.
 */
export function ambientCooldown(
  baseMs: number,
  minMs: number,
  activeness: Activeness,
  talk: TalkLevel | null,
  mood: Mood | null,
): number {
  const energy = mood === null ? 1 : energyCooldownFactor(mood);
  if (talk === null) return Math.trunc(baseMs * cooldownFactor(activeness) * energy);
  return Math.max(Math.trunc(baseMs * talkCooldownFactor(talk.level) * energy), minMs);
}

/** Ambient probability after `ambientScale`, clamped. */
export function ambientProbability(input: AttentionInput, p: number): number {
  return clamp01(p * ambientScale(input));
}

/** Reply probability when directly addressed (scaled slightly by affinity). */
function directProbability(input: AttentionInput): number {
  const factor = input.affinity === null ? 1 : affinityDirectFactor(input.affinity);
  return clamp01(input.config.direct_probability * factor);
}

/** Why a message addresses her directly, if it does. */
export function directReason(msg: IncomingMessage, names: readonly string[]): string | null {
  const kind = msg.id.context.kind;
  if (kind === "dm") return "dm";
  if (msg.mentions_self) return "mention";
  if (msg.reply_to_self) return "reply";
  // Transcripts space and punctuate names arbitrarily ("deep seek chan"), so voice compares
  // letters and digits only.
  const voice = kind === "voice";
  const normalize = (s: string): string => {
    const lower = s.toLowerCase();
    return voice ? [...lower].filter(isAlphanumeric).join("") : lower;
  };
  const text = normalize(msg.text);
  const found = names.find((n) => {
    const name = normalize(n);
    return name !== "" && text.includes(name);
  });
  if (found !== undefined) return `name \`${found}\``;
  const heard = voice ? vocativeName(msg.text, names) : null;
  return heard === null ? null : `name \`${heard.name}\` (heard \`${heard.word}\`)`;
}

/**
 * Speech recognition mangles short English names ("miyo" → "mo", "meo"). A Latin word that
 * opens an utterance on its own ("mo,你好", "meo 你在嗎") and sounds like one of her Latin names —
 * same first letter, at most two letters off — is taken as calling her. Only the opening word,
 * so "mode" or "more" inside a sentence never counts.
 */
export function vocativeName(
  text: string,
  names: readonly string[],
): { name: string; word: string } | null {
  const m = /^\s*([a-z]{2,10})(?=[\s,，、.。!！?？~～]|$)/i.exec(text);
  const word = m?.[1]?.toLowerCase();
  if (word === undefined) return null;
  for (const n of names) {
    const name = n.toLowerCase();
    if (!/^[a-z]{3,12}$/.test(name) || name[0] !== word[0]) continue;
    if (Math.abs(name.length - word.length) > 2) continue;
    if (editDistance(word, name) <= Math.min(2, name.length - 2)) return { name: n, word };
  }
  return null;
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/** A question asked within the voice question window after she spoke. */
function questionAfterHer(input: AttentionInput): string | null {
  const voice = input.voice;
  if (voice === null) return null;
  const last = input.session.lastSelfAt();
  if (last === null) return null;
  const hit = input.inputs
    .filter((m) => isQuestion(m.text.toLowerCase()))
    .some((m) => {
      const gap = timestampMs(m.ts) - last;
      return gap >= -voice.questionWindowMs && gap <= voice.questionWindowMs;
    });
  return hit ? "question right after she spoke" : null;
}

export function assess(input: AttentionInput): Assessment {
  const cfg = input.config;
  const reasons = [`mode ${input.mode}`];
  let why: string | null = null;
  for (const m of input.inputs) {
    why = directReason(m, input.names);
    if (why !== null) break;
  }
  why ??= questionAfterHer(input);
  // Alone with one person in voice: whatever they say is said to her.
  if (why === null && input.voice?.others === 1) why = "one-on-one in voice";
  if (why !== null) reasons.push(`direct: ${why}`);
  if (input.affinity !== null) reasons.push(`affinity ${signed(input.affinity, 0)}`);
  const score = salience(input, why !== null, reasons);
  const direct = why !== null;
  const scale = ambientScale(input);
  const done = (gate: Gate): Assessment => ({
    direct,
    score,
    gate,
    reasons,
    ambientScale: scale,
  });

  switch (input.mode) {
    case "off":
      return done({ kind: "ignore" });
    case "always":
      return done({ kind: "sample", probability: 1 });
    case "mention-only":
    case "ambient":
      if (direct) {
        if (input.affinity !== null && input.affinity <= IGNORE_DIRECT_AFFINITY) {
          reasons.push("very low affinity: may ignore");
        }
        return done({ kind: "sample", probability: directProbability(input) });
      }
      if (input.mode === "mention-only") {
        reasons.push("not addressed");
        return done({ kind: "ignore" });
      }
  }

  const talk = input.talkativeness ?? null;
  if (talk !== null) {
    reasons.push(`talkativeness ${fixed(talk.level, 2)} (${talk.scope})`);
    if (talk.level <= SILENT_TALKATIVENESS) {
      reasons.push("she wants to stay quiet here");
      return done({ kind: "ignore" });
    }
  }
  if (input.voice?.someoneSpeaking) {
    // `interrupt_scale = 0` is the owner's "never over someone", whatever she wants.
    if (input.voice.interruptScale <= 0) {
      reasons.push("someone is speaking");
      return done({ kind: "ignore" });
    }
    const scale = talk === null ? input.voice.interruptScale : talkInterruptScale(talk.level);
    reasons.push(`someone is speaking ×${fixed(scale, 2)}`);
  }
  const activeness = input.activeness;
  if (talk === null && activeness !== "medium") reasons.push(`activeness ${activeness}`);
  if (input.mood !== null) reasons.push(`energy ${fixed(input.mood.energy, 2)}`);
  const cooldownMs = ambientCooldown(
    cfg.cooldown_ms,
    cfg.min_cooldown_ms,
    activeness,
    talk,
    input.mood,
  );
  const last = input.session.lastSelfAt();
  // In voice, someone answering what she just said is a conversation, not her butting in.
  const answeringHer = input.voice !== null && followsHer(input);
  if (last !== null && !answeringHer) {
    const since = input.now - last;
    if (since < cooldownMs) {
      reasons.push(`cooldown (${since}ms since she spoke)`);
      return done({ kind: "ignore" });
    }
  }
  const share = input.session.selfShare(cfg.recent_window);
  if (share > input.maxShare) {
    reasons.push(`anti-spam: her share ${fixed(share, 2)} > ${fixed(input.maxShare, 2)}`);
    return done({ kind: "ignore" });
  }
  const threshold = talk === null ? 1 : talkThresholdFactor(talk.level);
  const grayLow = cfg.gray_low * threshold;
  const grayHigh = cfg.gray_high * threshold;
  if (score < grayLow) {
    reasons.push(`score ${fixed(score, 2)} < ${fixed(grayLow, 2)}`);
    return done({ kind: "ignore" });
  }
  if (score >= grayHigh) {
    return done({ kind: "sample", probability: ambientProbability(input, score) });
  }
  if (cfg.llm_check) {
    reasons.push("gray zone: asking fast model");
    return done({ kind: "ask_llm" });
  }
  return done({ kind: "sample", probability: ambientProbability(input, score) });
}

/** She spoke among the last three entries before this turn, within the last 3 minutes. */
function followsHer(input: AttentionInput): boolean {
  const history = input.session.history();
  const before = Math.max(history.length - input.inputs.length, 0);
  const her = history
    .slice(0, before)
    .reverse()
    .slice(0, 3)
    .find((e) => e.isSelf);
  return her !== undefined && Math.trunc((input.now - her.ts) / 1000) < 180;
}

function salience(input: AttentionInput, direct: boolean, reasons: string[]): number {
  let score = 0.05;
  const add = (weight: number, why: string): void => {
    score += weight;
    reasons.push(`${why} ${signed(weight, 2)}`);
  };
  if (direct) add(0.6, "direct");
  const texts = input.inputs.map((m) => m.text.toLowerCase());
  if (texts.some(isQuestion)) add(0.15, "question");
  const keyword = [...input.config.keywords, ...input.interests].find((k) =>
    texts.some((t) => mentionsTopic(t, k)),
  );
  if (keyword !== undefined) add(0.2, `topic \`${keyword}\``);

  if (followsHer(input)) add(0.35, "follow-up to her");
  const last = input.session.lastSelfAt();
  if (last === null) add(0.05, "has not spoken yet");
  else if (Math.trunc((input.now - last) / 60_000) >= 30) add(0.05, "quiet for a while");
  if (input.inputs.length > 1) add(0.05, "several messages");
  const people = new Set(
    input.session
      .recent(10)
      .filter((e) => !e.isSelf)
      .map((e) => accountId(e.account)),
  );
  if (people.size <= 2) add(0.1, "small group");
  return clamp01(score);
}

/**
 * `text` (lower-cased) mentions `topic`. ASCII words such as `AI` must stand alone, so they do
 * not match inside `said`; other topics match anywhere.
 */
export function mentionsTopic(text: string, topic: string): boolean {
  const t = topic.trim().toLowerCase();
  if (t === "") return false;
  if (![...t].every(isAsciiAlphanumeric)) return text.includes(t);
  for (let i = text.indexOf(t); i !== -1; i = text.indexOf(t, i + t.length)) {
    const before = [...text.slice(0, i)].at(-1);
    const after = [...text.slice(i + t.length, i + t.length + 2)][0];
    if (!isAsciiAlphanumeric(before) && !isAsciiAlphanumeric(after)) return true;
  }
  return false;
}

const QUESTION_WORDS = [
  "什麼",
  "怎麼",
  "幹嘛",
  "為什麼",
  "為啥",
  "誰",
  "哪裡",
  "哪個",
  "how ",
  "what ",
  "why ",
];

export function isQuestion(text: string): boolean {
  const chars = [...text];
  while (chars.length > 0) {
    const c = chars.at(-1) as string;
    if (isWhitespace(c) || "~～!！。.…".includes(c)) chars.pop();
    else break;
  }
  const t = chars.join("");
  return (
    t.includes("?") ||
    t.endsWith("嗎") ||
    t.endsWith("呢") ||
    t.endsWith("吧") ||
    QUESTION_WORDS.some((w) => t.includes(w))
  );
}

/** Samples the final decision; the roll is `null` when the outcome was certain. */
export function decide(probability: number, random: RandomSource): [boolean, number | null] {
  if (probability >= 1) return [true, null];
  if (probability <= 0) return [false, null];
  const roll = random.nextF32();
  return [roll < probability, roll];
}
