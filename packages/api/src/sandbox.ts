// Tools she wrote (`tool.propose`), for the owners: `GET /api/sandbox/tools` (list + sandbox
// state), `GET /api/sandbox/tools/:name` (with the code), and `POST .../approve` / `.../reject`
// for one exact version. Approving needs the owners' approval node (the same one as the
// Discord approval card); the bearer token is the owner.

import { NODE_APPROVE } from "@miyoria/actions";
import { errorMessage } from "@miyoria/kernel";
import {
  type ProposedTool,
  type ProposedTools,
  ProposedToolsKey,
  SandboxError,
  SandboxKey,
} from "@miyoria/sandbox";
import { AuthorizerKey } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { readJson } from "./extract.js";
import { json, param, type Route } from "./route.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";

/** A proposed tool without its code (list view). */
export type ProposedToolSummary = Omit<ProposedTool, "code"> & { code_bytes: number };

function summary(tool: ProposedTool): ProposedToolSummary {
  const { code, ...rest } = tool;
  return { ...rest, code_bytes: Buffer.byteLength(code, "utf8") };
}

function tools(state: ApiState): ProposedTools {
  return state.service(ProposedToolsKey, "sandbox module (with the settings store)");
}

/** Owners only: the bearer token, or a session whose account has `owner.autonomy.approve`. */
function requireOwner(state: ApiState, c: ApiContext): void {
  const principal = c.get("principal");
  if (principal.kind === "token") return;
  const authorizer = state.optional(AuthorizerKey);
  if (!authorizer?.allows(principal.record.account, NODE_APPROVE)) {
    throw new ApiError(403, `reviewing her tools needs \`${NODE_APPROVE}\``);
  }
}

function fromSandboxError(error: unknown): never {
  if (error instanceof SandboxError) {
    if (error.kind === "not_found") throw ApiError.notFound(error.message);
    if (error.kind === "wrong_state") throw ApiError.conflict(error.message);
    throw ApiError.badRequest(error.message);
  }
  throw error;
}

const ReviewBody = z.object({
  /** The version the owner looked at (a re-proposal in the meantime makes this a conflict). */
  version: z.number().int().positive(),
  note: z.string().max(1000).nullish(),
});

async function list(state: ApiState): Promise<Response> {
  const sandbox = state.optional(SandboxKey);
  const all = await tools(state).list();
  return json({
    sandbox: sandbox ? await sandbox.health() : null,
    tools: all.map(summary),
  });
}

async function show(state: ApiState, c: ApiContext): Promise<Response> {
  const tool = await tools(state)
    .get(param(c, "name"))
    .catch((error: unknown) => fromSandboxError(error));
  if (!tool) throw ApiError.notFound(`no proposed tool \`${param(c, "name")}\``);
  return json(tool);
}

async function review(state: ApiState, c: ApiContext, approve: boolean): Promise<Response> {
  requireOwner(state, c);
  const body = await readJson(c, ReviewBody);
  const name = param(c, "name");
  const store = tools(state);
  const reviewer = actorOf(c);
  const input = { reviewer, version: body.version, note: body.note ?? null };
  let tool: ProposedTool;
  try {
    tool = approve ? await store.approve(name, input) : await store.reject(name, input);
  } catch (error) {
    await state.audit(
      c,
      approve ? "sandbox.tool.approve" : "sandbox.tool.reject",
      name,
      { version: body.version, error: errorMessage(error) },
      false,
    );
    return fromSandboxError(error);
  }
  await state.audit(
    c,
    approve ? "sandbox.tool.approve" : "sandbox.tool.reject",
    name,
    { version: tool.version, code_sha256: tool.code_sha256 },
    true,
  );
  return json(summary(tool));
}

export function sandboxRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/sandbox/tools", handler: () => list(state) },
    { method: "GET", path: "/api/sandbox/tools/:name", handler: (c) => show(state, c) },
    {
      method: "POST",
      path: "/api/sandbox/tools/:name/approve",
      handler: (c) => review(state, c, true),
    },
    {
      method: "POST",
      path: "/api/sandbox/tools/:name/reject",
      handler: (c) => review(state, c, false),
    },
  ];
}
