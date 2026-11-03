// osu! AI player tools. The AI itself (a reinforcement-learning model that plays lazer multiplayer rooms) is
// osu_rl's live.service; this extension only turns its HTTP API into tools.
//
// The account guard: live.service plays with whatever account its own settings name, and nothing here can
// see those. So before every call it asks live.service who it is logged in as, and refuses unless that is
// exactly `account` (the AI's own account) and none of `blocked_accounts` (the owner's). A live.service set
// up with a person's account never gets a single request from her.

import { defineExtension } from "@miyoria/sdk";

/** `[extensions."miyoria.osu"]` config (everything optional). */
interface OsuConfig {
  url?: string;
  token?: string;
  public_url?: string;
  request_timeout_ms?: number;
  /** The AI's own account on the osu! server; nothing runs until live.service is logged in as it. */
  account?: string;
  /** Accounts the AI must never use (the owner's), refused even if `account` names one of them. */
  blocked_accounts?: string[];
}

/** Account names compare without case or surrounding spaces, like the osu! server's. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Why live.service, logged in as `user`, may not be used, or `null` when it may.
 */
export function accountProblem(
  user: unknown,
  account: string,
  blocked: readonly string[],
): string | null {
  if (!account.trim()) return "沒有設定 AI 帳號(account),不使用 osu! AI";
  if (blocked.some((b) => sameName(b, account)))
    return "設定的 AI 帳號在 blocked_accounts 裡,不使用";
  if (typeof user !== "string" || !user.trim()) return "osu! AI 還沒登入,不知道它用的是哪個帳號";
  if (blocked.some((b) => sameName(b, user)))
    return `osu! AI 登入的是不能用的帳號(${user}),拒絕使用`;
  if (!sameName(user, account)) return `osu! AI 登入的帳號(${user})不是設定的 AI 帳號,拒絕使用`;
  return null;
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
    const account = config.account ?? process.env.MIYORIA_OSU_ACCOUNT ?? "";
    const blocked = config.blocked_accounts ?? [];
    if (!token)
      ctx.log.warn(
        "no live.service token (config token / MIYORIA_OSU_TOKEN); every call will be refused",
      );
    if (!account.trim())
      ctx.log.warn(
        "no AI account (config account / MIYORIA_OSU_ACCOUNT); every call will be refused",
      );

    async function request(
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
      let res: Response;
      try {
        res = await fetch(base + path, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { ok: false, error: `連不到 osu! AI 服務(${String(error)})` };
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return { ok: false, error: String(data.error ?? res.status) };
      return { ok: true, data };
    }

    async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
      // Who live.service is logged in as, checked before every call (it can be restarted with
      // other settings at any time).
      const who = await request("GET", "/status");
      if (!who.ok) return `失敗:${who.error}`;
      const problem = accountProblem(who.data.user, account, blocked);
      if (problem !== null) {
        ctx.log.error("osu! AI refused: wrong account", { user: String(who.data.user ?? "") });
        return `失敗:${problem}`;
      }
      if (method === "GET" && path === "/status") return JSON.stringify(who.data);
      const r = await request(method, path, body);
      if (!r.ok) return `失敗:${r.error}`;
      const data = r.data;
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

    ctx.log.info("osu extension activated", { url: base, account });
  },
});
