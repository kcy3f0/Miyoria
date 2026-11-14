import { describe, expect, it } from "vitest";
import {
  isStructuredStateLike,
  isTaskScreenshot,
  MAX_TASK_SCREENSHOT_CHARS,
  parseTaskScreenshot,
} from "../src/index.js";

const baseState = {
  at: "2026-11-13T00:00:00.000Z",
  state: { hp: 20 },
  task: null,
  summary: "hp 20",
};

describe("TaskScreenshot and isStructuredStateLike", () => {
  it("accepts non-screenshot StructuredState unchanged", () => {
    expect(isStructuredStateLike(baseState)).toBe(true);
  });

  it("validates and normalizes safe image/* screenshots", () => {
    const parsed = parseTaskScreenshot({
      mime: " IMAGE/PNG ",
      data: "iVBORw0KGgo=",
      detail: "high",
      alt: "過橋場景",
      extra: "ignored",
    });
    expect(parsed).toEqual({
      mime: "image/png",
      data: "iVBORw0KGgo=",
      detail: "high",
      alt: "過橋場景",
    });
    expect("extra" in (parsed ?? {})).toBe(false);
    expect(isTaskScreenshot({ mime: "image/jpeg", data: "Zm9v" })).toBe(true);
    expect(isTaskScreenshot({ mime: "image/webp", data: "Zm9v", detail: "auto" })).toBe(true);
    expect(isTaskScreenshot({ mime: "image/gif", data: "Zm9v==" })).toBe(true);
    expect(
      isStructuredStateLike({
        ...baseState,
        screenshot: { mime: "image/jpeg", data: "Zm9v", detail: "low" },
      }),
    ).toBe(true);
  });

  it("rejects unsafe mimes, invalid base64, oversized data, and bad metadata", () => {
    expect(isTaskScreenshot({ mime: "image/svg+xml", data: "PHN2Zz4=" })).toBe(false);
    expect(isTaskScreenshot({ mime: "text/html", data: "PGh0bWw+" })).toBe(false);
    expect(isTaskScreenshot({ mime: "image/png;base64", data: "Zm9v" })).toBe(false);
    expect(isTaskScreenshot({ mime: "image/png", data: "" })).toBe(false);
    expect(isTaskScreenshot({ mime: "image/png", data: "not base64!" })).toBe(false);
    expect(isTaskScreenshot({ mime: "image/png", data: "data:image/png;base64,Zm9v" })).toBe(false);
    expect(
      isTaskScreenshot({ mime: "image/jpeg", data: "A".repeat(MAX_TASK_SCREENSHOT_CHARS) }),
    ).toBe(true);
    expect(
      isTaskScreenshot({ mime: "image/jpeg", data: "A".repeat(MAX_TASK_SCREENSHOT_CHARS + 1) }),
    ).toBe(false);
    expect(isTaskScreenshot({ mime: "image/png", data: "Zm9v", detail: "ultra" })).toBe(false);
    expect(isTaskScreenshot({ mime: "image/png", data: "Zm9v", alt: 123 })).toBe(false);
    expect(isTaskScreenshot(null)).toBe(false);

    expect(
      isStructuredStateLike({
        ...baseState,
        screenshot: { mime: "image/svg+xml", data: "PHN2Zz4=" },
      }),
    ).toBe(false);
    expect(
      isStructuredStateLike({
        ...baseState,
        screenshot: null,
      }),
    ).toBe(false);
  });
});
