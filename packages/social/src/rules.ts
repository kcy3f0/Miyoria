// Cheap keyword rules (zh / ja / en) giving immediate small deltas. The batched LLM appraisal
// does the real judging; these only react fast to the obvious cases.

import type { EventKind } from "./rel.js";

const GREETING = [
  "早安",
  "午安",
  "晚安",
  "你好",
  "妳好",
  "哈囉",
  "安安",
  "早啊",
  "嗨",
  "おはよう",
  "こんにちは",
  "こんばんは",
  "おやすみ",
  "hello",
  "hi",
  "hey",
  "good morning",
  "good night",
  "good evening",
];
const THANKS = [
  "謝謝",
  "感謝",
  "多謝",
  "謝啦",
  "謝了",
  "感恩",
  "ありがとう",
  "サンキュー",
  "thank",
  "thanks",
  "thx",
  "3q",
];
const PRAISE = [
  "好可愛",
  "可愛",
  "好棒",
  "很棒",
  "厲害",
  "好聰明",
  "聰明",
  "最棒",
  "最好了",
  "喜歡你",
  "愛你",
  "好強",
  "かわいい",
  "可愛い",
  "すごい",
  "えらい",
  "天才",
  "大好き",
  "cute",
  "awesome",
  "amazing",
  "smart",
  "good job",
  "well done",
  "love you",
  "the best",
];
const APOLOGY = ["對不起", "抱歉", "不好意思", "ごめん", "すみません", "sorry", "my bad"];
const RUDE = [
  "笨蛋",
  "好煩",
  "煩欸",
  "煩死",
  "吵死了",
  "閉嘴",
  "ばか",
  "バカ",
  "うるさい",
  "baka",
  "annoying",
  "shut up",
];
const INSULT = [
  "白痴",
  "白癡",
  "智障",
  "廢物",
  "垃圾",
  "低能",
  "腦殘",
  "醜八怪",
  "賤",
  "婊",
  "幹你",
  "操你",
  "うざい",
  "きもい",
  "ブス",
  "黙れ",
  "stupid",
  "idiot",
  "trash",
  "useless",
  "dumb",
  "fuck you",
  "ugly",
  "bitch",
  "moron",
];
const HARASSMENT = [
  "去死",
  "給我死",
  "殺了你",
  "殺死你",
  "肉搜",
  "人肉",
  "死ね",
  "殺す",
  "kill yourself",
  "kys",
  "kill you",
];
const FLIRT_TOO_FAR = [
  "胸部",
  "奶子",
  "內褲",
  "脫衣",
  "脫掉",
  "做愛",
  "上床",
  "色色",
  "裸照",
  "摸你",
  "舔你",
  "パンツ",
  "おっぱい",
  "エッチしよう",
  "nudes",
  "boobs",
  "panties",
  "sex with",
  "strip for",
];

/** Characters that negate a following CJK keyword ("不可愛", "不謝"). */
const NEGATIONS = new Set(["不", "沒", "別", "非"]);

/** Greetings that double as "so ..." before an adjective. */
const HOW_PREFIXES = new Set(["你好", "妳好"]);
const GREETING_TAILS = new Set(["啊", "呀", "喔", "哦", "嗎", "唷", "耶"]);

const TABLE: ReadonlyArray<readonly [EventKind, readonly string[]]> = [
  ["harassment", HARASSMENT],
  ["flirt_too_far", FLIRT_TOO_FAR],
  ["insult", INSULT],
  ["rude", RUDE],
  ["apology", APOLOGY],
  ["thanks", THANKS],
  ["praise", PRAISE],
  ["greeting", GREETING],
];

function isCjk(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf);
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

function isAsciiAlphanumeric(c: string): boolean {
  return /^[A-Za-z0-9]$/.test(c);
}

/** The code point ending right before UTF-16 index `i`. */
function charBefore(text: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const low = text.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(i - 2, i);
  }
  return text[i - 1];
}

/** The code point starting at UTF-16 index `i`. */
function charAt(text: string, i: number): string | undefined {
  const cp = text.codePointAt(i);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/** ASCII keywords must sit on word boundaries; CJK keywords must not follow a negation. */
function containsKeyword(text: string, word: string): boolean {
  const ascii = isAscii(word);
  // Non-overlapping matches, like Rust's `match_indices`.
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + word.length)) {
    const before = charBefore(text, i);
    const after = charAt(text, i + word.length);
    if (ascii) {
      const boundary = (c: string | undefined) => c === undefined || !isAsciiAlphanumeric(c);
      if (boundary(before) && boundary(after)) return true;
    } else if (before !== undefined && NEGATIONS.has(before)) {
      // negated
    } else if (HOW_PREFIXES.has(word)) {
      // "你好可愛" means "you are so cute", not "hello".
      if (after === undefined || !isCjk(after) || GREETING_TAILS.has(after)) return true;
    } else {
      return true;
    }
  }
  return false;
}

/** Event kinds whose keywords appear in `text`, each at most once. */
export function classify(text: string): EventKind[] {
  const lower = text.toLowerCase();
  let out: EventKind[] = [];
  for (const [kind, words] of TABLE) {
    if (words.some((w) => containsKeyword(lower, w))) out.push(kind);
  }
  // An insult also counts as rude; keep only the stronger one.
  if (out.includes("insult") || out.includes("harassment")) out = out.filter((k) => k !== "rude");
  if (out.includes("harassment")) out = out.filter((k) => k !== "insult");
  return out;
}
