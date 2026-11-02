// The owner's per-channel levels (docs/design/autonomy.md §21): `GET /api/channels/levels` (the
// levels and the text channels she has seen recently or that have their own level) and `PUT
// /api/channels/level` (set or reset one, like `/channel mode`). Changing needs the same node as
// the command, `admin.channel.mode` (the bearer token has every right).

import {
  AgentHandleKey,
  CHANNEL_MODES,
  type ChannelMode,
  modeDescription,
  modeLabel,
  parseChannelMode,
} from "@miyoria/agent";
import {
  AuthorizerKey,
  type ContextKey,
  contextKeyString,
  PlatformSinksKey,
  WorldStateKey,
} from "@miyoria/types";
import { z } from "zod";
import { parseContextKeyString } from "./data.js";
import { ApiError } from "./errors.js";
import { readJson } from "./extract.js";
import { json, type Route } from "./route.js";
import { ContextKeySchema } from "./schemas.js";
import type { ApiContext, ApiState } from "./state.js";
import type { ChannelLevelsView, ChannelLevelView } from "./types.js";

export const NODE_CHANNEL_MODE = "admin.channel.mode";

const LevelSchema = z.object({
  context: ContextKeySchema,
  /** A level, or `null` to go back to the configured one. */
  mode: z.string().nullable(),
});

const isText = (c: ContextKey) => c.kind === "channel" || c.kind === "thread";

function requireNode(state: ApiState, c: ApiContext): void {
  const principal = c.get("principal");
  if (principal.kind === "token") return;
  const authorizer = state.optional(AuthorizerKey);
  if (!authorizer?.allows(principal.record.account, NODE_CHANNEL_MODE)) {
    throw new ApiError(403, `this needs \`${NODE_CHANNEL_MODE}\``);
  }
}

function handleOf(state: ApiState) {
  return state.service(AgentHandleKey, "agent module");
}

async function levelView(state: ApiState, context: ContextKey): Promise<ChannelLevelView> {
  const handle = handleOf(state);
  let label: string | null = null;
  try {
    label = await state.labels.label(state.optional(PlatformSinksKey), context);
  } catch {
    label = null;
  }
  return {
    context,
    label,
    mode: handle.channelMode(context),
    custom: handle.channelModeOverride(context) !== null,
    default: handle.configuredChannelMode(context),
  };
}

async function levels(state: ApiState): Promise<ChannelLevelsView> {
  const handle = handleOf(state);
  const contexts = new Map<string, ContextKey>();
  for (const c of state.optional(WorldStateKey)?.snapshot().channels ?? []) {
    if (isText(c.context)) contexts.set(contextKeyString(c.context), c.context);
  }
  for (const [key] of handle.channelModeOverrides()) {
    const context = parseContextKeyString(key);
    if (context !== null && isText(context) && !contexts.has(key)) contexts.set(key, context);
  }
  return {
    levels: CHANNEL_MODES.map((mode) => ({
      mode,
      label: modeLabel(mode),
      description: modeDescription(mode),
    })),
    channels: await Promise.all([...contexts.values()].map((c) => levelView(state, c))),
  };
}

async function setLevel(state: ApiState, c: ApiContext): Promise<Response> {
  requireNode(state, c);
  const request = await readJson(c, LevelSchema);
  const context = request.context as ContextKey;
  if (!isText(context)) throw ApiError.badRequest("levels are for text channels");
  let mode: ChannelMode | null = null;
  if (request.mode !== null) {
    try {
      mode = parseChannelMode(request.mode);
    } catch (error) {
      throw ApiError.badRequest(error instanceof Error ? error.message : String(error));
    }
  }
  let failure: unknown = null;
  try {
    await handleOf(state).setChannelMode(context, mode);
  } catch (error) {
    // Applied in memory; only persisting failed.
    failure = error;
  }
  const target = contextKeyString(context);
  await state.audit(c, "channel.level", target, { mode }, failure === null);
  if (failure !== null) throw ApiError.badGateway(failure);
  return json(await levelView(state, context));
}

export function channelRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/channels/levels", handler: async () => json(await levels(state)) },
    { method: "PUT", path: "/api/channels/level", handler: (c) => setLevel(state, c) },
  ];
}
