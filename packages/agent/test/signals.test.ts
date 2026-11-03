import { describe, expect, it } from "vitest";
import {
  affinityAmbientFactor,
  affinityDirectFactor,
  energyCooldownFactor,
  energyProbabilityFactor,
  herStatusHint,
  moodHint,
  parseBudgetState,
  shownHint,
} from "../src/index.js";

describe("signals", () => {
  it("affinity_factors", () => {
    expect(affinityAmbientFactor(-100)).toBeCloseTo(0.3, 5);
    expect(affinityAmbientFactor(-500)).toBeCloseTo(0.3, 5);
    expect(affinityAmbientFactor(0)).toBeCloseTo(1.0, 5);
    expect(affinityAmbientFactor(50)).toBeCloseTo(1.2, 5);
    expect(affinityAmbientFactor(100)).toBeCloseTo(1.4, 5);
    expect(affinityDirectFactor(-79)).toBeCloseTo(1.0, 5);
    expect(affinityDirectFactor(-80)).toBeCloseTo(0.4, 5);
    expect(affinityDirectFactor(100)).toBeCloseTo(1.1, 5);
  });

  it("mood_factors_and_hint", () => {
    const tired = { valence: -0.5, arousal: 0.1, energy: 0.0 };
    const fresh = { valence: 0.8, arousal: 0.9, energy: 1.0 };
    expect(energyProbabilityFactor(tired)).toBeCloseTo(0.7, 5);
    expect(energyProbabilityFactor(fresh)).toBeCloseTo(1.3, 5);
    expect(energyCooldownFactor(tired)).toBeCloseTo(1.3, 5);
    expect(energyCooldownFactor(fresh)).toBeCloseTo(0.7, 5);
    expect(moodHint(tired)).toBe("你現在的狀態:心情不太好、平靜、有點累");
    expect(moodHint(fresh)).toBe("你現在的狀態:心情不錯、有點興奮、精神很好");
  });

  it("shown emotion hint: her lines and tags follow what she shows", () => {
    const hint = shownHint({
      from: "shy",
      tag: "embarrassed",
      style: "兇回去、嫌棄對方,但臉紅了",
      masked: true,
    });
    expect(hint).toBe(
      "你現在表現出來的樣子:兇回去、嫌棄對方,但臉紅了。台詞和 <emo:…> 照這個走(多半是 <emo:embarrassed>);心裡真正的感受藏起來,不要直接說出來",
    );
    // Only a plain tag name gets through.
    expect(shownHint({ from: "joy", tag: "x>y", style: "開心", masked: false })).toContain(
      "<emo:neutral>",
    );
  });

  it("parses_budget_states", () => {
    expect(parseBudgetState("OK")).toBe("ok");
    expect(parseBudgetState("degraded")).toBe("degraded");
    expect(parseBudgetState("exhausted")).toBe("exhausted");
    expect(() => parseBudgetState("broke")).toThrow("unknown budget state `broke`");
  });
});

describe("herStatusHint", () => {
  it("states where she is, whether she is live and what she plays", () => {
    const base = {
      voice: null,
      voice_name: null,
      golive: null,
      streaming: false,
      scene: null,
      game: null,
    };
    expect(herStatusHint(base)).toBe("你現在不在語音頻道、沒有在直播、沒有在玩遊戲。");
    expect(
      herStatusHint({
        ...base,
        voice: { platform: "discord", scope: "g", channel: "vc", kind: "voice" },
        voice_name: "active-only",
        golive: "live",
        game: "Minecraft",
      }),
    ).toBe("你現在在語音頻道 active-only、正在 Go Live 直播、正在玩 Minecraft。");
  });
});
