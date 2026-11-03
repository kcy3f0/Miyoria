// HTTP client of osu_rl's live.service (the AI player), shared by the tools and the game adapter.
//
// The account guard: live.service plays with whatever account its own settings name, and nothing here can
// see those. So before every call it asks live.service who it is logged in as, and refuses unless that is
// exactly `account` (the AI's own account) and none of `blocked_accounts` (the owner's). A live.service set
// up with a person's account never gets a single request from her.

export interface Reply {
  ok: boolean;
  /** The JSON body; `{ error }` when the call failed or was refused. */
  data: Record<string, unknown>;
}

export type Call = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs?: number,
) => Promise<Reply>;

export function client(base: string, token: string, timeoutMs: number): Call {
  return async (method, path, body, timeout = timeoutMs) => {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError")
        return { ok: false, data: { error: "osu! AI 服務太久沒回應", timed_out: true } };
      return { ok: false, data: { error: `連不到 osu! AI 服務(${String(error)})` } };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok && data.error === undefined) data.error = res.status;
    return { ok: res.ok, data };
  };
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

/**
 * `call` behind the account guard: every request first asks who live.service is logged in as (it can be
 * restarted with other settings at any time) and is refused, unsent, unless that is the AI's account.
 * `refused` hears about each refusal.
 */
export function guarded(
  call: Call,
  account: string,
  blocked: readonly string[],
  refused: (user: string) => void,
): Call {
  return async (method, path, body, timeoutMs) => {
    const who = await call("GET", "/status", undefined, timeoutMs);
    if (!who.ok) return who;
    const problem = accountProblem(who.data.user, account, blocked);
    if (problem !== null) {
      refused(String(who.data.user ?? ""));
      return { ok: false, data: { error: problem } };
    }
    if (method === "GET" && path === "/status") return who;
    return call(method, path, body, timeoutMs);
  };
}
