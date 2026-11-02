import { serviceKey } from "@miyoria/types";
import { z } from "zod";

/** Languages the sandbox runs. */
export const LANGUAGES = ["python", "node"] as const;
export type Language = (typeof LANGUAGES)[number];
export const LanguageSchema = z.enum(LANGUAGES);

/**
 * Network policy of a run. Only `"none"` (`--network none`: no interfaces but loopback) is
 * implemented; an allowlist is accepted by the type so callers can be written against it, but
 * `run` refuses it with `network_unsupported` until the egress proxy exists (see README).
 */
export type NetworkPolicy = "none" | { allow: string[] };
export const NetworkPolicySchema = z.union([
  z.literal("none"),
  z.object({ allow: z.array(z.string().min(1).max(253)).max(32) }),
]);

/** A file written into `/work` before the run. */
export interface FileIn {
  /** Relative POSIX path inside `/work` (`data/input.csv`). See `normalizeRelativePath`. */
  path: string;
  content: string;
  /** How `content` is encoded. Default `utf8`. */
  encoding?: "utf8" | "base64";
}

export const FileInSchema = z.object({
  path: z.string().min(1).max(255),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

/** What `Sandbox.run` takes (an in-process option bag; validated with `RunRequestSchema`). */
export interface RunRequest {
  language: Language;
  /** The program: `/code/main.py` or `/code/main.mjs`, mounted read-only. */
  code: string;
  files?: FileIn[];
  stdin?: string;
  /** Wall-clock limit; default and maximum come from the config. */
  timeout_ms?: number;
  /** Default `"none"`. */
  network?: NetworkPolicy;
  /** Mount the profile's tools workspace read-only at `/tools`. Default `false`. */
  mount_tools?: boolean;
}

export const RunRequestSchema = z.object({
  language: LanguageSchema,
  code: z.string(),
  files: z.array(FileInSchema).optional(),
  stdin: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  network: NetworkPolicySchema.optional(),
  mount_tools: z.boolean().optional(),
});

/** Why the sandbox (not the program) ended a run. */
export type KilledReason =
  /** The wall-clock timeout passed; the container was killed. */
  | "timeout"
  /** The caller's signal aborted, or the sandbox shut down. */
  | "aborted"
  /** stdout + stderr passed `caps.kill_output_bytes`. */
  | "output_limit"
  /** Exit 137 without the sandbox killing it: almost always the memory limit (OOM killer). */
  | "memory";

/** A file the program left in `/work` (new, or changed from the input). */
export interface FileOut {
  path: string;
  size: number;
  /** `utf8` when the bytes are valid UTF-8, else `base64`. */
  encoding: "utf8" | "base64";
  content: string;
}

/** Result of one run (JSON shape: snake_case, every key present). */
export interface RunResult {
  run_id: string;
  language: Language;
  /** Exit code of the program; `null` when it never ran to an exit (e.g. aborted early). */
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  files_out: FileOut[];
  /** Some output files were left out (count or size caps, or unreadable entries). */
  files_out_truncated: boolean;
  /** Wall-clock time of the container run (image checks and pulls excluded). */
  duration_ms: number;
  killed_reason: KilledReason | null;
}

/** Whether Docker can be used. */
export interface SandboxHealth {
  available: boolean;
  /** Docker server (daemon) version when available. */
  server_version: string | null;
  /** Why it is not available. */
  error: string | null;
  /** Epoch ms of the check; `null` before the first one. */
  checked_at: number | null;
}

/** A script in the profile's tools workspace. */
export interface ScriptInfo {
  name: string;
  language: Language;
  /** File name inside the workspace (and inside `/tools` when mounted). */
  file: string;
  size: number;
}

export type SandboxErrorKind =
  /** Docker is not installed or not running. */
  | "unavailable"
  /** The sandbox was shut down. */
  | "closed"
  /** Too many runs waiting. */
  | "busy"
  /** The request is malformed or over a cap. */
  | "invalid_request"
  /** A file or script name is not a safe relative path. */
  | "invalid_path"
  /** Network allowlists are not implemented yet. */
  | "network_unsupported"
  /** The image is missing and could not be pulled. */
  | "image_unavailable"
  /** The Docker CLI failed before the program ran. */
  | "docker_failed"
  | "not_found"
  /** A proposed tool is not in the state the operation needs. */
  | "wrong_state"
  /** Too many scripts / proposed tools. */
  | "limit";

/** Why a sandbox operation was refused. */
export class SandboxError extends Error {
  override readonly name = "SandboxError";

  constructor(
    readonly kind: SandboxErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Runs untrusted code in a disposable container. Provided by module `sandbox`. */
export interface Sandbox {
  /** Runs one program. Throws `SandboxError` when it could not be run at all. */
  run(request: RunRequest, options?: { signal?: AbortSignal }): Promise<RunResult>;
  /** Last known Docker availability (re-checked when older than `health_ttl_ms`). */
  health(options?: { signal?: AbortSignal; refresh?: boolean }): Promise<SandboxHealth>;
  /** The profile's persistent tools workspace. */
  readonly tools: ToolsWorkspaceApi;
}

/** Scripts she keeps between runs (mounted read-only at `/tools` on request). */
export interface ToolsWorkspaceApi {
  list(): Promise<ScriptInfo[]>;
  read(name: string): Promise<{ info: ScriptInfo; code: string } | null>;
  save(name: string, language: Language, code: string): Promise<ScriptInfo>;
  remove(name: string): Promise<boolean>;
}

export const SandboxKey = serviceKey<Sandbox>("Sandbox");
