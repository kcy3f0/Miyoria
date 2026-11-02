import type { ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { selfConfig } from "../src/config.js";
import { IDLE, SelfEngine, SelfError } from "../src/engine.js";

const T0 = Date.parse("2026-11-02T12:00:00.000Z");
const HOUR = 3_600_000;
const voiceCtx: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
const textCtx: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };

describe("drives", () => {
  it("rise on their own and saturate", () => {
    const e = new SelfEngine(selfConfig(), T0);
    expect(e.drives().social).toBeCloseTo(0.3);
    e.advance(T0 + HOUR, IDLE);
    // 1 - 0.7 * e^-0.08
    expect(e.drives().social).toBeCloseTo(1 - 0.7 * Math.exp(-0.08), 6);
    expect(e.boredom()).toBeCloseTo(1 - 0.8 * Math.exp(-0.15), 6);
    // Splitting the time gives the same result.
    const split = new SelfEngine(selfConfig(), T0);
    split.advance(T0 + HOUR / 2, IDLE);
    split.advance(T0 + HOUR, IDLE);
    expect(split.drives().social).toBeCloseTo(e.drives().social, 9);
    e.advance(T0 + 200 * HOUR, IDLE);
    expect(e.drives().social).toBeLessThanOrEqual(1);
    expect(e.drives().social).toBeGreaterThan(0.99);
    // Without a mood, rest does not move.
    expect(e.drives().rest).toBeCloseTo(0.3);
  });

  it("rest follows tiredness; playing and streaming satisfy", () => {
    const e = new SelfEngine(selfConfig({ rest_half_life_mins: 60 }), T0);
    e.advance(T0 + HOUR, { energy: 0.1, playing: false, streaming: false });
    // Halfway from 0.3 to 0.9.
    expect(e.drives().rest).toBeCloseTo(0.6, 6);

    const p = new SelfEngine(selfConfig(), T0);
    p.adjust({ play: 0.5, attention: 0.5 });
    p.advance(T0 + HOUR, { energy: null, playing: true, streaming: true });
    const d = p.drives();
    expect(d.play).toBeLessThan(0.8 * 0.6);
    expect(d.attention).toBeLessThan(0.5);
    expect(d.rest).toBeCloseTo(0.4, 6);
  });

  it("adjusts within 0..1", () => {
    const e = new SelfEngine(selfConfig(), T0);
    e.adjust({ social: -1, curiosity: 5, boredom: Number.NaN });
    expect(e.drives()).toMatchObject({ social: 0, curiosity: 1 });
    expect(e.boredom()).toBeCloseTo(0.2);
  });
});

describe("policy", () => {
  it("resolves the most specific unexpired scope", () => {
    const e = new SelfEngine(selfConfig(), T0);
    e.setTalkativeness("*", { level: 0.4, why: "平常" }, T0);
    e.setTalkativeness("voice", { level: 0.2, why: "語音少講話" }, T0);
    e.setTalkativeness(
      "discord:g1:voice:v1",
      { level: 1.4, forMs: 30 * 60_000, why: "大家在玩遊戲很熱鬧" },
      T0,
    );
    expect(e.talkativeness(voiceCtx, T0 + 1)).toMatchObject({
      scope: "discord:g1:voice:v1",
      level: 1,
      until: "2026-11-02T12:30:00.000Z",
      why: "大家在玩遊戲很熱鬧",
    });
    expect(e.talkativeness(textCtx, T0)?.scope).toBe("*");
    expect(e.talkativeness(null, T0)?.level).toBe(0.4);
    // Expired: falls back and disappears from the policy.
    expect(e.talkativeness(voiceCtx, T0 + 30 * 60_000)?.scope).toBe("voice");
    expect(Object.keys(e.policy(T0 + 30 * 60_000).talkativeness)).toEqual(["*", "voice"]);
    expect(e.clearTalkativeness("voice")).toBe(true);
    expect(e.clearTalkativeness("voice")).toBe(false);
  });

  it("caps expiries and rejects nonsense", () => {
    const e = new SelfEngine(selfConfig({ max_talkativeness_hours: 2 }), T0);
    const t = e.setTalkativeness("*", { level: 0.5, until: "2026-11-05T00:00:00Z", why: "" }, T0);
    expect(t.until).toBe("2026-11-02T14:00:00.000Z");
    expect(() => e.setTalkativeness("", { level: 1, why: "" }, T0)).toThrow(SelfError);
    expect(() => e.setTalkativeness("*", { level: Number.NaN, why: "" }, T0)).toThrow(SelfError);
    expect(() => e.setTalkativeness("*", { level: 1, forMs: -5, why: "" }, T0)).toThrow(
      "`until` is in the past",
    );
    expect(() => e.setTalkativeness("*", { level: 1, until: "soon", why: "" }, T0)).toThrow(
      "invalid until",
    );
    e.setInitiative(2, "想多做點事");
    expect(e.initiative()).toBe(1);
    expect(e.policy(T0).initiative_why).toBe("想多做點事");
  });
});

describe("agenda", () => {
  it("adds, completes, drops and expires items", () => {
    const e = new SelfEngine(selfConfig(), T0);
    const later = e.addAgenda(
      { text: "等 Owen 上線問他報告結果", person: "p1", due: "2026-11-02T13:00:00Z" },
      T0,
    );
    const soon = e.addAgenda({ text: "去語音看看", expiresAt: "2026-11-02T12:10:00Z" }, T0);
    const any = e.addAgenda({ text: "找人玩 Minecraft" }, T0);
    expect(e.agenda(T0).map((a) => a.text)).toEqual([
      "等 Owen 上線問他報告結果",
      "去語音看看",
      "找人玩 Minecraft",
    ]);
    expect(e.completeAgenda(later.id, T0 + 1)?.status).toBe("done");
    expect(e.completeAgenda(later.id, T0 + 2)).toBeNull();
    expect(e.dropAgenda(any.id, T0 + 3)?.status).toBe("dropped");
    // Past its expiry.
    expect(e.agenda(T0 + 10 * 60_000)).toEqual([]);
    const all = e.allAgenda(T0 + 10 * 60_000);
    expect(all.map((a) => [a.id, a.status])).toEqual([
      [soon.id, "expired"],
      [any.id, "dropped"],
      [later.id, "done"],
    ]);
    expect(all[0]?.closed_at).toBe("2026-11-02T12:10:00.000Z");
    expect(() => e.addAgenda({ text: "  " }, T0)).toThrow("agenda text is empty");
    expect(() => e.addAgenda({ text: "x", expiresAt: "2026-11-01T00:00:00Z" }, T0)).toThrow(
      "`expires_at` is in the past",
    );
  });

  it("keeps the open list and the history bounded", () => {
    const e = new SelfEngine(selfConfig({ max_open_agenda: 2, keep_closed_agenda: 1 }), T0);
    const a = e.addAgenda({ text: "a" }, T0);
    e.addAgenda({ text: "b" }, T0 + 1);
    e.addAgenda({ text: "c" }, T0 + 2);
    expect(e.agenda(T0 + 3).map((x) => x.text)).toEqual(["b", "c"]);
    expect(e.allAgenda(T0 + 3).find((x) => x.id === a.id)?.status).toBe("dropped");
    e.dropAgenda(e.agenda(T0 + 3)[0]?.id ?? "", T0 + 4);
    // Only the newest closed item is kept.
    expect(e.allAgenda(T0 + 5).map((x) => [x.text, x.status])).toEqual([
      ["c", "open"],
      ["b", "dropped"],
    ]);
  });
});

describe("persistence", () => {
  it("round-trips and drifts across the downtime", () => {
    const e = new SelfEngine(selfConfig(), T0);
    e.adjust({ social: 0.4 });
    e.setTalkativeness("voice", { level: 0.8, forMs: HOUR, why: "熱鬧" }, T0);
    e.setInitiative(0.9, "想主動");
    const item = e.addAgenda({ text: "問 Owen 考試" }, T0);
    const json = JSON.parse(JSON.stringify(e.toJson()));

    const r = new SelfEngine(selfConfig(), T0 + 2 * HOUR);
    expect(r.restore(json, T0 + 2 * HOUR)).toBe(true);
    const reference = new SelfEngine(selfConfig(), T0);
    reference.adjust({ social: 0.4 });
    reference.advance(T0 + 2 * HOUR, IDLE);
    expect(r.drives().social).toBeCloseTo(reference.drives().social, 9);
    expect(r.initiative()).toBe(0.9);
    // The one-hour setting expired while she was down.
    expect(r.policy(T0 + 2 * HOUR).talkativeness).toEqual({});
    expect(r.agenda(T0 + 2 * HOUR).map((a) => a.id)).toEqual([item.id]);

    expect(new SelfEngine(selfConfig(), T0).restore({ nope: true }, T0)).toBe(false);
    expect(new SelfEngine(selfConfig(), T0).restore("x", T0)).toBe(false);
  });
});
