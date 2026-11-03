// Starts Minecraft through Prism Launcher when she decides to play (the `launch` action) and
// closes it again (`quit`). Prism's CLI: `prismlauncher --launch <instance> [--world <save>]`.
// The launcher only starts the process; the game counts as up once the miyoria-bridge mod
// answers `hello` (the adapter calls `connected()`).

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** `[extensions."miyoria.minecraft"]` keys of the launcher (all optional). */
export interface LauncherConfig {
  /** `prismlauncher` executable; default: found next to the instance or in the usual install places. */
  prism_path?: string;
  /** Prism instance id (its folder under `instances/`); default: from `minecraft_dir`. */
  prism_instance?: string;
  /** Save folder to join on launch; `"latest"` (default) = the one played last, `""` = main menu. */
  launch_world?: string;
  /** How long a launch may take until the mod connects. */
  launch_timeout_secs?: number;
  /** When `quit` closes the game: only if she launched it (default), always, never. */
  quit_on_stop?: "launched" | "always" | "never";
  /** Set to false to never start the game from here. */
  auto_launch?: boolean;
}

export const DEFAULT_LAUNCH_TIMEOUT_SECS = 180;

/** Where the game is in its start, as reported in `observe` (`state.launch`). */
export type LaunchStatus =
  | { state: "idle" }
  | { state: "starting"; since: number; world: string | null }
  | { state: "failed"; error: string };

/** A started process, as far as the launcher cares (a `ChildProcess` fits). */
export interface LaunchedProcess {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  unref?(): void;
}

export type SpawnFn = (command: string, args: string[]) => LaunchedProcess;

const defaultSpawn: SpawnFn = (command, args) =>
  // Detached and unreferenced: Minecraft outlives Core restarts and never holds its console.
  nodeSpawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });

export interface LauncherOptions {
  config: LauncherConfig;
  /** The instance's game directory (`minecraft_dir`). */
  minecraftDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
  exists?: (path: string) => boolean;
  /** Save folders with their last-played time (ms); default reads `<minecraftDir>/saves`. */
  saves?: (dir: string) => Array<{ name: string; playedAt: number }>;
  now?: () => number;
}

/** A launch that cannot even start; the message goes back to her. */
export class LaunchError extends Error {}

/**
 * Prism's data folder for a game dir like `.../PrismLauncher/instances/<id>/.minecraft`, and the
 * instance id; `undefined` when the path does not look like a Prism instance.
 */
export function prismInstanceOf(minecraftDir: string): { root: string; instance: string } | undefined {
  const leaf = basename(minecraftDir);
  const instanceDir = leaf === ".minecraft" || leaf === "minecraft" ? dirname(minecraftDir) : minecraftDir;
  const instances = dirname(instanceDir);
  if (basename(instances) !== "instances") return undefined;
  return { root: dirname(instances), instance: basename(instanceDir) };
}

/** Places Prism Launcher is usually installed, most specific first. */
export function prismCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  root: string | undefined,
): string[] {
  const out: string[] = [];
  if (platform === "win32") {
    const exe = "prismlauncher.exe";
    if (root) out.push(join(root, exe)); // portable install: the exe sits in the data folder
    if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, "Programs", "PrismLauncher", exe));
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]) {
      if (base) out.push(join(base, "PrismLauncher", exe));
    }
    if (env.USERPROFILE) out.push(join(env.USERPROFILE, "scoop", "apps", "prismlauncher", "current", exe));
    return out;
  }
  if (platform === "darwin") {
    out.push("/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher");
    if (env.HOME) out.push(join(env.HOME, "Applications", "Prism Launcher.app", "Contents", "MacOS", "prismlauncher"));
    return out;
  }
  if (root) out.push(join(root, "prismlauncher"), join(root, "PrismLauncher"));
  if (env.HOME) out.push(join(env.HOME, ".local", "bin", "prismlauncher"));
  out.push("/usr/bin/prismlauncher", "/usr/local/bin/prismlauncher");
  return out;
}

function readSaves(dir: string): Array<{ name: string; playedAt: number }> {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        try {
          return [{ name: d.name, playedAt: statSync(join(dir, d.name, "level.dat")).mtimeMs }];
        } catch {
          return []; // not a world
        }
      });
  } catch {
    return [];
  }
}

/** Starts the configured Prism instance and remembers whether this run started it. */
export class Launcher {
  readonly #config: LauncherConfig;
  readonly #minecraftDir: string | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #spawn: SpawnFn;
  readonly #exists: (path: string) => boolean;
  readonly #saves: (dir: string) => Array<{ name: string; playedAt: number }>;
  readonly #now: () => number;
  #status: LaunchStatus = { state: "idle" };
  #launched = false;
  /** Bumped per launch so a late `exit` of an old process is ignored. */
  #attempt = 0;

  constructor(opts: LauncherOptions) {
    this.#config = opts.config;
    this.#minecraftDir = opts.minecraftDir;
    this.#env = opts.env ?? process.env;
    this.#platform = opts.platform ?? process.platform;
    this.#spawn = opts.spawn ?? defaultSpawn;
    this.#exists = opts.exists ?? existsSync;
    this.#saves = opts.saves ?? readSaves;
    this.#now = opts.now ?? Date.now;
  }

  get timeoutMs(): number {
    return Math.max(10, this.#config.launch_timeout_secs ?? DEFAULT_LAUNCH_TIMEOUT_SECS) * 1000;
  }

  /** The instance to launch, or `undefined` when neither configured nor derivable. */
  instance(): string | undefined {
    const configured = this.#config.prism_instance?.trim();
    if (configured) return configured;
    return this.#minecraftDir ? prismInstanceOf(this.#minecraftDir)?.instance : undefined;
  }

  /** The Prism executable: configured (`prism_path`, `MIYORIA_MC_PRISM`) or the first one found. */
  executable(): string | undefined {
    const configured = this.#config.prism_path?.trim() || this.#env.MIYORIA_MC_PRISM?.trim();
    if (configured) return configured;
    const root = this.#minecraftDir ? prismInstanceOf(this.#minecraftDir)?.root : undefined;
    return prismCandidates(this.#env, this.#platform, root).find((p) => this.#exists(p));
  }

  /** Why it cannot launch at all (zh-TW), or `null` when it can. */
  problem(): string | null {
    if (this.#config.auto_launch === false) return "設定關掉了自動開遊戲(auto_launch = false)";
    if (!this.instance()) {
      return '不知道要開哪個 Prism 實例:在 [extensions."miyoria.minecraft"] 設 minecraft_dir(實例的 .minecraft 目錄)或 prism_instance';
    }
    const exe = this.executable();
    if (!exe) return "找不到 Prism Launcher(prismlauncher):在設定裡用 prism_path 指定它的路徑";
    if (!this.#exists(exe)) return `Prism Launcher 不在 ${exe}(prism_path 設錯了?)`;
    return null;
  }

  /** The save to join: configured, else the one played last; `null` = stay in the main menu. */
  world(): string | null {
    const configured = this.#config.launch_world;
    if (configured !== undefined && configured.trim() !== "latest") return configured.trim() || null;
    if (!this.#minecraftDir) return null;
    const saves = this.#saves(join(this.#minecraftDir, "saves"));
    saves.sort((a, b) => b.playedAt - a.playedAt);
    return saves[0]?.name ?? null;
  }

  status(): LaunchStatus {
    if (this.#status.state === "starting" && this.#now() - this.#status.since > this.timeoutMs) {
      this.#status = {
        state: "failed",
        error: `等了 ${Math.round(this.timeoutMs / 1000)} 秒,遊戲還是沒有連上(Prism 可能在等登入、更新或其他對話框,或模組沒載入)`,
      };
    }
    return this.#status;
  }

  /** She (this adapter run) started the game that is running now. */
  get launchedByUs(): boolean {
    return this.#launched;
  }

  /**
   * Starts the instance (`starting` until `connected()`); a launch already under way is left
   * alone. Throws `LaunchError` when it cannot start.
   */
  launch(): LaunchStatus {
    const current = this.status();
    if (current.state === "starting") return current;
    const problem = this.problem();
    if (problem) throw new LaunchError(problem);
    const exe = this.executable() as string;
    const instance = this.instance() as string;
    const world = this.world();
    const args = ["--launch", instance, ...(world ? ["--world", world] : [])];
    const attempt = ++this.#attempt;
    let child: LaunchedProcess;
    try {
      child = this.#spawn(exe, args);
    } catch (error) {
      throw new LaunchError(`Prism Launcher 啟動失敗:${error instanceof Error ? error.message : String(error)}`);
    }
    this.#status = { state: "starting", since: this.#now(), world };
    this.#launched = true;
    const fail = (error: string) => {
      if (attempt !== this.#attempt || this.#status.state !== "starting") return;
      this.#status = { state: "failed", error };
      this.#launched = false;
    };
    child.once("error", (error) => fail(`Prism Launcher 啟動失敗:${error.message}`));
    // A second launcher hands the instance to a running one and exits with 0; only an error
    // code before the mod connects means the launch failed.
    child.once("exit", (code) => {
      if (code !== null && code !== 0) fail(`Prism Launcher 結束了(代碼 ${code}),遊戲沒有開起來`);
    });
    child.unref?.();
    return this.#status;
  }

  /** The mod answered: the game is up. */
  connected(): void {
    if (this.#status.state === "starting") this.#status = { state: "idle" };
  }

  /** Whether `quit` should close the game now (by `quit_on_stop`). */
  shouldQuit(): boolean {
    const mode = this.#config.quit_on_stop ?? "launched";
    return mode === "always" || (mode === "launched" && this.#launched);
  }

  /** The game was closed (by `quit`). */
  quitting(): void {
    this.#launched = false;
    this.#status = { state: "idle" };
  }
}
