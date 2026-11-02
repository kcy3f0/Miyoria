import {
  type ContextKind,
  type IncomingMessage,
  type Mood,
  newId,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  type Activeness,
  type Assessment,
  type AttentionConfig,
  AttentionConfigSchema,
  assess,
  type ChannelMode,
  decide,
  directReason,
  isQuestion,
  mentionsTopic,
  type RandomSource,
  SeededRandom,
  Session,
} from "../src/index.js";
import { tacc, tctx, tmsg } from "./fixtures.js";

const NAMES = ["DeepSeek-chan", "小鯨魚"];
const me = tacc("her");

const msg = (kind: ContextKind, who: string, text: string) => tmsg(kind, who, text);
const config = (overrides: Partial<AttentionConfig> = {}): AttentionConfig => ({
  ...AttentionConfigSchema.parse({}),
  ...overrides,
});

function runWith(
  cfg: AttentionConfig,
  mode: ChannelMode,
  activeness: Activeness,
  interests: string[],
  session: Session,
  inputs: IncomingMessage[],
): Assessment {
  return assess({
    config: cfg,
    mode,
    activeness,
    names: NAMES,
    interests,
    maxShare: 0.3,
    session,
    inputs,
    now: Date.now(),
    voice: null,
    affinity: null,
    mood: null,
  });
}

function run(
  cfg: AttentionConfig,
  mode: ChannelMode,
  session: Session,
  inputs: IncomingMessage[],
): Assessment {
  return runWith(cfg, mode, "medium", [], session, inputs);
}

function sessionWith(msgs: IncomingMessage[]): Session {
  const s = new Session(tctx("channel"), 50);
  for (const m of msgs) s.recordMessage(m, false);
  return s;
}

function sample(a: Assessment): number {
  if (a.gate.kind !== "sample") throw new Error(`expected sample, got ${a.gate.kind}`);
  return a.gate.probability;
}

const busyChatter = () => Array.from({ length: 6 }, (_, i) => msg("channel", `p${i}`, "閒聊"));

describe("attention", () => {
  it("direct_address_kinds", () => {
    const names = ["DeepSeek"];
    const m = msg("channel", "a", "hello");
    expect(directReason(m, names)).toBeNull();
    m.text = "deepseek 你好";
    expect(directReason(m, names)).toBe("name `DeepSeek`");
    m.text = "x";
    m.reply_to_self = true;
    expect(directReason(m, names)).toBe("reply");
    m.mentions_self = true;
    expect(directReason(m, names)).toBe("mention");
    const dm = msg("dm", "a", "x");
    expect(directReason(dm, names)).toBe("dm");
  });

  it("modes", () => {
    const cfg = config();
    const plain = [msg("channel", "a", "今天好熱")];
    const named = [msg("channel", "a", "小鯨魚早安")];
    const s = sessionWith(plain);
    expect(run(cfg, "off", s, named).gate).toEqual({ kind: "ignore" });
    expect(run(cfg, "always", s, plain).gate).toEqual({ kind: "sample", probability: 1 });
    expect(run(cfg, "mention-only", s, plain).gate).toEqual({ kind: "ignore" });
    const a = run(cfg, "mention-only", s, named);
    expect(a.direct).toBe(true);
    expect(a.gate).toEqual({ kind: "sample", probability: 1 });
    expect(run(cfg, "ambient", s, named).gate).toEqual({ kind: "sample", probability: 1 });
  });

  it("ambient_scoring_and_gray_zone", () => {
    let cfg = config({ keywords: ["鯨魚"] });
    const busy = busyChatter();
    const s = sessionWith(busy);
    let a = run(cfg, "ambient", s, busy.slice(5));
    expect(a.gate, a.reasons.join("; ")).toEqual({ kind: "ignore" });

    const q = [msg("channel", "p1", "你們看過鯨魚嗎?")];
    const s2 = sessionWith(busy);
    s2.recordMessage(q[0] as IncomingMessage, false);
    a = run(cfg, "ambient", s2, q);
    expect(a.gate, a.reasons.join("; ")).toEqual({ kind: "ask_llm" });
    cfg = { ...cfg, llm_check: false };
    expect(run(cfg, "ambient", s2, q).gate.kind).toBe("sample");
  });

  it("follow_up_cooldown_and_share", () => {
    const cfg = config({ llm_check: false, cooldown_ms: 0 });
    const s = sessionWith([msg("channel", "a", "早")]);
    s.recordOwn("Her", me, "早啊", newId(), Date.now());
    const reply = [msg("channel", "a", "妳今天幹嘛")];
    s.recordMessage(reply[0] as IncomingMessage, false);
    let a = run(cfg, "ambient", s, reply);
    expect(a.reasons.some((r) => r.startsWith("follow-up"))).toBe(true);
    expect(sample(a)).toBeGreaterThanOrEqual(0.6);

    const strict = { ...cfg, cooldown_ms: 60_000 };
    a = run(strict, "ambient", s, reply);
    expect(a.gate).toEqual({ kind: "ignore" });
    expect(a.reasons.some((r) => r.startsWith("cooldown"))).toBe(true);

    for (let i = 0; i < 10; i++) s.recordOwn("Her", me, "spam", newId(), Date.now());
    a = run(cfg, "ambient", s, reply);
    expect(a.gate).toEqual({ kind: "ignore" });
    expect(a.reasons.some((r) => r.startsWith("anti-spam"))).toBe(true);
  });

  it("interests_raise_salience", () => {
    const cfg = config({ llm_check: false });
    const busy = busyChatter();
    const q = [msg("channel", "p1", "昨天去看了深海紀錄片")];
    const s = sessionWith(busy);
    s.recordMessage(q[0] as IncomingMessage, false);
    const plain = run(cfg, "ambient", s, q);
    const a = runWith(cfg, "ambient", "medium", ["Minecraft", "深海"], s, q);
    expect(a.score, a.reasons.join("; ")).toBeGreaterThan(plain.score + 0.15);
    expect(a.reasons.some((r) => r.includes("topic `深海`"))).toBe(true);
  });

  it("ascii_topics_match_whole_words", () => {
    expect(mentionsTopic("我在玩ai畫圖", "AI")).toBe(true);
    expect(mentionsTopic("ai is cool", "AI")).toBe(true);
    expect(mentionsTopic("she said hi", "AI")).toBe(false);
    expect(mentionsTopic("今天玩 minecraft!", "Minecraft")).toBe(true);
    expect(mentionsTopic("鯨魚好大", "魚")).toBe(true);
    expect(mentionsTopic("anything", " ")).toBe(false);
  });

  it("activeness_scales_ambient_probability_and_cooldown", () => {
    const cfg = config({ llm_check: false, cooldown_ms: 10_000 });
    const q = [msg("channel", "a", "你們看過鯨魚嗎?")];
    let s = sessionWith(q);
    const medium = sample(run(cfg, "ambient", s, q));
    const low = sample(runWith(cfg, "ambient", "low", [], s, q));
    const high = sample(runWith(cfg, "ambient", "high", [], s, q));
    expect(Math.abs(low - medium * 0.5)).toBeLessThan(1e-6);
    expect(Math.abs(high - Math.min(medium * 1.6, 1))).toBeLessThan(1e-6);

    // Direct turns are not scaled.
    const named = [msg("channel", "a", "小鯨魚早安")];
    let a = runWith(cfg, "ambient", "low", [], s, named);
    expect(a.gate).toEqual({ kind: "sample", probability: 1 });

    // She spoke 7s ago: inside the normal cooldown, outside the high one.
    s = sessionWith(q);
    s.recordOwn("Her", me, "嗯", newId(), Date.now() - 7000);
    s.recordMessage(q[0] as IncomingMessage, false);
    a = run(cfg, "ambient", s, q);
    expect(a.reasons.some((r) => r.startsWith("cooldown"))).toBe(true);
    a = runWith(cfg, "ambient", "high", [], s, q);
    expect(a.reasons.some((r) => r.startsWith("cooldown"))).toBe(false);
    expect(a.gate.kind).toBe("sample");
  });

  function voiceRun(
    cfg: AttentionConfig,
    session: Session,
    inputs: IncomingMessage[],
    someoneSpeaking: boolean,
    interruptScale = 0,
  ): Assessment {
    return assess({
      config: cfg,
      mode: "ambient",
      activeness: "medium",
      names: NAMES,
      interests: [],
      maxShare: 0.3,
      session,
      inputs,
      now: Date.now(),
      voice: { someoneSpeaking, ambientFactor: 0.5, questionWindowMs: 8000, interruptScale },
      affinity: null,
      mood: null,
    });
  }

  it("voice_rules", () => {
    const cfg = config({ llm_check: false, cooldown_ms: 0 });
    const q = [msg("voice", "a", "你們看過鯨魚嗎?")];
    let s = sessionWith(q);
    const text = sample(run(cfg, "ambient", s, q));
    const voice = sample(voiceRun(cfg, s, q, false));
    expect(Math.abs(voice - text * 0.5)).toBeLessThan(1e-6);
    // With interrupt_scale 0 she never joins in while someone speaks...
    let a = voiceRun(cfg, s, q, true);
    expect(a.gate).toEqual({ kind: "ignore" });
    expect(a.reasons).toContain("someone is speaking");
    // ...otherwise the chance is scaled down, not zero.
    a = voiceRun(cfg, s, q, true, 0.4);
    expect(Math.abs(sample(a) - voice * 0.4)).toBeLessThan(1e-6);
    expect(a.reasons).toContain("someone is speaking ×0.40");
    // Direct address still counts either way.
    const named = [msg("voice", "a", "deep seek chan 妳覺得呢")];
    a = voiceRun(cfg, s, named, true);
    expect(a.direct, a.reasons.join("; ")).toBe(true);
    expect(a.gate).toEqual({ kind: "sample", probability: 1 });

    // A question right after she spoke addresses her.
    s = sessionWith([]);
    s.recordSpeech("Her", me, "我最喜歡深海了。", null, Date.now());
    const follow = [msg("voice", "a", "為什麼?")];
    s.recordUtterance(follow[0] as IncomingMessage);
    a = voiceRun(cfg, s, follow, false);
    expect(a.direct, a.reasons.join("; ")).toBe(true);
    // In text, the same question is not direct.
    expect(run(cfg, "ambient", s, follow).direct).toBe(false);
    const late = { ...(follow[0] as IncomingMessage), ts: toTimestamp(Date.now() + 30_000) };
    expect(voiceRun(cfg, s, [late], false).direct).toBe(false);

    // In voice, a reply to what she just said is not held back by her cooldown; in text it is.
    const slow = config({ llm_check: false, cooldown_ms: 60_000 });
    s = sessionWith([]);
    s.recordSpeech("Her", me, "我最喜歡深海了。", null, Date.now());
    const reply = [msg("voice", "a", "我也是耶")];
    s.recordUtterance(reply[0] as IncomingMessage);
    a = voiceRun(slow, s, reply, false);
    expect(
      a.reasons.some((r) => r.startsWith("cooldown")),
      a.reasons.join("; "),
    ).toBe(false);
    expect(a.reasons).toContain("follow-up to her +0.35");
    const inText = [msg("channel", "a", "我也是耶")];
    expect(run(slow, "ambient", s, inText).reasons.some((r) => r.startsWith("cooldown"))).toBe(
      true,
    );
  });

  it("affinity_and_energy_scale_ambient_turns", () => {
    const cfg = config({ llm_check: false, cooldown_ms: 10_000 });
    const names = ["小鯨魚"];
    const q = [msg("channel", "a", "你們看過鯨魚嗎?")];
    const named = [msg("channel", "a", "小鯨魚早安")];
    const assessWith = (
      s: Session,
      inputs: IncomingMessage[],
      affinity: number | null,
      mood: Mood | null,
    ) =>
      assess({
        config: cfg,
        mode: "ambient",
        activeness: "medium",
        names,
        interests: [],
        maxShare: 0.3,
        session: s,
        inputs,
        now: Date.now(),
        voice: null,
        affinity,
        mood,
      });
    let s = sessionWith(q);
    const base = sample(assessWith(s, q, null, null));
    const liked = assessWith(s, q, 100, null);
    expect(Math.abs(sample(liked) - Math.min(base * 1.4, 1))).toBeLessThan(1e-6);
    expect(Math.abs(liked.ambientScale - 1.4)).toBeLessThan(1e-6);
    const disliked = sample(assessWith(s, q, -100, null));
    expect(Math.abs(disliked - base * 0.3)).toBeLessThan(1e-6);

    // Direct address: answered unless affinity is very low.
    expect(assessWith(s, named, -79, null).gate).toEqual({ kind: "sample", probability: 1 });
    const hated = assessWith(s, named, -90, null);
    expect(Math.abs(sample(hated) - 0.4)).toBeLessThan(1e-6);

    const tired: Mood = { valence: 0, arousal: 0.5, energy: 0 };
    const fresh: Mood = { ...tired, energy: 1 };
    const low = sample(assessWith(s, q, null, tired));
    expect(Math.abs(low - base * 0.7)).toBeLessThan(1e-6);
    // She spoke 8 s ago: inside the cooldown (10 s; 13 s tired), outside the fresh one (7 s).
    s = sessionWith(q);
    s.recordOwn("Her", me, "嗯", newId(), Date.now() - 8000);
    s.recordMessage(q[0] as IncomingMessage, false);
    let a = assessWith(s, q, null, tired);
    expect(a.reasons.some((r) => r.startsWith("cooldown"))).toBe(true);
    a = assessWith(s, q, null, fresh);
    expect(a.reasons.some((r) => r.startsWith("cooldown"))).toBe(false);
  });

  it("sampling_is_seedable", () => {
    const fixed = (x: number): RandomSource => ({ nextF32: () => x });
    expect(decide(0.5, fixed(0.4))[0]).toBe(true);
    expect(decide(0.5, fixed(0.6))[0]).toBe(false);
    expect(decide(1.0, fixed(0.99))[0]).toBe(true);
    expect(decide(0.0, fixed(0.0))[0]).toBe(false);

    const [a, b] = [new SeededRandom(7), new SeededRandom(7)];
    for (let i = 0; i < 100; i++) {
      const x = a.nextF32();
      expect(x).toBe(b.nextF32());
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it("questions", () => {
    for (const q of ["真的嗎", "你在幹嘛?", "what is this", "這是什麼", "好吃吧~"]) {
      expect(isQuestion(q), q).toBe(true);
    }
    for (const s of ["今天好熱", "哈哈哈", "好喔!"]) {
      expect(isQuestion(s), s).toBe(false);
    }
  });

  it("seeded sequence matches the Rust SplitMix64", () => {
    // Reference SplitMix64 outputs for seed 0: e220a8397b1dcdaf, 6e789e6aa1b965f4,
    // 06c45d188009454f; the sample is the top 24 bits / 2^24.
    const r = new SeededRandom(0);
    expect([r.nextF32(), r.nextF32(), r.nextF32()]).toEqual([
      0xe220a8 / 2 ** 24,
      0x6e789e / 2 ** 24,
      0x06c45d / 2 ** 24,
    ]);
  });
});
