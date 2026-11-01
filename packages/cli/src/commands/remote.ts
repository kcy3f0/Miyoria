// CLI commands that talk to a running core through the Admin API.

import { ApiClient } from "@miyoria/api";
import type { Config } from "@miyoria/kernel";
import type { ModuleStateKind } from "@miyoria/types";
import { eventTopic } from "@miyoria/types";
import { cyan, dim, green, println, red, yellow } from "../ui.js";

export const DEFAULT_API_BIND = "127.0.0.1:7878";

export class RemoteError extends Error {
  override readonly name = "RemoteError";
}

/** Client for the core described by `config` (`[modules.api]`). */
export function clientFor(config: Config): ApiClient {
  const section = config.module("api").config;
  const obj =
    section !== null && typeof section === "object" && !Array.isArray(section) ? section : {};
  const bind = typeof obj.bind === "string" && obj.bind !== "" ? obj.bind : DEFAULT_API_BIND;
  const token = typeof obj.token === "string" ? obj.token : "";
  if (token === "") throw new RemoteError("沒有設定 MIYORIA_API_TOKEN(執行 `miyoria init` 產生)");
  // A wildcard bind address is reachable locally through loopback.
  const host = bind.replace("0.0.0.0", "127.0.0.1").replace("[::]", "[::1]");
  return new ApiClient(`http://${host}`, token);
}

/** `true` when a core answers `/api/health` within `timeoutMs`. */
export async function isRunning(client: ApiClient, timeoutMs = 2000): Promise<boolean> {
  try {
    await client.health({ signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

export function stateLabel(state: ModuleStateKind): string {
  switch (state) {
    case "running":
      return green("running");
    case "degraded":
      return yellow("degraded");
    case "failed":
      return red("failed");
    case "disabled":
      return dim("disabled");
    default:
      return state;
  }
}

export async function modules(client: ApiClient): Promise<void> {
  for (const m of await client.modules()) {
    const reason = m.reason === null ? "" : `  (${m.reason})`;
    println(`${m.id.padEnd(24)} ${stateLabel(m.state)}${reason}`);
  }
}

export async function moduleAction(client: ApiClient, id: string, action: string): Promise<void> {
  const m = await client.moduleAction(id, action);
  println(`${m.id} → ${stateLabel(m.state)}`);
}

export async function status(client: ApiClient): Promise<void> {
  const health = await client.health();
  println(`core ${health.version}  ${health.status}\n`);
  await modules(client);
  const usage = await client.usage();
  if (usage.size > 0) {
    println("\nLLM 用量(啟動以來)");
    for (const [model, u] of usage) {
      println(
        `  ${model}: ${u.calls} 次,輸入 ${u.prompt_tokens}(快取 ${u.cached_prompt_tokens}),輸出 ${u.completion_tokens}`,
      );
    }
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local `MM-DD HH:MM:SS`. */
function localStamp(ts: string, withDate: boolean): string {
  const d = new Date(Date.parse(ts));
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return withDate ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}` : time;
}

export async function decisions(client: ApiClient, limit: number): Promise<void> {
  for (const d of await client.decisions(limit)) {
    const t = d.trace;
    println(
      `${localStamp(d.ts, true)} ${t.respond ? "回" : "略"} ${t.context.channel.padEnd(5)} ${t.score.toFixed(2)}  ${t.context.platform}  ${t.reasons.join(";")}`,
    );
  }
}

export async function personaShow(client: ApiClient): Promise<void> {
  for (const s of await client.persona()) {
    println(`${cyan(`## ${s.key}`)}(${[...s.body].length} 字)\n${s.body}\n`);
  }
}

export async function personaSet(client: ApiClient, key: string, body: string): Promise<void> {
  const version = await client.setPersonaAs(key, body, "cli");
  println(`${green("✓")} \`${key}\` 已更新為第 ${version} 版,下一輪對話生效`);
}

export async function events(
  client: ApiClient,
  topics: string[],
  signal?: AbortSignal,
): Promise<void> {
  const filter = topics.length === 0 ? ["*"] : topics;
  const stream = await client.events(filter, signal ? { signal } : {});
  try {
    for await (const env of stream) {
      println(
        `${localStamp(env.ts, false)} ${eventTopic(env.event).padEnd(26)} ${JSON.stringify(env.event)}`,
      );
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    stream.close();
  }
}
