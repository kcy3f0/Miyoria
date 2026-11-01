// `miyoria doctor`: checks everything needed to run, one line per check.

import { dirname } from "node:path";
import { databaseUrl, loadProfile, resolveDatabaseUrl } from "@miyoria/core/light";
import { Config, errorMessage } from "@miyoria/kernel";

import { green, println, red } from "../ui.js";

/** Discord application flags for the message content intent. */
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

export class DoctorError extends Error {
  override readonly name = "DoctorError";
}

export async function run(configPath: string): Promise<void> {
  let failures = 0;
  const report = (ok: boolean, what: string, detail: string) => {
    if (!ok) failures++;
    println(`${ok ? green("✓") : red("✗")} ${what}  ${detail}`);
  };
  const baseDir = dirname(configPath);

  let config: Config;
  try {
    config = await Config.load(configPath);
    report(true, "設定檔", configPath);
  } catch (error) {
    report(false, "設定檔", `${errorMessage(error)}(先執行 \`miyoria init\`)`);
    throw new DoctorError("無法繼續檢查");
  }

  let profile: Awaited<ReturnType<typeof loadProfile>> | null = null;
  try {
    profile = await loadProfile(config, baseDir);
    report(true, "角色", `${profile.displayName}(${profile.sections.length} 個人格段落)`);
  } catch (error) {
    report(false, "角色", errorMessage(error));
  }

  // The full core (every module package) is only loaded for the checks that need it.
  const core = await import("@miyoria/core");
  const { collectResponse, modelRefString, userMessage } = await import("@miyoria/llm");

  if (profile) {
    try {
      const router = core.llmModule(config, profile).buildRouter();
      const chain = router.chain("chat");
      const started = performance.now();
      const stream = await router.stream(
        "chat",
        { messages: [userMessage("請只回答 OK")], max_tokens: 16 },
        AbortSignal.timeout(60_000),
      );
      const response = await collectResponse(stream);
      const first = chain[0] ? modelRefString(chain[0]) : "";
      report(
        true,
        "LLM",
        `${first} 回應「${response.text.trim()}」,${Math.round(performance.now() - started)} ms`,
      );
    } catch (error) {
      report(false, "LLM", errorMessage(error));
    }
  }

  const discord = config.module("platform.discord.bot");
  const section = discord.config;
  const token =
    section !== null &&
    typeof section === "object" &&
    !Array.isArray(section) &&
    typeof section.token === "string"
      ? section.token
      : "";
  if (!discord.enabled) report(true, "Discord", "已停用");
  else if (token === "") report(false, "Discord", "沒有設定 DISCORD_BOT_TOKEN");
  else {
    try {
      report(true, "Discord", await checkDiscord(token));
    } catch (error) {
      report(false, "Discord", errorMessage(error));
    }
  }

  const url = resolveDatabaseUrl(databaseUrl(config), baseDir);
  try {
    const store = await core.openStore(url);
    await store.close();
    report(true, "資料庫", redactUrl(url));
  } catch (error) {
    report(false, "資料庫", `${redactUrl(url)}:${errorMessage(error)}`);
  }

  if (failures > 0) throw new DoctorError(`${failures} 項檢查失敗`);
  println("\n全部正常!");
}

export async function checkDiscord(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl("https://discord.com/api/v10/applications/@me", {
    headers: { authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new DoctorError(`Discord API 回應 ${response.status}(token 錯了嗎?)`);
  const app = (await response.json()) as {
    name?: string;
    bot?: { username?: string };
    flags?: number;
  };
  const name = app.bot?.username ?? app.name ?? "?";
  const flags = app.flags ?? 0;
  if ((flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) === 0) {
    throw new DoctorError(
      `bot \`${name}\` 沒有開啟 Message Content Intent(Developer Portal → Bot → Privileged Gateway Intents)`,
    );
  }
  return `bot \`${name}\``;
}

export function redactUrl(url: string): string {
  const scheme = url.indexOf("://");
  const at = url.lastIndexOf("@");
  return scheme !== -1 && at > scheme ? `${url.slice(0, scheme)}://***${url.slice(at)}` : url;
}
