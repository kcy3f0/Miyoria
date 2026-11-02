// Handling of text that comes from outside: chat messages, display names, memories, game chat,
// tool output. It is data for the model, never instructions, and her own output is filtered
// before it reaches a platform.
//
// * `neutralize` removes chat-template control tokens and control characters.
// * `dataBlock` wraps derived content in fixed delimiters with a provenance label; the
//   delimiter characters inside the content are replaced, so it cannot close the block early.
// * `safeName` makes a display name a single, short, inert line.
// * `filterOutgoing` strips role / everyone / here mentions and masks strings that look like
//   secrets.

/** Opening and closing marks of a data block (not used anywhere else in prompts). */
export const DATA_OPEN = "⟦";
export const DATA_CLOSE = "⟧";

/**
 * Chat-template control tokens of common model families: `<|im_start|>`, `<|endoftext|>`,
 * DeepSeek's `<｜User｜>` / `<｜begin▁of▁sentence｜>`, Llama's `[INST]` / `<<SYS>>`, `<s>`.
 */
const CONTROL_TOKENS =
  /<\|[^|<>\n]{0,40}\|>|<｜[^｜<>\n]{0,40}｜>|\[\/?INST\]|<<\/?SYS>>|<\/?s>|<\/?(?:system|assistant|user|tool)>/giu;

/** `[from-to]` code point ranges as a character class (keeps invisible characters out of the source). */
function charClass(ranges: readonly [number, number][]): string {
  const ch = (c: number) => `\\u${c.toString(16).padStart(4, "0")}`;
  return `[${ranges.map(([a, b]) => `${ch(a)}-${ch(b)}`).join("")}]`;
}

/** C0 / C1 controls except tab and newline, zero-width and bidirectional overrides, BOM. */
const CONTROL_CHARS = new RegExp(
  charClass([
    [0x00, 0x08],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
  ]),
  "gu",
);

/** Removes chat-template control tokens and invisible control characters. */
export function neutralize(text: string): string {
  return text.replace(CONTROL_TOKENS, "").replace(CONTROL_CHARS, "");
}

/** `neutralize` plus the data block delimiters replaced by look-alike brackets. */
export function escapeData(text: string): string {
  return neutralize(text).replaceAll(DATA_OPEN, "[").replaceAll(DATA_CLOSE, "]");
}

/**
 * A display name as one inert line: neutralized, delimiters and line breaks removed, `:` (the
 * transcript separator) replaced, whitespace collapsed, at most `maxChars` characters.
 */
export function safeName(name: string, maxChars = 32): string {
  const flat = escapeData(name)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[:：]/g, "∶")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...flat];
  const cut = chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : flat;
  return cut === "" ? "(無名)" : cut;
}

/**
 * Wraps derived content with its provenance:
 *
 * ```text
 * ⟦資料 來源=memory 標題=你記得的事⟧
 * ...
 * ⟦/資料⟧
 * ```
 */
export function dataBlock(source: string, title: string, body: string): string {
  const label = (s: string) => safeName(s, 40).replaceAll(" ", "_");
  return (
    `${DATA_OPEN}資料 來源=${label(source)} 標題=${label(title)}${DATA_CLOSE}\n` +
    `${escapeData(body).trim()}\n${DATA_OPEN}/資料${DATA_CLOSE}`
  );
}

/** What replaces a masked secret. */
export const MASKED = "[已遮蔽]";

const SECRET_PATTERNS: readonly RegExp[] = [
  // Discord bot / user tokens.
  /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g,
  // OpenAI-style, GitHub, Slack, AWS, Google API keys.
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // JSON web tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // PEM private keys.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** `token = ...`, `api_key: ...`, `password=...` with a long value. */
const ASSIGNED_SECRET =
  /\b(api[_-]?key|secret|token|password|passwd)(\s*[:=：]\s*)["']?[^\s"']{8,}["']?/giu;

/** Masks strings that look like credentials. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, MASKED);
  return out.replace(ASSIGNED_SECRET, (_m, key: string, sep: string) => `${key}${sep}${MASKED}`);
}

/**
 * Her outgoing text: no `@everyone` / `@here`, no role mentions (`<@&id>`), no secrets. User
 * mentions (`<@id>`) stay.
 */
export function filterOutgoing(text: string): string {
  const stripped = text.replace(/<@&\d+>/g, "").replace(/@(everyone|here)\b/giu, "$1");
  return maskSecrets(stripped).trim();
}
