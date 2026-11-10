// Her workspace and her skills (docs/design/v4-plan.md §8.3 items 2 and 3), read-only:
//
// * `GET /api/workspace`: the files in her persistent workspace with their sizes, what is used
//   against the quotas.
// * `GET /api/skills`: the skill index (name and one-line description).
// * `GET /api/skills/{name}`: one skill's body and the files beside it (scripts say whether they
//   are approved to run).
//
// Skills are files of the workspace (`skills/<name>/SKILL.md`: a `description:` line, a blank line,
// then the how-to), and the workspace is the sandbox module's, so both are read from there:
// `@miyoria/skills` is not a dependency of the API. Without the sandbox module, or with its
// workspace off, they are a 503 that says which. Everything shown is text a program or she may
// have written: it is data for a person to read, never instructions.

import { checkName, SandboxKey, type WorkspaceApi } from "@miyoria/sandbox";
import { ApiError } from "./errors.js";
import { json, param, type Route } from "./route.js";
import type { ApiState } from "./state.js";

export const SKILLS_DIR = "skills";
export const SKILL_FILE = "SKILL.md";
const DESCRIPTION_PREFIX = "description:";
const NO_DESCRIPTION = "(沒有說明)";
/** Most characters of one skill's body shown. */
export const MAX_BODY_CHARS = 20_000;
/** Most characters of the description. */
const MAX_DESCRIPTION_CHARS = 300;
/** Most files listed in one answer. */
const MAX_FILES = 2_000;

export interface WorkspaceFileView {
  path: string;
  size: number;
}

export interface WorkspaceView {
  files: WorkspaceFileView[];
  /** The listing was cut (more files than it reads). */
  truncated: boolean;
  usage: { files: number; bytes: number; overflow: boolean };
  limits: { max_bytes: number; max_files: number; max_file_bytes: number };
}

export interface SkillSummaryView {
  name: string;
  description: string;
}

export interface SkillFileView extends WorkspaceFileView {
  /** `approved`: reviewed and unchanged, so she can run it; `unapproved`: not (a program wrote it). */
  script: "approved" | "unapproved" | null;
}

export interface SkillView extends SkillSummaryView {
  body: string;
  /** The body was cut at `MAX_BODY_CHARS`. */
  truncated: boolean;
  files: SkillFileView[];
}

function workspace(state: ApiState): WorkspaceApi {
  const sandbox = state.service(SandboxKey, "sandbox module (her workspace)");
  const ws = sandbox.workspace;
  if (ws === null) throw ApiError.unavailable("her workspace is turned off");
  return ws;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Splits `SKILL.md` into its description line and body, the way the skill store writes it. */
export function parseSkill(raw: string): { description: string; body: string } {
  const text = raw.replace(/\r\n?/g, "\n");
  if (!text.startsWith(DESCRIPTION_PREFIX))
    return { description: NO_DESCRIPTION, body: text.trim() };
  const end = text.indexOf("\n");
  const line = end === -1 ? text : text.slice(0, end);
  const description = [...oneLine(line.slice(DESCRIPTION_PREFIX.length))]
    .slice(0, MAX_DESCRIPTION_CHARS)
    .join("");
  return {
    description: description === "" ? NO_DESCRIPTION : description,
    body: (end === -1 ? "" : text.slice(end + 1)).trim(),
  };
}

async function files(state: ApiState): Promise<Response> {
  const ws = workspace(state);
  const [listing, usage] = await Promise.all([ws.list(), ws.usage()]);
  const sorted = [...listing.entries].sort((a, b) => a.path.localeCompare(b.path));
  const view: WorkspaceView = {
    files: sorted.slice(0, MAX_FILES).map((e) => ({ path: e.path, size: e.size })),
    truncated: listing.truncated || sorted.length > MAX_FILES,
    usage: { files: usage.files, bytes: usage.bytes, overflow: usage.overflow },
    limits: {
      max_bytes: ws.limits.maxBytes,
      max_files: ws.limits.maxFiles,
      max_file_bytes: ws.limits.maxFileBytes,
    },
  };
  return json(view);
}

/** Names of the skills that have a `SKILL.md`, sorted. */
async function skillNames(ws: WorkspaceApi): Promise<string[]> {
  const { entries } = await ws.list(SKILLS_DIR);
  const names = new Set<string>();
  for (const { path } of entries) {
    const [, name, file, ...rest] = path.split("/");
    if (name === undefined || file !== SKILL_FILE || rest.length > 0) continue;
    try {
      names.add(checkName(name));
    } catch {
      // A directory name the tools cannot address anyway.
    }
  }
  return [...names].sort();
}

async function readSkill(ws: WorkspaceApi, name: string) {
  const read = await ws.read(`${SKILLS_DIR}/${name}/${SKILL_FILE}`, {
    maxChars: MAX_BODY_CHARS + MAX_DESCRIPTION_CHARS + 64,
  });
  const parsed = parseSkill(read.text);
  const cut = [...parsed.body].length > MAX_BODY_CHARS || read.next_offset !== null;
  return {
    description: parsed.description,
    body: [...parsed.body].slice(0, MAX_BODY_CHARS).join(""),
    truncated: cut,
  };
}

async function skillList(state: ApiState): Promise<Response> {
  const ws = workspace(state);
  const names = await skillNames(ws);
  const skills: SkillSummaryView[] = [];
  for (const name of names) {
    try {
      skills.push({ name, description: (await readSkill(ws, name)).description });
    } catch {
      skills.push({ name, description: NO_DESCRIPTION });
    }
  }
  return json({ skills });
}

async function skillShow(state: ApiState, name: string): Promise<Response> {
  const ws = workspace(state);
  try {
    checkName(name);
  } catch {
    throw ApiError.notFound(`no skill \`${name.slice(0, 60)}\``);
  }
  let skill: Awaited<ReturnType<typeof readSkill>>;
  try {
    skill = await readSkill(ws, name);
  } catch (error) {
    if ((error as { kind?: string }).kind === "not_found") {
      throw ApiError.notFound(`no skill \`${name}\``);
    }
    throw error;
  }
  const dir = `${SKILLS_DIR}/${name}`;
  const { entries } = await ws.list(dir);
  const beside: SkillFileView[] = [];
  for (const e of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    if (e.path === `${dir}/${SKILL_FILE}`) continue;
    const script = /\.(py|mjs)$/.test(e.path)
      ? (await ws.approvedScript(e.path)) !== null
        ? "approved"
        : "unapproved"
      : null;
    beside.push({ path: e.path, size: e.size, script });
  }
  const view: SkillView = { name, ...skill, files: beside };
  return json(view);
}

export function workspaceRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/workspace", handler: () => files(state) },
    { method: "GET", path: "/api/skills", handler: () => skillList(state) },
    {
      method: "GET",
      path: "/api/skills/:name",
      handler: (c) => skillShow(state, param(c, "name")),
    },
  ];
}
