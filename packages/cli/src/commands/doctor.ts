// `miyoria doctor`: checks everything needed to run, one line per check.

import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { databaseUrl, loadProfile, resolveDatabaseUrl } from "@miyoria/core/light";
import { Config, configureLogging, errorMessage } from "@miyoria/kernel";
import { cliVersion } from "../assets.js";
import { type DeepDeps, deepChecks, type Finding } from "../stack/checks.js";
import { repoRoot, stackConfig } from "../stack/config.js";
import { defaultRunner, probePort } from "../stack/system.js";
import { dim, green, println, red, yellow } from "../ui.js";

/** Discord application flags for the message content intent. */
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

export class DoctorError extends Error {
  override readonly name = "DoctorError";
}

export interface DoctorOptions {
  /** Also check the install: ports, builds, JDK, worker config, VRAM, temp files. */
  deep?: boolean;
  /** Only the install checks; no LLM, Discord or database round trips. Implies `deep`. */
  stackOnly?: boolean;
  /** Replaces the system seams in tests. */
  deps?: DeepDeps;
}

function realDeps(): DeepDeps {
  return {
    platform: process.platform,
    run: defaultRunner,
    probe: probePort,
    fetchImpl: fetch,
    env: process.env,
    tmpdir: tmpdir(),
    version: cliVersion(),
  };
}

function printFinding(f: Finding): void {
  const mark = f.level === "ok" ? green("✓") : f.level === "warn" ? yellow("!") : red("✗");
  println(`${mark} ${f.what}  ${f.detail}`);
  for (const line of f.fix ?? []) println(dim(`    修正:${line}`));
}

/** Prints the deep findings; returns how many failed. */
async function deepReport(config: Config, configPath: string, deps: DeepDeps): Promise<number> {
  println(`\n部署檢查(只讀,不會改 Windows、防火牆或防毒設定)`);
  const findings = await deepChecks({
    config,
    configDir: dirname(configPath),
    root: repoRoot(configPath),
    stack: stackConfig(config),
    deps,
  });
  for (const f of findings) printFinding(f);
  return findings.filter((f) => f.level === "fail").length;
}

export async function run(configPath: string, options: DoctorOptions = {}): Promise<void> {
  // The checks print their own lines; module logs would only interleave with them.
  if (!process.env.MIYORIA_LOG_LEVEL) configureLogging({ level: "warn" });
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

  if (options.stackOnly) {
    failures += await deepReport(config, configPath, options.deps ?? realDeps());
    if (failures > 0) throw new DoctorError(`${failures} 項檢查失敗`);
    println(`\n部署檢查通過`);
    return;
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
