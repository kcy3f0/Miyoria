// `[stack]` in miyoria.toml: what `miyoria up` starts and what `doctor --deep` checks. Every key is
// optional; without the section `up` starts the core only, like `miyoria core`.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "@miyoria/kernel";
import { z } from "zod";

/**
 * Ports the bundled workers listen on when `port` is not given. `turn` (end-of-turn: Smart Turn
 * and Silero on the CPU) is optional: it needs model files that are not downloaded for you.
 */
const WORKER_DEFAULT_PORT: Record<string, number> = {
  asr: 8001,
  tts: 8002,
  sing: 8005,
  turn: 8006,
};

const WorkerSchema = z
  .object({
    /** Virtualenv folder, relative to the repo root (default `workers/.venv-<name>`). */
    venv: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    host: z.string().default("127.0.0.1"),
    /** Folder under `workers/` holding the server (default: the worker's name). */
    dir: z.string().optional(),
    entry: z.string().default("server.py"),
    env: z.record(z.string(), z.string()).default({}),
    /** Workers that must drop their GPU models while this one runs (`SING_OFFLOAD_URLS`). */
    offload: z.array(z.string()).default([]),
    /** Rough VRAM the worker holds when loaded (MB); overrides the built-in estimate. */
    vram_mb: z.number().int().min(0).optional(),
    start_timeout_secs: z.number().int().min(5).optional(),
  })
  .strict();

const StackSchema = z
  .object({
    core: z.boolean().default(true),
    voice_node: z.boolean().default(false),
    stage: z.boolean().default(false),
    start_timeout_secs: z.number().int().min(5).default(180),
    workers: z.record(z.string(), WorkerSchema).default({}),
  })
  .strict();

export interface Worker {
  name: string;
  venv: string;
  port: number;
  host: string;
  dir: string;
  entry: string;
  /** Keys and values from the config; values are never printed. */
  env: Record<string, string>;
  offload: string[];
  vramMb: number | null;
  startTimeoutSecs: number | null;
}

export interface Stack {
  core: boolean;
  voiceNode: boolean;
  stage: boolean;
  startTimeoutSecs: number;
  workers: Worker[];
}

export function stackConfig(config: Config): Stack {
  const raw = config.get("stack", StackSchema);
  const workers = Object.entries(raw.workers).map(([name, w]): Worker => {
    const port = w.port ?? WORKER_DEFAULT_PORT[name];
    if (port === undefined) throw new Error(`[stack.workers.${name}] 要設定 port`);
    return {
      name,
      venv: w.venv ?? `workers/.venv-${name}`,
      port,
      host: w.host,
      dir: w.dir ?? name,
      entry: w.entry,
      env: w.env,
      offload: w.offload,
      vramMb: w.vram_mb ?? null,
      startTimeoutSecs: w.start_timeout_secs ?? null,
    };
  });
  return {
    core: raw.core,
    voiceNode: raw.voice_node,
    stage: raw.stage,
    startTimeoutSecs: raw.start_timeout_secs,
    workers,
  };
}

/** Workers in start order: the ones another worker offloads for come first. */
export function startOrder(workers: readonly Worker[]): Worker[] {
  const offloaded = new Set(workers.flatMap((w) => w.offload));
  return [...workers].sort((a, b) => Number(offloaded.has(b.name)) - Number(offloaded.has(a.name)));
}

export function workerUrl(w: Worker): string {
  return `http://${w.host === "0.0.0.0" ? "127.0.0.1" : w.host}:${w.port}`;
}

/** `SING_OFFLOAD_URLS` for a worker: its `offload` targets that exist in the stack. */
export function offloadUrls(w: Worker, workers: readonly Worker[]): string {
  return w.offload
    .map((n) => workers.find((x) => x.name === n))
    .filter((x): x is Worker => x !== undefined)
    .map(workerUrl)
    .join(",");
}

/** The repo checkout holding `workers/`, `apps/` and `extensions/`; `null` for an npm install. */
export function repoRoot(configPath: string): string | null {
  let dir = dirname(resolve(configPath));
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "workers"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Host and port of a `host:port` bind string. */
export function parseBind(bind: string): { host: string; port: number } | null {
  const colon = bind.lastIndexOf(":");
  if (colon <= 0) return null;
  const port = Number(bind.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: bind.slice(0, colon), port };
}

export function pythonPath(venv: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
}
