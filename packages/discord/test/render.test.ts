import { cardReply, confirm, notice } from "@miyoria/commands";
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import { describe, expect, test } from "vitest";
import {
  ACCENT_COLORS,
  disableComponents,
  MAX_V2_TEXT,
  renderModal,
  renderReply,
} from "../src/render.js";

describe("render", () => {
  test("cards_become_one_container", () => {
    const reply = cardReply(
      [
        { type: "text", text: "hello" },
        { type: "muted", text: "small\nprint" },
        { type: "separator" },
        { type: "section", text: "row", button: { id: "mi:a:1", label: "重新啟動" } },
        {
          type: "select",
          select: {
            id: "mi:a:pick",
            placeholder: "選擇",
            options: [{ label: "A", value: "a", description: "first" }],
          },
        },
      ],
      { title: "標題", accent: "success" },
    );
    const [payload] = renderReply(reply, true);
    expect(payload?.flags).toBe(MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
    const container = payload?.components[0];
    expect(container?.type).toBe(ComponentType.Container);
    if (container?.type !== ComponentType.Container) return;
    expect(container.accent_color).toBe(ACCENT_COLORS.success);
    const types = container.components.map((c) => c.type);
    expect(types).toEqual([
      ComponentType.TextDisplay,
      ComponentType.TextDisplay,
      ComponentType.TextDisplay,
      ComponentType.Separator,
      ComponentType.Section,
      ComponentType.ActionRow,
    ]);
    expect(container.components[0]).toEqual({
      type: ComponentType.TextDisplay,
      content: "### 標題",
    });
    expect(container.components[2]).toEqual({
      type: ComponentType.TextDisplay,
      content: "-# small\n-# print",
    });
  });

  test("confirm_cards_are_red_with_a_danger_button", () => {
    const [payload] = renderReply(
      confirm({ title: "清空", text: "確定？", confirmId: "mi:x:yes", cancelId: "mi:x:no" }),
      true,
    );
    const container = payload?.components[0];
    if (container?.type !== ComponentType.Container) throw new Error("no container");
    expect(container.accent_color).toBe(ACCENT_COLORS.danger);
    const row = container.components.at(-1);
    if (row?.type !== ComponentType.ActionRow) throw new Error("no row");
    expect(row.components.map((b) => (b.type === ComponentType.Button ? b.style : null))).toEqual([
      ButtonStyle.Danger,
      ButtonStyle.Secondary,
    ]);
  });

  test("plain_text_is_wrapped_and_long_text_split", () => {
    const short = renderReply({ text: "pong" }, false);
    expect(short).toHaveLength(1);
    expect(short[0]?.flags).toBe(MessageFlags.IsComponentsV2);
    expect(renderReply({ text: "x".repeat(MAX_V2_TEXT * 2) }, false).length).toBeGreaterThan(2);
    // An error notice keeps its text and muted detail.
    const [error] = renderReply(notice("error", "失敗。", "boom"), true);
    expect(JSON.stringify(error?.components)).toContain("-# boom");
  });

  test("files_are_attached_and_shown", () => {
    const [payload] = renderReply(
      cardReply([{ type: "text", text: "x" }], { files: [{ name: "a.json", data: "{}" }] }),
      true,
    );
    expect(payload?.files?.[0]?.name).toBe("a.json");
    expect(JSON.stringify(payload?.components)).toContain("attachment://a.json");
  });

  test("disable_and_modals", () => {
    const [payload] = renderReply(
      cardReply([
        {
          type: "buttons",
          buttons: [
            { id: "mi:a", label: "a" },
            { id: "x", label: "l", url: "https://x" },
          ],
        },
      ]),
      false,
    );
    const disabled = JSON.stringify(disableComponents(payload?.components ?? []));
    expect(disabled).toContain('"custom_id":"mi:a","label":"a","disabled":true');
    expect(disabled).toContain('"url":"https://x","label":"l","disabled":false');
    const modal = renderModal({
      id: "mi:w",
      title: "確認",
      fields: [{ id: "profile", label: "輸入 profile id", maxLength: 64 }],
    });
    expect(modal.custom_id).toBe("mi:w");
    expect(JSON.stringify(modal.components)).toContain('"max_length":64');
  });
});
