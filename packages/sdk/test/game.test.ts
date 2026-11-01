import { describe, expect, it } from "vitest";
import type { GameAdapter, GameEvent } from "../src/game.js";
import { ErrorCode } from "../src/types.js";
import { fakeHost, toolContext, waitFor } from "./helpers.js";

function adapter(events: GameEvent[]): GameAdapter & { acted: unknown[] } {
  const acted: unknown[] = [];
  return {
    acted,
    describe: () => ({
      id: "mc",
      name: "Minecraft",
      actions: [
        { name: "goto", description: "走到某處", parameters: { type: "object" } },
        { name: "chat", description: "說話" },
      ],
      prompt: "你正在玩 Minecraft。",
    }),
    observe: async () => ({ state: { hp: 20 }, summary: "白天,血量全滿" }),
    act: async (action) => {
      acted.push(action);
      return { ok: true, message: `did ${action.name}` };
    },
    async *events() {
      for (const e of events) yield e;
    },
  };
}

describe("game adapter helper", () => {
  it("maps an adapter onto tools, a prompt and events", async () => {
    const game = adapter([
      { type: "death", data: { cause: "creeper" }, important: true },
      { type: "Bad Type" },
      { type: "player.joined", data: { name: "Owen" } },
    ]);
    const h = fakeHost({
      async activate(ctx) {
        const reg = await ctx.game.registerAdapter(game);
        expect(reg.info.id).toBe("mc");
      },
    });
    const result = await h.initialize();
    expect(result.contributions.tools.map((t) => t.name)).toEqual(["game.mc.observe", "game.mc.act"]);
    expect(result.contributions.tools[1]?.parameters).toMatchObject({
      required: ["action"],
      properties: { action: { enum: ["goto", "chat"] } },
    });
    expect(result.contributions.prompts).toEqual(["game.mc"]);

    const call = (name: string, args: unknown) =>
      h.host.request<{ content: string }>("tools.call", { name, args, context: toolContext });
    expect((await call("game.mc.observe", {})).content).toBe('白天,血量全滿\n\n狀態:{"hp":20}');
    expect((await call("game.mc.act", { action: "goto", args: { x: 1 } })).content).toBe("成功:did goto");
    expect(game.acted).toEqual([{ name: "goto", args: { x: 1 } }]);
    expect((await call("game.mc.act", { action: "fly" })).content).toContain("失敗");

    const prompt = await h.host.request("prompt.contribute", { key: "game.mc", request: {} });
    expect(prompt).toEqual({
      sections: [{ key: "game.mc", title: "Minecraft", body: "你正在玩 Minecraft。", order: 50 }],
    });

    await waitFor(() => h.requests.filter((r) => r.method === "events.publish").length === 2);
    const published = h.requests.filter((r) => r.method === "events.publish").map((r) => r.params);
    expect(published).toEqual([
      { topic: "game.mc.death", payload: { type: "death", data: { cause: "creeper" }, important: true } },
      { topic: "game.mc.player.joined", payload: { type: "player.joined", data: { name: "Owen" } } },
    ]);
    expect(h.notifications.some((n) => n.method === "log")).toBe(true);
  });

  it("rejects invalid game ids", async () => {
    const bad = adapter([]);
    bad.describe = () => ({ id: "Not Valid", name: "x", actions: [] });
    const h = fakeHost({
      async activate(ctx) {
        await ctx.game.registerAdapter(bad);
      },
    });
    await expect(h.initialize()).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });
});
