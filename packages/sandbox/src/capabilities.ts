// What phase A's `ActuatorRegistry` needs to register the sandbox's capabilities. Nothing here
// checks permissions: every call must come through the gate (principal, risk `high`, her own
// review call, rate limits, audit). This file only describes the capabilities and adapts their
// arguments to the services.

import type { JsonValue } from "@miyoria/types";
import { z } from "zod";
import { type ProposedTools, ToolProposalSchema } from "./proposed.js";
import { FileInSchema, LanguageSchema, type RunResult, type Sandbox } from "./types.js";

/** Capability ids (design doc section 7). */
export const CODE_RUN = "code.run";
export const TOOL_PROPOSE = "tool.propose";

/**
 * Model-facing arguments of `code.run`. There is no network field: model-initiated runs never
 * get a network, whatever the sandbox supports later.
 */
export const CodeRunArgsSchema = z.object({
  language: LanguageSchema,
  code: z.string().min(1).describe("The whole program; stdout / stderr come back"),
  files: z.array(FileInSchema).max(32).optional().describe("Files written into /work first"),
  stdin: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  mount_tools: z.boolean().optional().describe("Mount her saved scripts read-only at /tools"),
});
export type CodeRunArgs = z.output<typeof CodeRunArgsSchema>;

export interface SandboxCapability {
  id: typeof CODE_RUN | typeof TOOL_PROPOSE;
  /** Gate risk class (section 8.1): high = her own review call, escalation only on doubt. */
  risk: "high";
  description: string;
  args: z.ZodType;
}

export const SANDBOX_CAPABILITIES: readonly SandboxCapability[] = [
  {
    id: CODE_RUN,
    risk: "high",
    description: "Run a short Python or Node program in an offline, disposable container",
    args: CodeRunArgsSchema,
  },
  {
    id: TOOL_PROPOSE,
    risk: "high",
    description: "Propose a tool she wrote; it is usable only after it is approved",
    args: ToolProposalSchema,
  },
];

/** A compact, model-friendly view of a run result (outputs are untrusted data). */
export function summarizeRun(result: RunResult): JsonValue {
  return {
    exit_code: result.exit_code,
    killed_reason: result.killed_reason,
    duration_ms: result.duration_ms,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated,
    files_out: result.files_out.map((f) => ({ path: f.path, size: f.size, encoding: f.encoding })),
  };
}

/**
 * Handlers for the registry, called by the gate after it allowed a request. `args` is
 * untrusted and parsed here; errors are `SandboxError` / `ZodError`.
 */
export function sandboxHandlers(services: {
  sandbox: Sandbox;
  tools: ProposedTools | null;
}): Record<
  SandboxCapability["id"],
  (args: unknown, ctx: { requester: string | null; signal: AbortSignal }) => Promise<JsonValue>
> {
  return {
    [CODE_RUN]: async (args, ctx) => {
      const a = CodeRunArgsSchema.parse(args);
      const result = await services.sandbox.run({ ...a, network: "none" }, { signal: ctx.signal });
      return summarizeRun(result);
    },
    [TOOL_PROPOSE]: async (args, ctx) => {
      if (!services.tools) throw new Error("proposed tools need the settings store");
      const tool = await services.tools.propose(ToolProposalSchema.parse(args), ctx.requester);
      return { name: tool.name, version: tool.version, status: tool.status };
    },
  };
}
