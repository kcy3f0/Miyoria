// `miyoria install [role | service ...]`: prepares this computer for the services it runs, and
// nothing else. Node packages and builds only where core, voice node or stage run; a Python venv
// with its packages per worker (the inference computer needs no node packages at all). Model
// files that are not downloaded for you are listed at the end, with what is still missing.
// Safe to repeat: finished steps are skipped.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildTargets, checkTarget } from "../stack/builds.js";
import { pythonPath, repoRoot, type Stack, stackConfig, type Worker } from "../stack/config.js";
import { autoDownloads, importsFor, manualItems } from "../stack/role-checks.js";
import { describeMachine, expandTargets, machineConfig } from "../stack/roles.js";
import { defaultRunner, type Runner } from "../stack/system.js";
import { dim, fail, note, ok, println, section, warn } from "../ui.js";
import { loadConfig } from "./node.js";
import { buildTarget, installNeeded, type UpdateDeps } from "./update.js";

export class InstallError extends Error {
  override readonly name = "InstallError";
}

export interface InstallOptions {
  targets: string[];
  dryRun?: boolean;
}

export interface InstallDeps {
  run: Runner;
  platform: NodeJS.Platform;
  /** Asked before the large downloads (CUDA torch is a few GB). */
  confirm: (message: string) => Promise<boolean>;
}

export function defaultInstallDeps(confirm: InstallDeps["confirm"]): InstallDeps {
  return { run: defaultRunner, platform: process.platform, confirm };
}

const TORCH_INDEX = "https://download.pytorch.org/whl/cu128";
const LONG = 60 * 60_000;

/** One pip step: the arguments after `python -m pip install`. */
export interface PipStep {
  label: string;
  args: string[];
  /** Modules whose import says this step is already done. */
  done: string[];
}

/** What to pip install into a worker's venv (CUDA torch first, then the requirements). */
export function pipSteps(w: Worker): PipStep[] {
  const torch = (pins: string[]): PipStep => ({
    label: "CUDA 版 PyTorch(約數 GB)",
    args: [...pins, "--index-url", TORCH_INDEX],
    done: ["torch"],
  });
  const reqs = (file: string): PipStep => ({
    label: file,
    args: ["-r", `${w.name}/${file}`],
    done: importsFor(w).filter((m) => m !== "torch"),
  });
  switch (w.name) {
    case "asr":
      return (w.env.ASR_BACKEND ?? "").toLowerCase() === "qwen3"
        ? [torch(["torch"]), reqs("requirements-qwen3.txt")]
        : [reqs("requirements-sensevoice.txt")];
    case "tts":
      return (w.env.TTS_BACKEND ?? "").toLowerCase() === "qwen-tts"
        ? [torch(["torch"]), reqs("requirements.txt")]
        : [torch(["torch"]), reqs("requirements-faster.txt")];
    case "sing":
      return [torch(["torch==2.11.0", "torchaudio==2.11.0"]), reqs("requirements.txt")];
    case "turn":
      return [reqs("requirements.txt")];
    default:
      return [];
  }
}

/** Build targets a computer needs for its services. */
export function wantedTargets(stack: Stack): Set<string> {
  const ids = new Set<string>();
  if (stack.core) ids.add("sdk").add("panel").add("ext:*");
  if (stack.stage) ids.add("overlay");
  return ids;
}

function wanted(id: string, ids: Set<string>): boolean {
  return ids.has(id) || (id.startsWith("ext:") && ids.has("ext:*"));
}

async function findPython(deps: InstallDeps): Promise<string | null> {
  const candidates: Array<[string, string[]]> = [
    ["python", []],
    ["py", ["-3"]],
  ];
  for (const [cmd, pre] of candidates) {
    const r = await deps.run(cmd, [...pre, "--version"], { timeoutMs: 15_000 });
    const m = /Python (\d+)\.(\d+)/.exec(`${r.stdout}${r.stderr}`);
    if (!r.missing && r.code === 0 && m && (Number(m[1]) > 3 || Number(m[2]) >= 11)) {
      return pre.length ? `${cmd} ${pre.join(" ")}` : cmd;
    }
  }
  return null;
}

async function importsOk(deps: InstallDeps, python: string, modules: string[]): Promise<boolean> {
  if (modules.length === 0) return false;
  const r = await deps.run(python, ["-c", modules.map((m) => `import ${m}`).join(";")], {
    timeoutMs: 120_000,
  });
  return r.code === 0;
}

export async function run(
  configPath: string,
  options: InstallOptions,
  deps: InstallDeps,
): Promise<void> {
  const root = repoRoot(configPath);
  if (!root) {
    throw new InstallError(
      "`install` 要在 Miyoria 的原始碼資料夾裡用(找不到 workers/ 和 pnpm-workspace.yaml)",
    );
  }
  const config = await loadConfig(configPath);
  const configDir = dirname(resolve(configPath));
  const machine = machineConfig(config);
  let services: string[];
  try {
    services =
      options.targets.length > 0 ? expandTargets(options.targets) : (machine?.services ?? []);
  } catch (error) {
    throw new InstallError((error as Error).message);
  }
  if (services.length === 0) {
    throw new InstallError(
      "這台電腦還沒選要跑什麼:執行 `miyoria init` 選角色,或 `miyoria install core`(角色:broadcast、core、inference、all)",
    );
  }
  const stack = stackConfig(config, services);
  const dry = options.dryRun === true;
  if (machine && options.targets.length === 0) note(`這台電腦的角色:${describeMachine(machine)}`);
  section(`${dry ? "安裝計畫(dry-run,不會改任何東西)" : "安裝"}:${services.join("、")}`);

  let failures = 0;
  const updateDeps: UpdateDeps = {
    run: deps.run,
    confirm: deps.confirm,
    env: process.env,
    platform: deps.platform,
    now: () => new Date(),
  };

  // ---- node packages and builds -------------------------------------------------------
  const needsNode = stack.core || stack.voiceNode || stack.stage;
  if (!needsNode) {
    ok("node 套件  這台電腦不跑 core / voice node / stage,不需要");
  } else if (!installNeeded(root)) {
    ok("node 套件  與 pnpm-lock.yaml 一致");
  } else if (dry) {
    note("會執行:pnpm install");
  } else {
    note("安裝 node 套件(pnpm install)…");
    const r = await deps.run("pnpm", ["install"], { cwd: root, timeoutMs: LONG, inherit: true });
    if (r.code !== 0) throw new InstallError("pnpm install 失敗,後面的步驟沒有執行");
    ok("node 套件  已安裝");
  }

  const ids = wantedTargets(stack);
  for (const t of buildTargets(root, configDir, config)) {
    if (!wanted(t.id, ids)) continue;
    const f = checkTarget(t);
    if (f.state === "fresh") {
      ok(`${t.label}  ${f.detail}`);
    } else if (t.configured === false) {
      ok(`${t.label}  設定檔沒有用到,略過`);
    } else if (dry) {
      note(`會建置 ${t.label}:${t.command} ${t.args.join(" ")}`);
    } else if (!(await buildTarget(t, updateDeps))) failures++;
  }

  // ---- python workers -----------------------------------------------------------------
  if (stack.workers.length > 0) {
    const bootstrap = await findPython(deps);
    for (const w of stack.workers) {
      const venv = join(root, w.venv);
      const python = pythonPath(venv, deps.platform);
      const label = `worker ${w.name}`;
      if (!existsSync(python)) {
        if (!bootstrap) {
          fail(`${label}  找不到 Python 3.11 以上`);
          println(dim("    修正:winget install Python.Python.3.11,重開終端機再執行"));
          failures++;
          continue;
        }
        if (dry) note(`會建立 venv:${bootstrap} -m venv ${w.venv}`);
        else {
          const [cmd, ...pre] = bootstrap.split(" ") as [string, ...string[]];
          note(`建立 ${w.venv}…`);
          const r = await deps.run(cmd, [...pre, "-m", "venv", venv], {
            cwd: join(root, "workers"),
            timeoutMs: 5 * 60_000,
          });
          if (r.code !== 0) {
            fail(`${label}  建立 venv 失敗`);
            failures++;
            continue;
          }
        }
      }
      for (const step of pipSteps(w)) {
        if (existsSync(python) && (await importsOk(deps, python, step.done))) {
          ok(`${label}  ${step.label}  已裝好`);
          continue;
        }
        if (dry) {
          note(`會執行:${w.venv} 的 pip install ${step.args.join(" ")}`);
          continue;
        }
        if (
          step.done.includes("torch") &&
          !(await deps.confirm(`${label}:要下載 ${step.label} 嗎?`))
        ) {
          warn(`${label}  略過 ${step.label};之後重新執行 \`miyoria install\``);
          failures++;
          continue;
        }
        note(`${label}  pip install ${step.args.join(" ")}`);
        const r = await deps.run(python, ["-m", "pip", "install", ...step.args], {
          cwd: join(root, "workers"),
          timeoutMs: LONG,
          inherit: true,
        });
        if (r.code !== 0) {
          fail(`${label}  pip install ${step.label} 失敗`);
          failures++;
        } else ok(`${label}  ${step.label}  已安裝`);
      }
    }
  }

  // ---- what is still by hand ----------------------------------------------------------
  const missing = manualItems(stack).filter(
    (m) => m.path !== null && !existsSync(join(root, m.path)),
  );
  const auto = autoDownloads(stack);
  if (missing.length > 0 || auto.length > 0 || stack.stage || stack.core) {
    section("還需要手動處理的");
    for (const m of missing) {
      (m.required ? fail : warn)(`${m.service}:${m.what}  ${m.how}`);
    }
    for (const line of auto) note(line);
    if (stack.core) {
      note(
        "core:LLM API key 和 Discord token 由 `miyoria init` 問;檔案沙箱要 Docker Desktop(沒啟用沙箱就不用)",
      );
    }
    if (stack.stage)
      note(
        "stage:VTube Studio(API 打開)和 OBS(WebSocket)要自己裝、自己開;`miyoria stage obs-setup` 建場景",
      );
  }

  if (failures > 0) throw new InstallError(`${failures} 項沒有完成,見上面的訊息`);
  if (dry) return;
  println("\n完成。`miyoria doctor` 檢查缺什麼,`miyoria start` 在各自的分頁啟動。");
}
