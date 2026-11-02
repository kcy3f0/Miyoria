import { type Attitude, newId } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  affinityAmbientFactor,
  affinityDirectFactor,
  attitudeHint,
  energyCooldownFactor,
  energyProbabilityFactor,
  herStatusHint,
  moodHint,
  parseBudgetState,
  tone,
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

  it("attitude_hints", () => {
    const a: Attitude = {
      person: newId(),
      affinity: 60,
      trust: 50,
      familiarity: 50,
      blocked: false,
      label: "朋友",
      call_name: "歐文",
    };
    expect(attitudeHint("Owen", a)).toBe("你對 Owen 的態度:親近(朋友),你都叫對方「歐文」");
    a.affinity = -50;
    a.label = "";
    a.call_name = null;
    expect(attitudeHint("Owen", a)).toBe("你對 Owen 的態度:冷淡");
    a.affinity = 0;
    expect(tone(a.affinity)).toBe("普通");
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
