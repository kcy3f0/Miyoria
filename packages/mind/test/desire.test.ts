import type { AffectSnapshot, Goal, PersonCard } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { type DesireInputs, rankDesires, renderDesire, type Whereabouts } from "../src/index.js";

function affect(p: Partial<AffectSnapshot> = {}): AffectSnapshot {
  return {
    at: "2026-11-02T12:00:00.000Z",
    drives: {
      social: 0.3,
      play: 0.2,
      attention: 0.1,
      rest: 0.1,
      curiosity: 0.1,
      esteem: 0.1,
      hunger: 0,
      longing: 0,
    },
    boredom: 0.2,
    top: [],
    mood: { valence: 0.2, arousal: 0.4, energy: 0.6 },
    mood_line: "心情普通",
    shown: null,
    biases: { talkativeness: 0, initiative: 0, wants: [] },
    ...p,
  };
}

type Card = Pick<PersonCard, "handle" | "attachment" | "emotions" | "blocked">;
const card = (handle: string, attachment: number, missing = 0): Card => ({
  handle,
  attachment,
  emotions: missing > 0 ? { missing } : {},
  blocked: false,
});

function inputs(
  p: Partial<DesireInputs> = {},
  where: Record<string, Whereabouts> = {},
): DesireInputs {
  return {
    affect: affect(),
    cards: [],
    where: (h) => where[h] ?? "offline",
    goals: [],
    fired: new Set(),
    capabilities: new Set(["chat.start", "chat.dm", "voice.join", "game.start", "sing.request"]),
    activity: null,
    inVoice: false,
    cared: 0.3,
    ...p,
  };
}

describe("the desire list", () => {
  it("puts finding someone she misses first when they are online, with the numbers", () => {
    const list = rankDesires(
      inputs(
        {
          affect: affect({
            top: [{ name: "missing", intensity: 0.6, cause: "", at: "", person: null }],
            biases: {
              talkativeness: 0,
              initiative: 0,
              wants: [
                { want: "find_person", weight: 0.75, person: "Owen", why: "想念Owen" },
                { want: "play", weight: 0.4, person: null, why: "想玩遊戲、有點無聊" },
              ],
            },
          }),
          cards: [card("Owen", 0.8, 0.6), card("Amy", 0.1)],
        },
        { Owen: "online", Amy: "online" },
      ),
    );
    expect(list[0]).toMatchObject({
      want: "find_person",
      label: "找 Owen 聊天",
      person: "Owen",
      capability: "chat.dm",
    });
    expect(renderDesire(list[0] as never)).toBe("找 Owen 聊天(想念 0.6 × 在意 0.8,他在線)");
    expect(list.find((d) => d.want === "play")?.capability).toBe("game.start");
    // Someone she hardly cares about is not suggested.
    expect(list.some((d) => d.person === "Amy")).toBe(false);
    for (let i = 1; i < list.length; i++) {
      expect((list[i - 1]?.weight ?? 0) >= (list[i]?.weight ?? 0)).toBe(true);
    }
  });

  it("weighs someone away less, and joins the voice channel someone is in", () => {
    const wants = {
      talkativeness: 0,
      initiative: 0,
      wants: [{ want: "find_person", weight: 0.7, person: "Owen", why: "想念Owen" }],
    };
    const cards = [card("Owen", 0.8, 0.55)];
    const away = rankDesires(inputs({ affect: affect({ biases: wants }), cards }, {}));
    const there = rankDesires(
      inputs({ affect: affect({ biases: wants }), cards }, { Owen: "voice" }),
    );
    expect(away[0]?.why).toContain("他不在線");
    expect(away[0]?.capability).toBeNull();
    expect(there[0]?.capability).toBe("voice.join");
    expect((there[0]?.weight ?? 0) > (away[0]?.weight ?? 0)).toBe(true);
  });

  it("lists her goals, fired ones near the top, and leaves out what she cannot do", () => {
    const goal = (id: string, what: string, kind: "whenever" | "when_online"): Goal => ({
      id,
      what,
      why: "",
      trigger: kind === "whenever" ? { kind } : { kind, person: "Owen" },
      steps: [],
      status: "pending",
      expires: "2026-11-03T12:00:00.000Z",
      person: kind === "when_online" ? "Owen" : null,
      context: null,
      source: "plan",
      created_at: "",
      updated_at: "",
      closed_at: null,
      close_reason: null,
    });
    const list = rankDesires(
      inputs(
        {
          goals: [goal("g-a", "整理筆記", "whenever"), goal("g-b", "問 Owen 報告", "when_online")],
          fired: new Set(["g-b"]),
          capabilities: new Set(["chat.start"]),
          affect: affect({
            biases: {
              talkativeness: 0,
              initiative: 0,
              wants: [{ want: "play", weight: 0.5, person: null, why: "想玩遊戲" }],
            },
          }),
        },
        { Owen: "online" },
      ),
    );
    expect(list[0]).toMatchObject({ want: "goal", goal: "g-b", label: "問 Owen 報告" });
    expect(list[0]?.why).toContain("觸發條件到了");
    expect(list.find((d) => d.goal === "g-a")?.weight).toBe(0.35);
    expect(list.find((d) => d.want === "play")?.capability).toBeNull();
  });

  it("is empty when she wants nothing in particular", () => {
    expect(rankDesires(inputs({ affect: null }))).toEqual([]);
  });
});
