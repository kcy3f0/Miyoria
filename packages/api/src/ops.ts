// Live operation: extensions, MCP servers, the request queue, the stage (VTube Studio / OBS) and
// the voice monitor.

import { type CatalogEntry, ExtensionCatalogKey, extensionModuleId } from "@miyoria/ext-host";
import { errorMessage, getLogger, type ModuleStatus, SupervisorKey } from "@miyoria/kernel";
import { type ServerStatus as McpServerStatus, McpStatusKey } from "@miyoria/mcp";
import { type RequestQueue, RequestQueueKey } from "@miyoria/queue";
import { type StageLink, StageLinkKey } from "@miyoria/stage";
import { type ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import { contextKeyString, newId, VoiceSinkKey } from "@miyoria/types";
import { z } from "zod";
import { runModuleAction } from "./core.js";
import { ApiError } from "./errors.js";
import { readJson, usizeJson } from "./extract.js";
import { json, param, type Route } from "./route.js";
import { isQueueNotFound, MCP_MODULE_ID } from "./services.js";
import { type ApiContext, type ApiState, toJson } from "./state.js";
import type {
  ExtensionInfo,
  McpServerInfo,
  McpState,
  QueueState,
  SayResponse,
  StageLinkState,
  StageState,
} from "./types.js";

const log = getLogger("api.ops");

const MAX_SAY_CHARS = 500;

// ---- extensions -------------------------------------------------------------------------

function permissions(entry: CatalogEntry): string[] {
  const granted = entry.spec.granted;
  const out: string[] = [];
  if (granted.tools) out.push("tools");
  if (granted.commands) out.push("commands");
  for (const e of granted.events) out.push(`events:${e}`);
  for (const n of granted.network) out.push(`network:${n}`);
  for (const i of granted.input) out.push(`input:${i}`);
  return out;
}

function extensionInfo(entry: CatalogEntry, status: ModuleStatus | undefined): ExtensionInfo {
  const manifest = entry.spec.manifest;
  return {
    id: manifest.id,
    module: extensionModuleId(entry.spec),
    name: manifest.name ?? manifest.id,
    version: manifest.version,
    description: manifest.description ?? "",
    source: entry.spec.dir,
    enabled: status?.enabled ?? false,
    state: status?.state ?? "disabled",
    reason: status ? status.reason : "not registered with the supervisor",
    permissions: permissions(entry),
  };
}

function extensions(state: ApiState): Response {
  const catalog = state.service(ExtensionCatalogKey, "extension host");
  const sup = state.service(SupervisorKey, "supervisor");
  const modules = sup.list();
  return json(
    catalog.entries.map((e) => {
      const id = extensionModuleId(e.spec);
      return extensionInfo(
        e,
        modules.find((m) => m.id === id),
      );
    }),
  );
}

async function extensionAction(state: ApiState, c: ApiContext): Promise<Response> {
  const catalog = state.service(ExtensionCatalogKey, "extension host");
  const id = param(c, "id");
  const entry = catalog.entries.find(
    (e) => e.spec.manifest.id === id || extensionModuleId(e.spec) === id,
  );
  if (!entry) throw ApiError.notFound(`unknown extension \`${id}\``);
  const status = await runModuleAction(
    state,
    c,
    extensionModuleId(entry.spec),
    param(c, "action"),
    "extension",
  );
  return json(extensionInfo(entry, status));
}

// ---- MCP --------------------------------------------------------------------------------

function mcpInfo(s: McpServerStatus, tools: ToolRegistry | undefined): McpServerInfo {
  const states: Record<McpServerStatus["state"], McpState> = {
    disabled: "disabled",
    connecting: "connecting",
    connected: "ready",
    failed: "failed",
  };
  return {
    name: s.name,
    transport: s.transport,
    target: null,
    enabled: s.state !== "disabled",
    state: states[s.state],
    error: s.last_error,
    tools: s.tools.map((name) => ({
      name,
      description: tools?.get(name)?.spec.description ?? "",
    })),
    remote_tool_count: s.remote_tool_count,
    permission: s.permission,
    reconnects: s.reconnects,
  };
}

function mcpServers(state: ApiState): Response {
  const status = state.service(McpStatusKey, "MCP module");
  const tools = state.optional(ToolRegistryKey);
  return json(status.servers().map((s) => mcpInfo(s, tools)));
}

/**
 * Only `restart` is supported (it restarts the whole `mcp` module); turning single servers on
 * or off is configuration (`[mcp.servers.<name>] enabled`).
 */
async function mcpAction(state: ApiState, c: ApiContext): Promise<Response> {
  const name = param(c, "name");
  const action = param(c, "action");
  const status = state.service(McpStatusKey, "MCP module");
  if (!status.server(name)) throw ApiError.notFound(`unknown MCP server \`${name}\``);
  if (action === "enable" || action === "disable") {
    throw ApiError.conflict(
      `MCP servers are turned on and off in miyoria.toml (\`[mcp.servers.${name}] enabled\`); only restart is available at runtime`,
    );
  }
  if (action !== "restart") {
    throw ApiError.notFound(`unknown action \`${action}\` (expected enable, disable or restart)`);
  }
  await runModuleAction(state, c, MCP_MODULE_ID, "restart", "mcp");
  // The restarted module provides a fresh status.
  const fresh = state.service(McpStatusKey, "MCP module");
  const server = fresh.server(name);
  if (!server) throw ApiError.unavailable(`MCP server \`${name}\` is restarting`);
  return json(mcpInfo(server, state.optional(ToolRegistryKey)));
}

// ---- request queue ----------------------------------------------------------------------

function queueState(queue: RequestQueue): QueueState {
  return {
    paused: queue.isPaused(),
    items: queue.list().map((i) => ({
      id: String(i.id),
      kind: i.kind,
      context: i.context,
      author: { account: i.requester, display_name: i.requester_name },
      text: i.text,
      priority: i.priority,
      enqueued_at: i.created_at,
      state: i.state,
      votes: i.votes,
    })),
  };
}

function queueError(error: unknown): ApiError {
  return isQueueNotFound(error)
    ? ApiError.notFound(errorMessage(error))
    : ApiError.conflict(errorMessage(error));
}

function queue(state: ApiState): Response {
  return json(queueState(state.service(RequestQueueKey, "request queue")));
}

async function setPaused(state: ApiState, c: ApiContext, paused: boolean): Promise<Response> {
  const q = state.service(RequestQueueKey, "request queue");
  if (paused) q.pause();
  else q.resume();
  await state.audit(c, paused ? "queue.pause" : "queue.resume", "queue", {}, true);
  return json(queueState(q));
}

const MoveSchema = z.object({ position: usizeJson });

/** `POST /api/queue/{id}/skip` and `POST /api/queue/{id}/move`. */
async function queueItemAction(state: ApiState, c: ApiContext): Promise<Response> {
  const q = state.service(RequestQueueKey, "request queue");
  const id = param(c, "id");
  const action = param(c, "action");
  const digits = id.trim().replace(/^#+/, "");
  if (!/^\+?\d+$/.test(digits)) throw ApiError.notFound(`no item #${id}`);
  const item = Number.parseInt(digits, 10);
  let failure: unknown = null;
  let detail: Record<string, unknown>;
  if (action === "skip") {
    detail = {};
    try {
      q.skip(item);
    } catch (error) {
      failure = error;
    }
  } else if (action === "move") {
    const request = await readJson(c, MoveSchema);
    // The listing puts active items first; `moveItem` counts pending items only.
    const active = q.list().filter((i) => i.state === "active").length;
    const position = Math.max(request.position - active, 0);
    detail = { position: request.position };
    try {
      q.moveItem(item, position);
    } catch (error) {
      failure = error;
    }
  } else {
    throw ApiError.notFound(`unknown action \`${action}\` (expected skip or move)`);
  }
  if (!(failure !== null && isQueueNotFound(failure))) {
    if (failure !== null) detail.error = errorMessage(failure);
    await state.audit(c, `queue.${action}`, String(item), toJson(detail), failure === null);
  }
  if (failure !== null) throw queueError(failure);
  return json(queueState(q));
}

// ---- stage ------------------------------------------------------------------------------

function stageState(state: ApiState, link: StageLink): StageState {
  const node = link.node()?.[0] ?? null;
  const status = link.status() ?? { vts: false, obs: false, scene: null, streaming: false };
  const part = (connected: boolean, what: string): StageLinkState => ({
    connected: node !== null && connected,
    error:
      node === null
        ? "stage node not connected"
        : connected
          ? null
          : `${what} is not connected on the stage node`,
  });
  return {
    vts: part(status.vts, "VTube Studio"),
    obs: part(status.obs, "OBS"),
    scene: status.scene,
    scenes: [],
    expression: state.monitor.expression(),
    expressions: [],
    overlay_url: null,
    speaking: state.monitor.speaking(),
    node,
    streaming: status.streaming,
  };
}

function stageLink(state: ApiState): StageLink {
  return state.service(StageLinkKey, "stage link");
}

function stage(state: ApiState): Response {
  return json(stageState(state, stageLink(state)));
}

function requireObs(state: ApiState, link: StageLink): void {
  const current = stageState(state, link);
  if (!current.obs.connected) {
    throw ApiError.conflict(current.obs.error ?? "OBS is not connected");
  }
}

const SceneSchema = z.object({ scene: z.string() });

async function stageScene(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, SceneSchema);
  const scene = request.scene.trim();
  if (scene === "") throw ApiError.badRequest("`scene` must not be empty");
  const link = stageLink(state);
  requireObs(state, link);
  let failure: unknown = null;
  try {
    await link.setScene(scene);
  } catch (error) {
    failure = error;
  }
  await state.audit(c, "stage.scene", scene, {}, failure === null);
  if (failure !== null) throw ApiError.badGateway(failure);
  return json(stageState(state, link));
}

const StreamSchema = z.object({ action: z.enum(["start", "stop"]) });

async function stageStream(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, StreamSchema);
  const link = stageLink(state);
  requireObs(state, link);
  let failure: unknown = null;
  try {
    await link.stream(request.action);
  } catch (error) {
    failure = error;
  }
  await state.audit(c, "stage.stream", request.action, {}, failure === null);
  if (failure !== null) throw ApiError.badGateway(failure);
  return json(stageState(state, link));
}

const ExpressionSchema = z.object({ expression: z.string() });

async function stageExpression(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, ExpressionSchema);
  const expression = request.expression.trim();
  if (expression === "") throw ApiError.badRequest("`expression` must not be empty");
  const link = stageLink(state);
  const current = stageState(state, link);
  if (!current.vts.connected) {
    throw ApiError.conflict(current.vts.error ?? "VTube Studio is not connected");
  }
  let failure: unknown = null;
  try {
    await link.hotkey(expression);
  } catch (error) {
    failure = error;
  }
  await state.audit(c, "stage.expression", expression, {}, failure === null);
  if (failure !== null) throw ApiError.badGateway(failure);
  state.monitor.setExpression(expression);
  return json(stageState(state, link));
}

const SaySchema = z.object({ text: z.string(), emotion: z.string().nullish() });

/**
 * Speaks `text` through TTS in the voice channel she is in, without the LLM. Returns as soon as
 * speaking started; the turn id correlates the `voice.playback` events.
 */
async function stageSay(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, SaySchema);
  const text = request.text.trim();
  if (text === "") throw ApiError.badRequest("`text` must not be empty");
  if ([...text].length > MAX_SAY_CHARS) {
    throw ApiError.badRequest(`\`text\` is longer than ${MAX_SAY_CHARS} characters`);
  }
  const sink = state.service(VoiceSinkKey, "voice module");
  const context = state.monitor.voiceContext();
  if (!context) throw ApiError.conflict("she is not in a voice channel");
  const emotion = request.emotion?.trim() || null;
  const turn = newId();
  await state.audit(c, "stage.say", contextKeyString(context), { text, emotion, turn }, true);
  // Fire and forget: the request answers as soon as speaking was handed to the voice module.
  void sink.speak(context, text, emotion, turn, state.ctx.signal).catch((error: unknown) => {
    log.warn({ error: errorMessage(error) }, "speaking from the API failed");
  });
  const body: SayResponse = { turn };
  return json(body);
}

// ---- voice ------------------------------------------------------------------------------

function voice(state: ApiState): Response {
  return json(state.monitor.voice(state.now()));
}

export function opsRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/extensions", handler: () => extensions(state) },
    {
      method: "POST",
      path: "/api/extensions/:id/:action",
      handler: (c) => extensionAction(state, c),
    },
    { method: "GET", path: "/api/mcp", handler: () => mcpServers(state) },
    { method: "POST", path: "/api/mcp/:name/:action", handler: (c) => mcpAction(state, c) },
    { method: "GET", path: "/api/queue", handler: () => queue(state) },
    { method: "POST", path: "/api/queue/pause", handler: (c) => setPaused(state, c, true) },
    { method: "POST", path: "/api/queue/resume", handler: (c) => setPaused(state, c, false) },
    { method: "POST", path: "/api/queue/:id/:action", handler: (c) => queueItemAction(state, c) },
    { method: "GET", path: "/api/stage", handler: () => stage(state) },
    { method: "POST", path: "/api/stage/scene", handler: (c) => stageScene(state, c) },
    { method: "POST", path: "/api/stage/expression", handler: (c) => stageExpression(state, c) },
    { method: "POST", path: "/api/stage/stream", handler: (c) => stageStream(state, c) },
    { method: "POST", path: "/api/stage/say", handler: (c) => stageSay(state, c) },
    { method: "GET", path: "/api/voice", handler: () => voice(state) },
  ];
}
