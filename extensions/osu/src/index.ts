// osu! AI player tools. The AI itself (a reinforcement-learning model that plays lazer multiplayer rooms) is
// osu_rl's live.service; this extension only turns its HTTP API into tools.

import { defineExtension } from "@miyoria/sdk";

/** `[extensions."miyoria.osu"]` config (everything optional). */
interface OsuConfig {
  url?: string;
  token?: string;
  public_url?: string;
  request_timeout_ms?: number;
}

const LEVELS = ["easy", "normal", "hard", "expert"];
const LEVEL = {
  type: "string",
  enum: LEVELS,
  description: "AI 的強度:easy 約 72%、normal 約 97%、hard 約 98%、expert 約 99% 準度",
};
const PLAY = "tools.osu.play";

export default defineExtension({
  async activate(ctx) {
    const config = ctx.config as OsuConfig;
    const base = (config.url ?? process.env.MIYORIA_OSU_URL ?? "http://127.0.0.1:8765").replace(
      /\/+$/,
      "",
    );
    const token = config.token ?? process.env.MIYORIA_OSU_TOKEN ?? "";
    const publicBase = (config.public_url ?? process.env.MIYORIA_OSU_PUBLIC_URL ?? base).replace(
      /\/+$/,
      "",
    );
    const timeoutMs = config.request_timeout_ms ?? 120_000;
    if (!token)
      ctx.log.warn(
        "no live.service token (config token / MIYORIA_OSU_TOKEN); every call will be refused",
      );

    async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
      let res: Response;
      try {
        res = await fetch(base + path, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return `失敗:連不到 osu! AI 服務(${String(error)})`;
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return `失敗:${String(data.error ?? res.status)}`;
      if (typeof data.replay_url === "string") data.replay_url = publicBase + data.replay_url;
      return JSON.stringify(data);
    }

    await ctx.tools.register({
      name: "osu_ai.status",
      description:
        "看 osu! AI 玩家現在在做什麼:在哪個房間、什麼難度、這張譜準備好了沒、是不是正在打,還有上一場的成績。",
      run: () => call("GET", "/status"),
    });

    await ctx.tools.register({
      name: "osu_ai.list_rooms",
      description:
        "列出 osu! 伺服器上開著的 lazer 多人房(id、名稱、房主、有沒有密碼、人數),用來挑一間讓 AI 進去。",
      run: () => call("GET", "/rooms"),
    });

    await ctx.tools.register({
      name: "osu_ai.join_room",
      description:
        "把 osu! AI 玩家送進一間 lazer 多人房。它會先準備房間目前的譜(約 10–30 秒),好了就自己按準備,之後房主每開一輪都會一起打。",
      params: {
        room_id: { type: "integer", description: "房間 id,從 osu_ai_list_rooms 或房間連結拿" },
        password: { type: "string", description: "房間密碼(有的話)" },
        level: LEVEL,
      },
      optional: ["password", "level"],
      permission: PLAY,
      run: ({ room_id, password, level }) => call("POST", "/join", { room_id, password, level }),
    });

    await ctx.tools.register({
      name: "osu_ai.leave_room",
      description: "讓 osu! AI 玩家離開目前的房間。",
      permission: PLAY,
      run: () => call("POST", "/leave"),
    });

    await ctx.tools.register({
      name: "osu_ai.set_level",
      description: "換 osu! AI 玩家的強度,下一輪開始生效。",
      params: { level: LEVEL },
      permission: PLAY,
      run: ({ level }) => call("POST", "/level", { level }),
    });

    await ctx.tools.register({
      name: "osu_ai.play_map",
      description:
        "讓 osu! AI 單獨打一張譜(不進房間),回傳準度、評級、分數、combo、判定統計和 replay 下載連結。沒打過的譜要 10–30 秒以上。",
      params: {
        beatmap_id: { type: "integer", description: "譜面(難度)在 osu! 伺服器上的 id" },
        level: LEVEL,
        mods: {
          type: "array",
          items: { type: "string" },
          description: 'mod 縮寫,例如 ["HD", "DT"]。AI 只練過沒有 mod 的譜,開 HR、DT 會打得比較差',
        },
      },
      optional: ["level", "mods"],
      permission: PLAY,
      run: ({ beatmap_id, level, mods }) =>
        call("POST", "/play", {
          beatmap_id,
          level,
          mods: Array.isArray(mods)
            ? mods.map((acronym) => ({ acronym: String(acronym).toUpperCase() }))
            : [],
        }),
    });

    ctx.log.info("osu extension activated", { url: base });
  },
});
