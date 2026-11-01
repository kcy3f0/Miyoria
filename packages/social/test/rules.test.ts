import { describe, expect, it } from "vitest";
import { classify } from "../src/index.js";

describe("rules", () => {
  it("detects_kinds_in_three_languages", () => {
    expect(classify("DS醬謝謝你!")).toEqual(["thanks"]);
    expect(classify("ありがとう、かわいいね")).toEqual(["thanks", "praise"]);
    expect(classify("Thanks, you're awesome")).toEqual(["thanks", "praise"]);
    expect(classify("早安~")).toEqual(["greeting"]);
    expect(classify("你這個智障")).toEqual(["insult"]);
    expect(classify("閉嘴啦智障")).toEqual(["insult"]);
    expect(classify("去死啦白痴")).toEqual(["harassment"]);
    expect(classify("給我看內褲")).toEqual(["flirt_too_far"]);
    expect(classify("baka")).toEqual(["rude"]);
  });

  it("respects_boundaries_and_negation", () => {
    expect(classify("this is high quality"), "hi inside a word").toEqual([]);
    expect(classify("你一點都不可愛")).toEqual([]);
    expect(classify("不謝")).toEqual([]);
    expect(classify("今天天氣不錯")).toEqual([]);
    expect(classify("hi there")).toEqual(["greeting"]);
    expect(classify("你好可愛")).toEqual(["praise"]);
    expect(classify("你好啊 DS醬")).toEqual(["greeting"]);
  });

  it("checks later matches when the first one is negated", () => {
    expect(classify("不可愛但是很可愛")).toEqual(["praise"]);
    expect(classify("Hi😀hi")).toEqual(["greeting"]);
  });
});
