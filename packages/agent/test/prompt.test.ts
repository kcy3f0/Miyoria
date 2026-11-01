import { assistantMessage, systemMessage, userMessage } from "@miyoria/llm";
import type { ContextKey, PromptSection } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  ADDRESSED,
  AMBIENT,
  buildMessages,
  checkMessages,
  cleanReply,
  type HistoryEntry,
  INITIATIVE,
  INITIATIVE_HINT,
  INITIATIVE_SILENCE,
  renderSections,
  situationPrompt,
  splitMessage,
  VOICE_ADDRESSED,
  VOICE_INITIATIVE,
} from "../src/index.js";
import { entry } from "./fixtures.js";

const utc = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi, 0));

describe("prompt", () => {
  it("builds_role_mapped_merged_history", () => {
    const history = [
      entry("Owen", "早安", false),
      entry("阿明", "安安", false),
      entry("DS", "早啦", true),
      entry("Owen", "吃了沒", false),
    ];
    const msgs = buildMessages("PERSONA", "SITUATION", history);
    expect(msgs.length).toBe(5);
    expect(msgs[0]).toEqual(systemMessage("PERSONA"));
    expect(msgs[1]).toEqual(userMessage("Owen: 早安\n阿明: 安安"));
    expect(msgs[2]).toEqual(assistantMessage("早啦"));
    expect(msgs[3]).toEqual(userMessage("Owen: 吃了沒"));
    expect(msgs[4]).toEqual(systemMessage("SITUATION"));
  });

  it("situation_mentions_place_people_and_rules", () => {
    const ctx: ContextKey = {
      platform: "discord",
      scope: "g",
      channel: "general",
      kind: "channel",
    };
    const s = situationPrompt(
      { context: ctx, present: ["Owen", "阿明"], direct: false, initiative: null, notes: [] },
      utc(2026, 11, 1, 14, 3),
      0,
    );
    expect(s).toContain("2026-11-01 14:03(星期日)");
    expect(s).toContain("discord 的頻道 general");
    expect(s).toContain("Owen、阿明");
    expect(s).toContain(AMBIENT);
    expect(s).toContain("<silence/>");
  });

  it("marks_spoken_and_interrupted_lines", () => {
    const history: HistoryEntry[] = [
      { ...entry("Owen", "妳在嗎", false), spoken: true },
      { ...entry("DS", "在啊,幹嘛", true), spoken: true, interrupted: true },
      entry("阿明", "打字的", false),
    ];
    const msgs = buildMessages("P", "S", history);
    expect(msgs[1]).toEqual(userMessage("Owen(語音): 妳在嗎"));
    expect(msgs[2]).toEqual(assistantMessage("在啊,幹嘛(被打斷)"));
    expect(msgs[3]).toEqual(userMessage("阿明: 打字的"));
    const check = checkMessages("DS", history);
    expect(check[1]?.content).toContain("DS(她自己): 在啊,幹嘛(被打斷)");
    expect(check[1]?.content).toContain("Owen(語音): 妳在嗎");
  });

  it("voice_situation_has_speech_rules", () => {
    const ctx: ContextKey = { platform: "discord", scope: "g", channel: "lounge", kind: "voice" };
    const s = situationPrompt(
      { context: ctx, present: ["Owen", "阿明"], direct: true, initiative: null, notes: [] },
      utc(2026, 11, 1, 22, 0),
      0,
    );
    expect(s).toContain("語音頻道 lounge");
    expect(s).toContain("語音頻道裡的人:Owen、阿明");
    expect(s).toContain("一到兩句");
    expect(s).toContain("emoji");
    expect(s).toContain("<emo:名稱>");
    expect(s).toContain(VOICE_ADDRESSED);
    expect(s).not.toContain(ADDRESSED);
  });

  it("initiative_situation_and_notes", () => {
    const ctx: ContextKey = {
      platform: "discord",
      scope: "g",
      channel: "general",
      kind: "channel",
    };
    const notes = ["你現在的狀態:心情不錯", "你對 Owen 的態度:親近"];
    const now = utc(2026, 11, 1, 9, 0);
    let s = situationPrompt(
      { context: ctx, present: [], direct: false, initiative: "問 Owen 考試考得怎樣", notes },
      now,
      0,
    );
    expect(s).toContain(INITIATIVE);
    expect(s).toContain("你想到可以聊的:問 Owen 考試考得怎樣。");
    expect(s).toContain(INITIATIVE_SILENCE);
    expect(s).not.toContain(AMBIENT);
    expect(s).toContain("\n- 你現在的狀態:心情不錯\n- 你對 Owen 的態度:親近\n");

    s = situationPrompt(
      { context: { ...ctx, kind: "voice" }, present: [], direct: false, initiative: "", notes: [] },
      now,
      0,
    );
    expect(s).toContain(VOICE_INITIATIVE);
    expect(s).not.toContain(INITIATIVE_HINT);
  });

  const section = (key: string, order: number, body: string): PromptSection => ({
    key,
    title: `標題${key}`,
    body,
    order,
  });

  it("sections_are_ordered_and_capped", () => {
    const sections = [
      section("b", 10, "第二"),
      section("a", 0, "第一"),
      section("c", 10, "第三"),
      section("empty", -5, "  "),
    ];
    expect(renderSections(sections, 4000)).toBe(
      "## 標題a\n第一\n\n## 標題b\n第二\n\n## 標題c\n第三",
    );
    // Room for the first block only.
    expect(renderSections(sections, 12)).toBe("## 標題a\n第一");
    expect(renderSections([], 100)).toBeNull();

    const long = [section("a", 0, "短"), section("b", 1, "長".repeat(100))];
    const out = renderSections(long, 60) as string;
    expect([...out].length).toBe(60);
    expect(out.startsWith("## 標題a\n短\n\n## 標題b\n長")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("strips_copied_name_prefix", () => {
    const names = ["DeepSeek-chan", "DeepSeek"];
    expect(cleanReply("DeepSeek-chan: 哼", names)).toBe("哼");
    expect(cleanReply(" deepseek:早啦 ", names)).toBe("早啦");
    expect(cleanReply("DeepSeek 是我", names)).toBe("DeepSeek 是我");
    expect(cleanReply("說:好", names)).toBe("說:好");
  });

  it("splits_long_messages", () => {
    expect(splitMessage("短短的", 1900)).toEqual(["短短的"]);
    expect(splitMessage("   ", 10)).toEqual([]);

    const text = `${"啊".repeat(8)}。${"嗯".repeat(8)}`;
    expect(splitMessage(text, 10)).toEqual([`${"啊".repeat(8)}。`, "嗯".repeat(8)]);

    const hard = "x".repeat(25);
    const parts = splitMessage(hard, 10);
    expect(parts.length).toBe(3);
    expect(parts.every((p) => [...p].length <= 10)).toBe(true);
    expect(parts.join("")).toBe(hard);

    const lines = `a b c d e\n${"f".repeat(8)}`;
    expect(splitMessage(lines, 12)).toEqual(["a b c d e", "f".repeat(8)]);
  });
});
