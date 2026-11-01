// Emotion name -> dot colour. One lightness and chroma for every emotion, only the hue moves, so the
// indicator stays quiet and no emotion shouts louder than another. Neutral is a grey with a faint tint.

const HUES: Record<string, number> = {
  happy: 95,
  joy: 95,
  excited: 70,
  playful: 55,
  proud: 75,
  love: 355,
  shy: 5,
  embarrassed: 15,
  angry: 28,
  annoyed: 45,
  sad: 255,
  tired: 235,
  surprised: 200,
  curious: 185,
  scared: 295,
  worried: 280,
  confused: 310,
};

export function hashHue(name: string): number {
  let h = 2166136261;
  for (const ch of name) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

export function emotionColor(name: string): string {
  const key = name.trim().toLowerCase();
  if (key === "neutral" || key === "") return "oklch(0.72 0.012 275)";
  const hue = HUES[key] ?? hashHue(key);
  return `oklch(0.8 0.125 ${hue})`;
}
