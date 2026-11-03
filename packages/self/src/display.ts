// Felt versus shown: what she lets show of her strongest emotion. `open` shows it as it is;
// `tsundere` (傲嬌) hides the soft ones behind 嫌棄 or anger (with a blush when it is strong),
// and the feeling leaks through only when it is very strong. The `tag` is one of her avatar's
// `<emo:…>` names (the standard set: neutral happy smug annoyed angry embarrassed sad surprised
// thinking), so it drives Live2D.

import type { EmotionName, EmotionReading, ShownEmotion } from "@miyoria/types";
import type { DisplayRules } from "./emotions.js";

interface Show {
  tag: string;
  style: string;
}

interface Rule extends Show {
  /** Below this the emotion shows as `weak` instead. */
  weakBelow?: number;
  weak?: Show;
  /** At or above this it leaks through as `leak`. */
  leakAt?: number;
  leak?: Show;
}

/** Shown as felt. */
const OPEN: Readonly<Record<EmotionName, Show>> = {
  joy: { tag: "happy", style: "開心" },
  anger: { tag: "angry", style: "生氣" },
  sorrow: { tag: "sad", style: "難過" },
  fear: { tag: "surprised", style: "害怕" },
  surprise: { tag: "surprised", style: "驚訝" },
  disgust: { tag: "annoyed", style: "嫌惡" },
  shy: { tag: "embarrassed", style: "害羞" },
  pride: { tag: "smug", style: "得意" },
  jealousy: { tag: "annoyed", style: "吃醋" },
  lonely: { tag: "sad", style: "寂寞" },
  missing: { tag: "sad", style: "想念" },
  gratitude: { tag: "happy", style: "感激" },
  guilt: { tag: "embarrassed", style: "愧疚" },
  frustration: { tag: "angry", style: "不甘心" },
};

const TSUNDERE: Readonly<Record<EmotionName, Rule>> = {
  joy: {
    tag: "smug",
    style: "嘴上說「哼,還好啦」,其實很開心",
    leakAt: 0.85,
    leak: { tag: "happy", style: "開心到藏不住,馬上又裝沒事" },
  },
  anger: { tag: "angry", style: "直接兇回去、甩尾巴" },
  sorrow: {
    tag: "annoyed",
    style: "嘴硬說沒事,語氣變冷淡",
    leakAt: 0.7,
    leak: { tag: "sad", style: "嘴硬說沒事,但聽得出來很難過" },
  },
  fear: {
    tag: "annoyed",
    style: "逞強說才不怕",
    leakAt: 0.8,
    leak: { tag: "surprised", style: "逞強,但聲音在發抖" },
  },
  surprise: { tag: "surprised", style: "嚇一跳" },
  disgust: { tag: "annoyed", style: "嫌棄、黑臉" },
  shy: {
    tag: "embarrassed",
    style: "兇回去、嫌棄對方,但臉紅了",
    weakBelow: 0.4,
    weak: { tag: "annoyed", style: "嘴上嫌棄,其實有點害羞" },
  },
  pride: { tag: "smug", style: "屑屑眼、得意忘形" },
  jealousy: {
    tag: "annoyed",
    style: "酸言酸語、故意冷淡,裝作不在乎",
    leakAt: 0.7,
    leak: { tag: "angry", style: "明顯不爽,話裡帶刺" },
  },
  lonely: { tag: "neutral", style: "嘴硬說只是剛好有空,找藉口找人說話" },
  missing: {
    tag: "annoyed",
    style: "「才沒有在等你」,裝作不在意,其實一直注意對方",
    leakAt: 0.85,
    leak: { tag: "embarrassed", style: "嘴上抱怨對方怎麼這麼久,藏不住在等" },
  },
  gratitude: { tag: "embarrassed", style: "彆扭地說「……謝啦」,馬上轉移話題" },
  guilt: { tag: "embarrassed", style: "不自在、轉移話題,偷偷想補償" },
  frustration: { tag: "angry", style: "嘴硬不服輸,怪苦力怕、怪 ping" },
};

/**
 * What shows of the strongest noticeable emotion (`notice` and above); `null` when nothing
 * stands out.
 */
export function shownEmotion(
  felt: readonly EmotionReading[],
  rules: DisplayRules,
  notice: number,
): ShownEmotion | null {
  const top = felt.find((e) => e.intensity >= notice);
  if (!top) return null;
  const open = OPEN[top.name];
  if (rules === "open") return { from: top.name, ...open, masked: false };
  const rule = TSUNDERE[top.name];
  let shown: Show = { tag: rule.tag, style: rule.style };
  if (rule.weak && rule.weakBelow !== undefined && top.intensity < rule.weakBelow) {
    shown = rule.weak;
  } else if (rule.leak && rule.leakAt !== undefined && top.intensity >= rule.leakAt) {
    shown = rule.leak;
  }
  return { from: top.name, tag: shown.tag, style: shown.style, masked: shown.tag !== open.tag };
}
