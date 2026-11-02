import { describe, expect, test } from "vitest";
import {
  attachmentLabel,
  type IncomingMessage,
  imageType,
  incomingText,
  PlatformHistories,
  type PlatformHistory,
} from "../src/index.js";

function msg(extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: { context: { platform: "t", scope: "g", channel: "c", kind: "channel" }, id: "1" },
    author: { account: { platform: "t", id: "a" }, display_name: "A", is_bot: false },
    text: " 看這個 ",
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: "2026-11-02T00:00:00.000Z",
    ...extra,
  };
}

describe("incoming messages", () => {
  test("image_type_from_content_type_or_extension", () => {
    const a = (filename: string, content_type: string | null) => ({
      url: "u",
      filename,
      content_type,
    });
    expect(imageType(a("x.bin", "image/png"))).toBe("image/png");
    expect(imageType(a("x.png", "image/jpeg; charset=binary"))).toBe("image/jpeg");
    expect(imageType(a("x.svg", "image/svg+xml"))).toBeNull();
    expect(imageType(a("x.WEBP", null))).toBe("image/webp");
    expect(imageType(a("notes.pdf", null))).toBeNull();
    expect(attachmentLabel({ ...a("x.gif", null), description: " 跳舞 " })).toBe(
      "[圖片: x.gif(跳舞)]",
    );
    expect(attachmentLabel(a("notes.pdf", "application/pdf"))).toBe("[附件: notes.pdf]");
  });

  test("text_notes_everything_inline_and_works_without_the_newer_fields", () => {
    expect(incomingText(msg())).toBe("看這個");
    const full = msg({
      text: "",
      stickers: [{ id: "1", name: "揮手" }],
      embeds: [{ title: null, description: null, url: "https://x" }],
      attachments: [{ url: "u", filename: "a.png", content_type: "image/png" }],
      forwarded: [
        { text: "", attachments: [], stickers: [], embeds: [] },
        { text: "原文", attachments: [], stickers: [], embeds: [] },
      ],
    });
    expect(incomingText(full)).toBe("[貼圖: 揮手] [嵌入: https://x] [圖片: a.png] [轉傳: 原文]");
  });

  test("histories_registry", () => {
    const reg = new PlatformHistories();
    const h: PlatformHistory = {
      platform: "t",
      recent: async () => [],
      fetch: async () => null,
    };
    reg.register(h);
    expect(reg.get("t")).toBe(h);
    reg.unregister("t");
    expect(reg.get("t")).toBeUndefined();
  });
});
