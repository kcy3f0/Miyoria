// Capability ids and model-facing argument schemas of the sandbox. The capabilities themselves
// (registered in the app's `ActuatorRegistry`, behind the gate) are in `gate.ts`.

import type { JsonValue } from "@miyoria/types";
import { z } from "zod";
import {
  FileInSchema,
  LanguageSchema,
  type RunResult,
  SESSION_NAME,
  SessionChoiceSchema,
} from "./types.js";

/** Capability ids (design doc section 7). */
export const CODE_RUN = "code.run";
export const TOOL_PROPOSE = "tool.propose";
export const CODE_SESSION = "code.session";

/**
 * Model-facing arguments of `code.run`. There is no network field: model-initiated runs never
 * get a network, whatever the sandbox supports later (unknown fields are dropped and the
 * executor forces `network: "none"`).
 */
export const CodeRunArgsSchema = z.object({
  language: LanguageSchema,
  code: z.string().min(1).describe("The whole program; stdout / stderr come back"),
  files: z.array(FileInSchema).max(32).optional().describe("Files written into /work first"),
  stdin: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  mount_tools: z.boolean().optional().describe("Mount her saved scripts read-only at /tools"),
  session: SessionChoiceSchema.optional().describe("`fresh` (default) or a session name"),
});
export type CodeRunArgs = z.output<typeof CodeRunArgsSchema>;

/** Arguments of `code.session`: list her sessions, or close one. */
export const CodeSessionArgsSchema = z
  .object({
    action: z.enum(["list", "close"]),
    name: z.string().regex(SESSION_NAME).optional(),
  })
  .refine((a) => a.action !== "close" || a.name !== undefined, {
    message: "`close` needs the session's `name`",
    path: ["name"],
  });
export type CodeSessionArgs = z.output<typeof CodeSessionArgsSchema>;

/** A compact JSON view of a run result (audit / `ActionResult.data`; outputs are untrusted). */
export function summarizeRun(result: RunResult): JsonValue {
  return {
    run_id: result.run_id,
    exit_code: result.exit_code,
    killed_reason: result.killed_reason,
    duration_ms: result.duration_ms,
    stdout_bytes: Buffer.byteLength(result.stdout, "utf8"),
    stderr_bytes: Buffer.byteLength(result.stderr, "utf8"),
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated,
    files_out: result.files_out.map((f) => ({ path: f.path, size: f.size, encoding: f.encoding })),
    session: result.session === null ? null : { ...result.session },
  };
}
