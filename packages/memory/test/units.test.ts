// Pure functions: tokenizer, dates, parsing, scoring, scopes, triggers (Rust `tests/units.rs`).

import type { MemoryScope } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  newId,
  type PersonId,
  type PromptRequest,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  ActivityTracker,
  type MemoryConfig,
  memoryConfig,
  parseExtraction,
  relativeDate,
  requestScopes,
  scopeForNew,
  signalScore,
  textSimilarity,
  tokenize,
  tokenOverlap,
  visibleScopes,
} from "../src/index.js";
import { acct, DAY, dmCtx, guildCtx, HOUR, MINUTE, profile, SECOND, T0_MS, t0 } from "./helpers.js";

describe("units", () => {
  it("tokenizes_chinese_with_jieba_and_drops_stop_words", () => {
    const tokens = tokenize("我超喜歡吃拉麵,尤其是豚骨拉麵!");
    expect(tokens.length).toBeGreaterThan(0);
    for (const stop of ["我", "是", ",", "!"]) expect(tokens).not.toContain(stop);
    // Queries are segmented the same way, so they match stored tokens.
    const query = tokenize("拉麵");
    expect(query.length).toBeGreaterThan(0);
    for (const t of query) expect(tokens).toContain(t);
    // Traditional and simplified text produce the same tokens.
    expect(tokenize("Owen 喜歡拉麵")).toEqual(tokenize("Owen 喜欢拉面"));
    expect(tokenize("Owen 下週三要看牙醫")).toContain(tokenize("牙醫")[0]);
  });

  it("tokenizes_japanese_and_english", () => {
    const ja = tokenize("ラーメンが大好きです");
    expect(ja).toContain("ラーメン");
    expect(ja).not.toContain("が");
    expect(ja).not.toContain("です");

    expect(tokenize("Owen LOVES the Ramen!")).toEqual(["owen", "loves", "ramen"]);
    expect(tokenize("Ｏｗｅｎ　ｏｗｅｎ")).toEqual(["owen"]);
    expect(tokenize("I'm a b c")).toEqual([]);
    expect(tokenize("Minecraft 2026")).toEqual(["minecraft", "2026"]);
  });

  it("text_similarity_ignores_case_and_punctuation", () => {
    expect(textSimilarity("Owen 喜歡拉麵。", "owen喜歡拉麵!")).toBe(1);
    expect(textSimilarity("Owen 喜歡拉麵", "Amy 討厭下雨天")).toBeLessThan(0.3);
    expect(textSimilarity("Owen 下週三要考期末考", "Owen 下週三要考期末考試")).toBeGreaterThan(
      0.85,
    );
    expect(textSimilarity("", "")).toBe(0);
  });

  it("relative_dates_in_chinese", () => {
    const now = t0();
    const cases: [number, string][] = [
      [10 * MINUTE, "剛剛"],
      [3 * HOUR, "三小時前"],
      [30 * HOUR, "昨天"],
      [2 * DAY, "前天"],
      [3 * DAY, "三天前"],
      [14 * DAY, "兩週前"],
      [60 * DAY, "兩個月前"],
      [400 * DAY, "一年前"],
      [15 * HOUR, "十五小時前"],
      [-5 * MINUTE, "剛剛"],
    ];
    for (const [ago, want] of cases) expect(relativeDate(t0(-ago), now), String(ago)).toBe(want);
  });

  it("parses_summarizer_json_leniently", () => {
    const text = `好的,以下是結果:
\`\`\`json
{"episode": {"summary": "我們聊了拉麵", "importance": "7", "emotion": "開心"},
 "facts": [
   {"subject_name": "Owen", "statement": "Owen 喜歡拉麵", "importance": 0.8, "confidence": 90, "global": "false"},
   {"subject_name": "self", "statement": "我不太會煮飯", "importance": 0.4, "confidence": 1, "global": false},
   123,
   {"subject_name": "Amy"}
 ],
 "self_notes": ["我答應 Owen 下次一起吃拉麵", {"note": "我覺得豚骨最好吃", "importance": 0.5}, {}],
 "followups": [{"subject_name": "Owen", "about": "問 Owen 拉麵店好不好吃", "due_in_hours": "48"}]
}
\`\`\``;
    const x = parseExtraction(text);
    const ep = x.episode;
    expect(ep?.summary).toBe("我們聊了拉麵");
    expect(Math.abs((ep?.importance ?? 0) - 0.7)).toBeLessThan(1e-6);
    expect(ep?.emotion).toBe("開心");
    expect(x.facts).toHaveLength(2);
    expect(x.facts[0]?.subject).toEqual({ type: "named", name: "Owen" });
    expect(Math.abs((x.facts[0]?.confidence ?? 0) - 0.9)).toBeLessThan(1e-6);
    expect(x.facts[0]?.global).toBe(false);
    expect(x.facts[1]?.subject).toEqual({ type: "myself" });
    expect(x.self_notes).toHaveLength(2);
    expect(x.followups[0]?.due_in_hours).toBe(48);
    expect(x.skipped).toBe(3);

    expect(() => parseExtraction("我不知道")).toThrow();
    expect(() => parseExtraction("{oops")).toThrow();
    expect(() => parseExtraction("[1, 2]")).toThrow();
    const empty = parseExtraction(`{"episode": null, "facts": "nope"}`);
    expect(empty.episode).toBeNull();
    expect(empty.facts).toEqual([]);
  });

  it("weighted_score", () => {
    const w = { vector: 1, text: 2, recency: 3, importance: 4, subject: 5 };
    const s = { vector: 0.5, text: 0.5, recency: 0.5, importance: 0.5, subject: 1 };
    expect(Math.abs(signalScore(s, w) - (0.5 + 1 + 1.5 + 2 + 5))).toBeLessThan(1e-6);
    expect(tokenOverlap(["a", "b"], "b c")).toBe(0.5);
    expect(tokenOverlap([], "b c")).toBe(0);
  });

  function request(context: ContextKey, people: [AccountRef, PersonId | null][]): PromptRequest {
    return {
      profile: profile(),
      turn: newId(),
      context,
      participants: people.map(([a, p]) => ({ account: a, display_name: a.id, person: p })),
      speakers: people.map(([a]) => a),
      query: "",
      recent: [],
      voice: false,
      now: t0(),
    };
  }

  const has = (scopes: MemoryScope[], scope: MemoryScope) =>
    scopes.some((s) => JSON.stringify(s) === JSON.stringify(scope));

  it("visible_scopes_per_context", () => {
    const owen = acct("2");
    const owenP = newId();
    const guild = guildCtx("g1", "c1");
    let scopes = requestScopes(request(guild, [[owen, owenP]]));
    expect(has(scopes, { type: "global" })).toBe(true);
    expect(has(scopes, { type: "guild", platform: "discord", guild: "g1" })).toBe(true);
    expect(has(scopes, { type: "channel", context: guild })).toBe(true);
    expect(has(scopes, { type: "person", person: owenP })).toBe(true);
    expect(
      scopes.some((s) => s.type === "dm"),
      "no DM scope in a guild",
    ).toBe(false);
    // Another guild's scope or another channel is not visible.
    expect(has(scopes, { type: "guild", platform: "discord", guild: "g2" })).toBe(false);
    expect(has(scopes, { type: "channel", context: guildCtx("g1", "c2") })).toBe(false);

    const dm = dmCtx("d1");
    scopes = requestScopes(request(dm, [[owen, null]]));
    expect(has(scopes, { type: "dm", account: owen })).toBe(true);
    expect(has(scopes, { type: "dm", account: acct("3") })).toBe(false);
    expect(visibleScopes(dm, [owen], []), "global, channel, dm").toHaveLength(3);
  });

  it("default_scopes_for_new_memories", () => {
    const cfg = memoryConfig();
    const owen = acct("2");
    const p = newId();
    const guild = guildCtx("g1", "c1");
    const dm = dmCtx("d1");
    const g: MemoryScope = { type: "guild", platform: "discord", guild: "g1" };
    const dmScope: MemoryScope = { type: "dm", account: owen };

    expect(scopeForNew(cfg, guild, null, "episode", null)).toEqual(g);
    expect(scopeForNew(cfg, guild, null, "fact", null)).toEqual(g);
    expect(scopeForNew(cfg, guild, null, "fact", p)).toEqual({ type: "person", person: p });
    expect(scopeForNew(cfg, guild, null, "self_note", null)).toEqual({ type: "global" });
    for (const kind of ["episode", "fact", "self_note", "followup"] as const) {
      // Global facts and self notes from a DM stay in the DM.
      expect(scopeForNew(cfg, dm, owen, kind, p)).toEqual(dmScope);
    }
    expect(scopeForNew(cfg, dm, null, "fact", null)).toEqual({ type: "channel", context: dm });

    const open: MemoryConfig = memoryConfig({ allow_global_from_dm: true, guild_scope: "channel" });
    expect(scopeForNew(open, dm, owen, "fact", p)).toEqual({ type: "person", person: p });
    expect(scopeForNew(open, guild, null, "episode", null)).toEqual({
      type: "channel",
      context: guild,
    });
  });

  it("activity_tracker_triggers_on_idle_or_count", () => {
    const cfg = memoryConfig({ consolidate_idle_secs: 300, consolidate_every_messages: 3 });
    const a = guildCtx("g", "a");
    const b = guildCtx("g", "b");
    const now = T0_MS;
    const t = new ActivityTracker();
    t.message(a, now);
    t.message(b, now);
    expect(t.due(now + 10 * SECOND, cfg)).toEqual([]);
    t.message(a, now);
    t.message(a, now);
    expect(t.due(now + 10 * SECOND, cfg)).toEqual([a]);
    const due = t.due(now + 301 * SECOND, cfg).sort((x, y) => (x.channel < y.channel ? -1 : 1));
    expect(due).toEqual([a, b]);

    t.failed(a, now + 400 * SECOND);
    expect(t.due(now + 301 * SECOND, cfg)).toEqual([b]);
    t.done(b);
    expect(t.pending(b)).toBe(0);
    expect(t.due(now + 401 * SECOND, cfg)).toEqual([a]);

    t.maybePending(b);
    expect(t.due(now, cfg)).toEqual([b]);
  });
});
