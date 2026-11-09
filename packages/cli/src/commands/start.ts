// `miyoria start [role | service ...]`: opens each service of this computer's role in its own
// Windows Terminal tab, so it can be watched and stopped (close the tab, or Ctrl+C in it).
//
// - No targets: whatever `[machine]` in miyoria.toml says this computer runs.
// - Targets: roles (`broadcast`, `core`, `inference`), `all`, or service names; a role not in
//   `[machine]` still starts (the owner asked for it).
// - A service that already answers on its port, or whose tab is still open, is never started twice.
// - Workers that others hand the GPU over for (asr, tts) come up before the one that hands over (sing).
// - Nothing is restarted and nothing is stopped; there is no restart loop.

import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { cliVersion } from "../assets.js";
import { type DeepDeps, type DeepInput, type Finding, workerChecks } from "../stack/checks.js";
import { repoRoot, stackConfig } from "../stack/config.js";
import {
  defaultLaunchDeps,
  type LaunchDeps,
  openTab,
  scriptPath,
  tabRunning,
} from "../stack/launch.js";
import { roleChecks } from "../stack/role-checks.js";
import { describeMachine, expandTargets, machineConfig, roleOf } from "../stack/roles.js";
import {
  defaultRunner,
  type PortProbe,
  probePort,
  type Runner,
  tcpConnect,
} from "../stack/system.js";
import { bold, dim, fail, note, ok, println, section, warn } from "../ui.js";
import { loadConfig } from "./node.js";
import { buildPlan, type ServiceSpec } from "./up.js";

export class StartError extends Error {
  override readonly name = "StartError";
}

export interface StartOptions {
  /** Roles, `all` or service names; empty = what `[machine]` says. */
  targets: string[];
  dryRun?: boolean;
  /** Open the tabs one after the other without waiting for health checks. */
  noWait?: boolean;
  noCheck?: boolean;
  timeoutSecs?: number;
}

export interface StartDeps {
  fetchImpl: typeof fetch;
  probe: PortProbe;
  run: Runner;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  launch: LaunchDeps;
  deep: DeepDeps;
  pollMs: number;
}

export type Decision =
  | { action: "start" }
  | { action: "skip"; why: string }
  | { action: "refuse"; why: string };

const WINNAT_HINT =
  "Windows 保留了這個埠(動態埠範圍從 1024 開始時常見):用系統管理員 PowerShell 執行 net stop winnat 再 net start winnat;`miyoria doctor --deep` 有長期做法";

async function healthy(deps: StartDeps, url: string): Promise<boolean> {
  try {
    const res = await deps.fetchImpl(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Whether to start a service: not when it already runs, and not when its port is taken by something else. */
export async function decide(
  spec: ServiceSpec,
  script: string,
  deps: StartDeps,
): Promise<Decision> {
  if (spec.health !== null && (await healthy(deps, spec.health))) {
    return { action: "skip", why: `已在執行(${spec.url ?? spec.health})` };
  }
  if (await tabRunning(deps.run, script)) {
    return { action: "skip", why: "它的分頁還開著(可能還在載入模型);到那個分頁看" };
  }
  if (spec.port !== null) {
    const state = await deps.probe(spec.port, spec.host);
    if (state === "denied")
      return { action: "refuse", why: `埠 ${spec.port} 被 Windows 保留:${WINNAT_HINT}` };
    if (state === "in-use") {
      if (spec.health === null) {
        return { action: "skip", why: `埠 ${spec.port} 已有程式在聽,視為已經在執行` };
      }
      return {
        action: "refuse",
        why: `埠 ${spec.port} 被別的程式佔用,而且那不是健康的 ${spec.name};用 netstat -ano | findstr :${spec.port} 找出來,確定是舊的行程後自己關掉(這裡不會替你結束任何程式)`,
      };
    }
  }
  return { action: "start" };
}

async function waitHealthy(
  spec: ServiceSpec,
  deps: StartDeps,
  timeoutMs: number,
): Promise<boolean> {
  const t0 = deps.now();
  while (deps.now() - t0 < timeoutMs) {
    if (spec.health !== null && (await healthy(deps, spec.health))) return true;
    await deps.sleep(deps.pollMs);
  }
  return false;
}

export async function run(
  configPath: string,
  options: StartOptions,
  deps: StartDeps = defaultStartDeps(),
): Promise<void> {
  const config = await loadConfig(configPath);
  const root = repoRoot(configPath);
  const machine = machineConfig(config);
  let services: string[];
  try {
    services =
      options.targets.length > 0 ? expandTargets(options.targets) : (machine?.services ?? []);
  } catch (error) {
    throw new StartError((error as Error).message);
  }
  if (services.length === 0) {
    throw new StartError(
      machine
        ? "[machine] 沒有選任何服務:`miyoria init` 重新選,或 `miyoria start core`"
        : "這台電腦還沒選要跑什麼:執行 `miyoria init` 選角色,或直接 `miyoria start core`(角色:broadcast、core、inference、all)",
    );
  }
  const stack = stackConfig(config, services);
  const absolute = resolve(configPath);
  const plan = buildPlan({ config, configPath: absolute, stack, root });
  if (options.timeoutSecs !== undefined) {
    for (const s of plan) s.timeoutMs = options.timeoutSecs * 1000;
  }
  const scriptFor = (s: ServiceSpec) => scriptPath(dirname(s.logFile), s.name);

  if (options.targets.length === 0 && machine) {
    note(`這台電腦的角色:${describeMachine(machine)}`);
  }

  // Blocking problems first: nothing is opened when a venv or a package is missing.
  if (!options.noCheck) {
    const input: DeepInput = {
      config,
      configDir: dirname(absolute),
      root,
      stack,
      deps: deps.deep,
    };
    const findings: Finding[] = [...workerChecks(input), ...(await roleChecks(input))];
    const blocking = findings.filter((f) => f.level === "fail");
    for (const f of findings.filter((x) => x.level === "warn")) {
      warn(`${f.what}  ${f.detail}`);
      for (const line of f.fix ?? []) println(dim(`    修正:${line}`));
    }
    for (const f of blocking) {
      fail(`${f.what}  ${f.detail}`);
      for (const line of f.fix ?? []) println(dim(`    修正:${line}`));
    }
    if (blocking.length > 0 && !options.dryRun) {
      throw new StartError(`${blocking.length} 項問題,先修正再啟動(--no-check 可略過檢查)`);
    }
  }

  if (options.dryRun) {
    section("啟動計畫(dry-run,不會啟動任何東西)");
    for (const [i, spec] of plan.entries()) {
      const d = await decide(spec, scriptFor(spec), deps);
      const verdict =
        d.action === "start"
          ? "會開新分頁"
          : d.action === "skip"
            ? `會略過:${d.why}`
            : `會拒絕:${d.why}`;
      println(`${i + 1}. ${bold(spec.name)}  ${dim(roleOf(spec.name) ?? "")}  ${verdict}`);
      println(dim(`     ${[spec.command, ...spec.args].join(" ")}`));
      println(dim(`     工作目錄 ${spec.cwd}`));
      if (spec.envKeys.length > 0) println(dim(`     設定的環境變數 ${spec.envKeys.join(", ")}`));
      if (spec.health) println(dim(`     健康檢查 ${spec.health}`));
    }
    return;
  }

  section(`啟動 ${plan.map((s) => s.name).join(" → ")}`);
  const opened: string[] = [];
  for (const spec of plan) {
    const script = scriptFor(spec);
    const d = await decide(spec, script, deps);
    if (d.action === "skip") {
      ok(`${spec.name}  ${d.why}`);
      continue;
    }
    if (d.action === "refuse") {
      throw new StartError(
        `${spec.name}:${d.why}${opened.length ? `\n    已開的分頁:${opened.join("、")}(沒有動它們)` : ""}`,
      );
    }
    try {
      await openTab(spec, script, deps.launch);
    } catch (error) {
      throw new StartError(`${spec.name}:${(error as Error).message}`);
    }
    opened.push(spec.name);
    note(`${spec.name}  已開分頁${spec.port ? `(port ${spec.port})` : ""}`);
    if (options.noWait || spec.health === null) continue;
    const t0 = deps.now();
    if (await waitHealthy(spec, deps, spec.timeoutMs)) {
      ok(
        `${spec.name}  ${spec.url ?? "就緒"}  ${dim(`${((deps.now() - t0) / 1000).toFixed(1)} s`)}`,
      );
    } else {
      throw new StartError(
        `${spec.name} 在 ${Math.round(spec.timeoutMs / 1000)} 秒內沒有通過健康檢查(${spec.health});它的分頁還開著,看那個分頁的訊息。後面的服務沒有啟動`,
      );
    }
  }
  println(
    opened.length === 0
      ? "沒有開新的分頁(都已經在執行)。"
      : `\n開了 ${opened.length} 個分頁。要停止:關掉那個分頁,或在裡面按 Ctrl+C;這個指令不會替你停任何服務。`,
  );
}

export function defaultStartDeps(): StartDeps {
  return {
    fetchImpl: fetch,
    probe: probePort,
    run: defaultRunner,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    launch: defaultLaunchDeps(defaultRunner),
    deep: {
      platform: process.platform,
      run: defaultRunner,
      probe: probePort,
      fetchImpl: fetch,
      env: process.env,
      tmpdir: tmpdir(),
      version: cliVersion(),
      connect: tcpConnect,
    },
    pollMs: 1000,
  };
}
