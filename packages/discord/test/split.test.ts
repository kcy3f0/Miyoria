import { describe, expect, test } from "vitest";
import { MAX_MESSAGE_LEN, splitMessage } from "../src/split.js";

const units = (s: string): number => s.length; // JS string length is UTF-16 code units

describe("splitMessage", () => {
  test("short_text_is_one_chunk", () => {
    expect(splitMessage("hello", 2000)).toEqual(["hello"]);
    expect(splitMessage("  \n ", 2000)).toEqual([]);
  });

  test("prefers_newlines_then_spaces", () => {
    expect(splitMessage("aaaa bbbb\ncccc dddd", 12)).toEqual(["aaaa bbbb", "cccc dddd"]);
    expect(splitMessage("aaaa bbbb cccc", 10)).toEqual(["aaaa bbbb", "cccc"]);
  });

  test("cjk_without_spaces_breaks_after_punctuation", () => {
    const sentence = "今天天氣很好,我們去散步吧。";
    const text = sentence.repeat(300);
    const chunks = splitMessage(text, MAX_MESSAGE_LEN);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(units(c)).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
      expect(c.endsWith("。"), c).toBe(true);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("hard_cuts_respect_char_boundaries", () => {
    const text = "喵".repeat(4500);
    const chunks = splitMessage(text, MAX_MESSAGE_LEN);
    expect(chunks.map((c) => Array.from(c).length)).toEqual([2000, 2000, 500]);
    expect(chunks.join("")).toBe(text);
  });

  test("emoji_count_as_two_units", () => {
    const text = "😀".repeat(1500);
    const chunks = splitMessage(text, MAX_MESSAGE_LEN);
    expect(Array.from(chunks[0] as string)).toHaveLength(1000);
    expect(chunks.join("")).toBe(text);
    // Tiny limits still fit one character per chunk.
    expect(splitMessage("😀😀", 1)).toEqual(["😀", "😀"]);
  });

  test("never_produces_lone_surrogates_or_oversized_chunks", () => {
    const text = "a😀".repeat(2500);
    for (const chunk of splitMessage(text, MAX_MESSAGE_LEN)) {
      expect(units(chunk)).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
      const lone = Array.from(chunk).some((ch) => {
        const code = ch.charCodeAt(0);
        return ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
      });
      expect(lone).toBe(false);
    }
  });

  test("breaks_on_the_last_newline_in_the_second_half_only", () => {
    // A newline in the first half is ignored: the cut happens mid-word instead.
    const text = `ab\n${"c".repeat(20)}`;
    expect(splitMessage(text, 10)).toEqual(["ab\nccccccc", "cccccccccc", "ccc"]);
  });
});
