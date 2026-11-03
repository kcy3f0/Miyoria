// How her feelings lean her behaviour (docs/design/v2-architecture.md §3.6, the last table):
// weighted offsets, not switches. Plan decides what she does; the Arbiter keeps the floors.
// Pure.
//
// | joy, pride high               | talkativeness up, more willing to start things           |
// | sorrow, frustration high      | talkativeness down, less willing, may want someone close |
// | lonely high                   | "find someone to talk to" first (the most attached)      |
// | missing (someone) high        | a strong wish to go find them                            |
// | play / boredom high           | wants a game; attention high + good mood: wants to stream |
// | rest high                     | wants to wind down, says less                            |
// | jealousy (someone)            | tone toward them only (no bias here)                     |

import type { AffectBiases, Drives, EmotionName, Handle, PersonCard } from "@miyoria/types";

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const above = (v: number, level: number) => (v > level ? (v - level) / (1 - level) : 0);

/** Most a bias moves talkativeness / initiative. */
export const MAX_BIAS = 0.4;
/** Wishes lighter than this are not listed. */
export const MIN_WANT = 0.25;

export interface BiasInputs {
  /** Emotion intensities now (absent = 0). */
  emotions: Partial<Record<EmotionName, number>>;
  drives: Drives;
  boredom: number;
  valence: number;
  /** People by attachment, highest first. */
  cards: readonly Pick<PersonCard, "handle" | "attachment" | "emotions" | "blocked">[];
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** The weighted biases her feelings imply. */
export function computeBiases(i: BiasInputs): AffectBiases {
  const e = (n: EmotionName) => i.emotions[n] ?? 0;
  // Below 0.15 an emotion is background (a tsundere's pride sits at 0.12 and leans nothing).
  const up = Math.max(above(e("joy"), 0.15), above(e("pride"), 0.15));
  const down = Math.max(above(e("sorrow"), 0.15), above(e("frustration"), 0.15));
  const tired = above(i.drives.rest, 0.6);
  const talkativeness = clamp(0.6 * up - 0.6 * down - 0.25 * tired, -MAX_BIAS, MAX_BIAS);
  const initiative = clamp(
    0.5 * up - 0.6 * down - 0.2 * tired + 0.1 * above(e("lonely"), 0.4),
    -MAX_BIAS,
    MAX_BIAS,
  );

  const wants: AffectBiases["wants"] = [];
  const add = (want: string, weight: number, person: Handle | null, why: string) => {
    const w = clamp(weight, 0, 1);
    if (w >= MIN_WANT) wants.push({ want, weight: round(w), person, why });
  };
  const closest = i.cards.find((c) => !c.blocked && c.attachment > 0) ?? null;
  if (e("lonely") > 0) {
    add("chat_with", e("lonely"), closest?.handle ?? null, "寂寞,想找人聊天");
  }
  // Missing someone in particular: a strong urge to go find them.
  let missed: { handle: Handle; v: number } | null = null;
  for (const c of i.cards) {
    const v = c.emotions.missing ?? 0;
    if (!c.blocked && v > (missed?.v ?? 0)) missed = { handle: c.handle, v };
  }
  if (missed) add("find_person", missed.v + 0.15, missed.handle, `想念${missed.handle}`);
  const play = Math.max(i.drives.play, above(i.boredom, 0.3));
  if (play > 0.4) add("play", 0.25 + above(play, 0.4), null, "想玩遊戲、有點無聊");
  // Wanting attention and in a good mood: wants to go live.
  const stream = i.drives.attention * (i.valence > 0.2 ? 1 : 0.5);
  if (stream > 0.4) add("stream", 0.25 + above(stream, 0.4), null, "想被注意、心情不錯就想開台");
  if (i.drives.rest > 0.4) add("rest", 0.25 + above(i.drives.rest, 0.4), null, "累了,想收台休息");
  if (i.drives.esteem > 0.4 || up > 0) {
    add("sing", 0.25 + Math.max(above(i.drives.esteem, 0.4), 0.8 * up), null, "想表現一下");
  }
  const real = wants;
  real.sort((a, b) => b.weight - a.weight || (a.want < b.want ? -1 : 1));
  return { talkativeness: round(talkativeness), initiative: round(initiative), wants: real };
}

/** The biases of a snapshot-like state (for the panel). */
export function describeBiases(b: AffectBiases): string {
  const parts: string[] = [];
  if (Math.abs(b.talkativeness) >= 0.05) {
    parts.push(`話量 ${b.talkativeness > 0 ? "+" : ""}${b.talkativeness.toFixed(2)}`);
  }
  if (Math.abs(b.initiative) >= 0.05) {
    parts.push(`主動 ${b.initiative > 0 ? "+" : ""}${b.initiative.toFixed(2)}`);
  }
  for (const w of b.wants.slice(0, 3)) {
    parts.push(`${w.want}${w.person ? `(${w.person})` : ""} ${w.weight.toFixed(2)}`);
  }
  return parts.join("、");
}
