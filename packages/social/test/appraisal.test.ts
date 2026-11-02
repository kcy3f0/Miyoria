import { contentText } from "@miyoria/llm";
import { describe, expect, it } from "vitest";
import { AppraisalParseError, appraisalRequest, parseAppraisal, parseNotes } from "../src/index.js";

describe("appraisal parsing", () => {
  it("parses_common_shapes", () => {
    const a = parseAppraisal(
      '{"people":[{"person_name":"Owen","toward_her":0.6,"events":["praise","thanks"]}]}',
    );
    expect(a).toEqual([{ person_name: "Owen", toward_her: 0.6, events: ["praise", "thanks"] }]);

    const fenced = '```json\n[{"name":"Bob","toward_her":"-2","events":[{"type":"insult"}]}]\n```';
    const b = parseAppraisal(fenced);
    expect(b[0]?.person_name).toBe("Bob");
    expect(b[0]?.toward_her, "clamped").toBe(-1);
    expect(b[0]?.events).toEqual(["insult"]);

    const single = parseAppraisal(
      '好的,結果如下:{"person_name":"小明","toward_her":0,"events":[]} 以上',
    );
    expect(single).toHaveLength(1);
    expect(single[0]?.events).toEqual([]);
  });

  it("rejects_garbage_and_skips_nameless", () => {
    expect(() => parseAppraisal("I cannot do that")).toThrow(AppraisalParseError);
    expect(parseAppraisal('{"people":[{"toward_her":1}]}')).toEqual([]);
  });

  it("parses_notes", () => {
    expect(parseNotes('{"notes":"很愛講冷笑話的人。"}')).toBe("很愛講冷笑話的人。");
    expect(parseNotes("  是個好人  ")).toBe("是個好人");
    expect(parseNotes('{"notes":"  "}')).toBeNull();
    expect([...(parseNotes("長".repeat(300)) ?? "")]).toHaveLength(201);
  });

  it("accepts event strings and keeps old lines as context", () => {
    const [p] = parseAppraisal('{"results":[{"person":"A","events":"praise、 gift"}]}');
    expect(p).toEqual({ person_name: "A", toward_her: 0, events: ["praise", "gift"] });

    const req = appraisalRequest(
      "DS",
      [
        { speaker: "A", text: "舊的", old: true },
        { speaker: "B", text: "新的\n第二行", old: false },
      ],
      ["B"],
    );
    expect(req.json_mode).toBe(true);
    expect(req.temperature).toBe(0.2);
    expect(req.max_tokens).toBe(2000);
    expect(req.messages[1]?.content).toBe(
      "【前情,已評估過】\nA: 舊的\n\n【新的對話】\nB: 新的 第二行\n",
    );
    expect(contentText(req.messages[0]?.content ?? "").endsWith("只列出這些人:B")).toBe(true);
  });
});
