import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { errorMessage, getLogger, sleep } from "@miyoria/kernel";
import { type Clock, type JsonValue, newId, systemClock } from "@miyoria/types";
import {
  buildRunArgs,
  CONTAINER_ENV,
  entryCommand,
  inspectImageArgs,
  killArgs,
  LABEL,
  LABEL_INSTANCE,
  LABEL_RUN,
  listArgs,
  NAME_PREFIX,
  pullArgs,
  removeArgs,
  versionArgs,
} from "./args.js";
import type { SandboxConfig } from "./config.js";
import { checkProfileId } from "./paths.js";
import type { DockerRunner, ExecResult } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import {
  type KilledReason,
  type Language,
  type RunRequest,
  RunRequestSchema,
  type RunResult,
  type Sandbox,
  SandboxError,
  type SandboxHealth,
} from "./types.js";
import {
  collectOutputs,
  createRunDirs,
  pruneRuns,
  removeDir,
  ToolsWorkspace,
  writeInputs,
  writeProgram,
} from "./workspace.js";

const log = getLogger("sandbox");

/** How long `docker run` gets to exit after `docker kill` before the CLI is killed too. */
export const KILL_GRACE_MS = 5_000;
/** Timeout of small Docker CLI calls (version, kill, rm, inspect, ps). */
export const CONTROL_TIMEOUT_MS = 15_000;
/** Output kept from control calls. */
const CONTROL_OUTPUT_BYTES = 16 * 1024;

/** Receives `sandbox.*` events (the module publishes them on the bus). */
export type SandboxPublisher = (topic: string, payload: JsonValue) => void;

export interface DockerSandboxOptions {
  /** Absolute sandbox root (`config.root` resolved). */
  root: string;
  profile: string;
  runner: DockerRunner;
  clock?: Clock;
  publisher?: SandboxPublisher;
  /** Host uid / gid for `user = "auto"`; default `process.getuid?.()`. */
  hostUser?: { uid: number; gid: number } | null;
  /** Default `KILL_GRACE_MS` (tests shorten it). */
  killGraceMs?: number;
}

/** Outcome of making sure an image is present locally. */
export interface ImageCheck {
  image: string;
  pulled: boolean;
  duration_ms: number;
}

/** Resolves `user = "auto"` (see `SandboxConfig.user`). */
export function resolveUser(configured: string, host: { uid: number; gid: number } | null): string {
  if (configured !== "auto") return configured;
  if (host && host.uid > 0 && host.gid > 0) return `${host.uid}:${host.gid}`;
  return "65534:65534";
}

function defaultHostUser(): { uid: number; gid: number } | null {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return null;
  return { uid: process.getuid(), gid: process.getgid() };
}

/** Short stable id of a sandbox root, used as the instance label. */
export function instanceId(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
}

function decodeOutput(data: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

/** A failure of the Docker CLI itself (`docker run` exits 125 and prints `docker: ...`). */
function dockerFailure(result: ExecResult): string | null {
  if (result.error !== null) return result.error;
  if (result.exit_code !== 125) return null;
  const text = decodeOutput(result.stderr).trim();
  return /^docker: /m.test(text) || /Error response from daemon/.test(text) ? text : null;
}

/**
 * `Sandbox` on the Docker CLI. Each run gets a fresh container (`buildRunArgs` has the flags)
 * and a fresh workspace directory; runs are limited by a semaphore; a wall-clock timer kills the
 * container by name. See the package README for the threat model.
 */
export class DockerSandbox implements Sandbox {
  readonly tools: ToolsWorkspace;
  readonly instance: string;
  readonly #config: SandboxConfig;
  readonly #root: string;
  readonly #runner: DockerRunner;
  readonly #clock: Clock;
  readonly #publish: SandboxPublisher;
  readonly #user: string;
  readonly #killGraceMs: number;
  readonly #slots: Semaphore;
  readonly #closing = new AbortController();
  readonly #inFlight = new Set<Promise<unknown>>();
  /** Run ids whose workspace is in use (never pruned). */
  readonly #active = new Set<string>();
  readonly #images = new Map<string, Promise<ImageCheck>>();
  #health: SandboxHealth = {
    available: false,
    server_version: null,
    error: null,
    checked_at: null,
  };
  #healthCheck: Promise<SandboxHealth> | null = null;

  constructor(config: SandboxConfig, options: DockerSandboxOptions) {
    this.#config = config;
    this.#root = resolve(options.root);
    this.#runner = options.runner;
    this.#clock = options.clock ?? systemClock;
    this.#publish = options.publisher ?? (() => {});
    this.#killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.#user = resolveUser(
      config.user,
      options.hostUser === undefined ? defaultHostUser() : options.hostUser,
    );
    this.#slots = new Semaphore(config.max_concurrent, config.max_queued);
    this.instance = instanceId(this.#root);
    const profile = checkProfileId(options.profile);
    this.tools = new ToolsWorkspace(join(this.#root, "profiles", profile, "tools"), {
      maxScripts: config.max_scripts,
      maxScriptBytes: config.caps.max_code_bytes,
    });
  }

  get root(): string {
    return this.#root;
  }

  /** The container user (`uid:gid`). */
  get user(): string {
    return this.#user;
  }

  /** Last health result without checking. */
  get lastHealth(): SandboxHealth {
    return this.#health;
  }

  async health(options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<SandboxHealth> {
    const age =
      this.#health.checked_at === null
        ? Number.POSITIVE_INFINITY
        : this.#clock.now() - this.#health.checked_at;
    if (!options.refresh && age <= this.#config.health_ttl_ms) return this.#health;
    this.#healthCheck ??= this.#checkHealth(options.signal).finally(() => {
      this.#healthCheck = null;
    });
    return this.#healthCheck;
  }

  async #checkHealth(signal?: AbortSignal): Promise<SandboxHealth> {
    const result = await this.#control(versionArgs(), signal);
    const version = decodeOutput(result.stdout).trim();
    const ok = result.error === null && result.exit_code === 0 && version !== "";
    const error = ok
      ? null
      : (result.error ??
        (decodeOutput(result.stderr).trim().split("\n")[0] || `docker exited ${result.exit_code}`));
    const first = this.#health.checked_at === null;
    const before = this.#health.available;
    this.#health = {
      available: ok,
      server_version: ok ? version : null,
      error,
      checked_at: this.#clock.now(),
    };
    if (first || before !== ok) {
      if (ok) log.info({ version }, "docker is available");
      else log.warn({ err: error }, "docker is not available; the sandbox is degraded");
    }
    return this.#health;
  }

  /** A Docker CLI call that is not a program run (bounded time and output). */
  #control(
    args: string[],
    signal?: AbortSignal,
    timeoutMs = CONTROL_TIMEOUT_MS,
  ): Promise<ExecResult> {
    const timeout = AbortSignal.timeout(timeoutMs);
    return this.#runner.exec(args, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      maxOutputBytes: CONTROL_OUTPUT_BYTES,
    });
  }

  /**
   * Removes containers of this instance left over from an earlier process (crash, kill -9).
   * Returns how many were removed.
   */
  async reap(signal?: AbortSignal): Promise<number> {
    const listed = await this.#control(listArgs(this.instance), signal);
    if (listed.exit_code !== 0) return 0;
    const ids = decodeOutput(listed.stdout)
      .split(/\s+/)
      .filter((id) => /^[0-9a-f]{12,64}$/.test(id));
    if (ids.length === 0) return 0;
    const removed = await this.#control(removeArgs(ids), signal);
    if (removed.exit_code === 0)
      log.info({ count: ids.length }, "removed leftover sandbox containers");
    else
      log.warn(
        { err: decodeOutput(removed.stderr).trim() },
        "could not remove leftover containers",
      );
    return removed.exit_code === 0 ? ids.length : 0;
  }

  /** Deletes old run workspaces beyond `keep_runs`. */
  prune(): Promise<number> {
    return pruneRuns(this.#root, this.#config.keep_runs, this.#active);
  }

  /** Image for a language. */
  image(language: Language): string {
    return this.#config.images[language];
  }

  /**
   * Makes sure the language's image is present, pulling it once if not (concurrent callers share
   * the pull). Throws `SandboxError` (`image_unavailable`).
   */
  ensureImage(language: Language, signal?: AbortSignal): Promise<ImageCheck> {
    const image = this.image(language);
    let check = this.#images.get(image);
    if (!check) {
      check = this.#pullIfMissing(image, signal);
      this.#images.set(image, check);
      // A failed check is retried by the next run.
      check.catch(() => this.#images.delete(image));
    }
    return check;
  }

  async #pullIfMissing(image: string, signal?: AbortSignal): Promise<ImageCheck> {
    const started = this.#clock.now();
    const inspect = await this.#control(inspectImageArgs(image), signal);
    if (inspect.exit_code === 0) return { image, pulled: false, duration_ms: 0 };
    log.info({ image }, "pulling sandbox image");
    const pull = await this.#control(pullArgs(image), signal, this.#config.pull_timeout_ms);
    if (pull.exit_code !== 0) {
      const why = pull.error ?? decodeOutput(pull.stderr).trim().split("\n")[0] ?? "";
      throw new SandboxError("image_unavailable", `could not pull \`${image}\`: ${why}`);
    }
    const check = { image, pulled: true, duration_ms: this.#clock.now() - started };
    log.info({ image, duration_ms: check.duration_ms }, "pulled sandbox image");
    return check;
  }

  async run(request: RunRequest, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    if (this.#closing.signal.aborted) throw new SandboxError("closed", "the sandbox is shut down");
    const parsed = this.#validate(request);
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.#closing.signal])
      : this.#closing.signal;
    const task = this.#run(parsed, signal);
    this.#inFlight.add(task);
    try {
      return await task;
    } finally {
      this.#inFlight.delete(task);
    }
  }

  #validate(request: RunRequest): Required<Omit<RunRequest, "network">> {
    const parsed = RunRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new SandboxError("invalid_request", `invalid run request: ${parsed.error.message}`);
    }
    const r = parsed.data;
    const caps = this.#config.caps;
    if (r.network !== undefined && r.network !== "none") {
      throw new SandboxError(
        "network_unsupported",
        "network allowlists are not supported yet; runs have no network",
      );
    }
    if (Buffer.byteLength(r.code, "utf8") > caps.max_code_bytes) {
      throw new SandboxError("invalid_request", `code is over ${caps.max_code_bytes} bytes`);
    }
    const stdin = r.stdin ?? "";
    if (Buffer.byteLength(stdin, "utf8") > caps.max_stdin_bytes) {
      throw new SandboxError("invalid_request", `stdin is over ${caps.max_stdin_bytes} bytes`);
    }
    const timeout = r.timeout_ms ?? this.#config.default_timeout_ms;
    if (timeout > this.#config.max_timeout_ms) {
      throw new SandboxError(
        "invalid_request",
        `timeout_ms is over the maximum of ${this.#config.max_timeout_ms}`,
      );
    }
    return {
      language: r.language,
      code: r.code,
      files: r.files ?? [],
      stdin,
      timeout_ms: timeout,
      mount_tools: r.mount_tools ?? false,
    };
  }

  async #run(r: Required<Omit<RunRequest, "network">>, signal: AbortSignal): Promise<RunResult> {
    const health = await this.health({ signal });
    if (!health.available) {
      throw new SandboxError(
        "unavailable",
        `docker is not available: ${health.error ?? "unknown"}`,
      );
    }
    let release: (() => void) | null;
    try {
      release = await this.#slots.acquire(signal);
    } catch (error) {
      throw new SandboxError("closed", "the run was cancelled while waiting", { cause: error });
    }
    if (release === null) throw new SandboxError("busy", "too many sandbox runs are waiting");
    const runId = newId();
    this.#active.add(runId);
    const dirs = await createRunDirs(this.#root, runId).catch((error: unknown) => {
      this.#active.delete(runId);
      release?.();
      throw error;
    });
    try {
      await this.ensureImage(r.language, signal);
      await writeProgram(dirs.codeDir, r.language, r.code);
      const inputs = await writeInputs(dirs.workDir, r.files, this.#config.caps);
      const toolsDir = r.mount_tools ? await this.tools.ensure() : null;
      const result = await this.#runContainer(runId, r, dirs, toolsDir, signal);
      const outputs =
        result.exit_code === null && result.killed_reason === "aborted"
          ? { files: [], truncated: false }
          : await collectOutputs(dirs.workDir, inputs, this.#config.caps);
      const done: RunResult = {
        ...result,
        files_out: outputs.files,
        files_out_truncated: outputs.truncated,
      };
      this.#publish("sandbox.run.finished", {
        run_id: runId,
        language: r.language,
        exit_code: done.exit_code,
        duration_ms: done.duration_ms,
        killed_reason: done.killed_reason,
        files_out: done.files_out.length,
      });
      return done;
    } finally {
      await removeDir(dirs.codeDir);
      if (this.#config.keep_runs === 0) await removeDir(dirs.dir);
      this.#active.delete(runId);
      release();
      try {
        await this.prune();
      } catch (error) {
        // Pruning is housekeeping; a failure must not fail the run.
        log.warn({ err: errorMessage(error) }, "pruning sandbox runs failed");
      }
    }
  }

  async #runContainer(
    runId: string,
    r: Required<Omit<RunRequest, "network">>,
    dirs: { codeDir: string; workDir: string },
    toolsDir: string | null,
    signal: AbortSignal,
  ): Promise<Omit<RunResult, "files_out" | "files_out_truncated">> {
    if (signal.aborted) {
      return {
        run_id: runId,
        language: r.language,
        exit_code: null,
        stdout: "",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: 0,
        killed_reason: "aborted",
      };
    }
    const name = `${NAME_PREFIX}${runId.toLowerCase()}`;
    const args = buildRunArgs({
      name,
      image: this.image(r.language),
      labels: { [LABEL]: "1", [LABEL_INSTANCE]: this.instance, [LABEL_RUN]: runId },
      workDir: dirs.workDir,
      codeDir: dirs.codeDir,
      toolsDir,
      user: this.#user,
      limits: this.#config.limits,
      command: entryCommand(r.language),
      env: CONTAINER_ENV,
    });

    // Object fields, not `let`s: the kill callbacks set them, and TypeScript does not see that.
    const state: { killed: KilledReason | null; killing: Promise<void> | null } = {
      killed: null,
      killing: null,
    };
    const cli = new AbortController();
    const kill = (reason: KilledReason) => {
      if (state.killed !== null) return;
      state.killed = reason;
      state.killing = (async () => {
        await this.#control(killArgs(name)).catch(() => undefined);
        // `docker run` normally exits right after the kill; if it hangs, drop the CLI and make
        // sure the container is gone.
        try {
          await sleep(this.#killGraceMs, cli.signal);
        } catch {
          return;
        }
        cli.abort();
        await this.#control(removeArgs([name])).catch(() => undefined);
      })();
    };
    const timer = setTimeout(() => kill("timeout"), r.timeout_ms);
    const onAbort = () => kill("aborted");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    const started = this.#clock.now();
    let result: ExecResult;
    try {
      result = await this.#runner.exec(args, {
        stdin: r.stdin,
        signal: cli.signal,
        maxOutputBytes: this.#config.caps.max_output_bytes,
        outputLimit: {
          bytes: this.#config.caps.kill_output_bytes,
          onExceeded: () => kill("output_limit"),
        },
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    const duration = this.#clock.now() - started;
    // Stop the grace timer of a kill that already worked.
    if (!cli.signal.aborted) cli.abort();
    await state.killing;

    if (state.killed === null) {
      const failure = dockerFailure(result);
      if (failure !== null) {
        throw new SandboxError("docker_failed", `docker run failed: ${failure.slice(0, 500)}`);
      }
    }
    const exitCode = result.exit_code;
    const reason: KilledReason | null = state.killed ?? (exitCode === 137 ? "memory" : null);
    const max = this.#config.caps.max_output_bytes;
    return {
      run_id: runId,
      language: r.language,
      exit_code: exitCode,
      stdout: decodeOutput(result.stdout),
      stderr: decodeOutput(result.stderr),
      stdout_truncated: result.stdout_bytes > max,
      stderr_truncated: result.stderr_bytes > max,
      duration_ms: duration,
      killed_reason: reason,
    };
  }

  /** Kills every running program (`aborted`) and refuses new runs. */
  async close(): Promise<void> {
    this.#closing.abort(new SandboxError("closed", "the sandbox is shut down"));
    await Promise.allSettled([...this.#inFlight]);
  }
}
