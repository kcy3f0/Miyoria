// Services the admin API looks up per request that other modules own. Their keys come from the
// owning packages (`PersonaHandleKey` from `@miyoria/agent`, `SocialKey` from
// `@miyoria/social`, `MemoryEngineKey` from `@miyoria/memory`, `AuthServiceKey` from
// `@miyoria/auth`, `ExtensionCatalogKey` from `@miyoria/ext-host`, `McpStatusKey` from
// `@miyoria/mcp`, `RequestQueueKey` from `@miyoria/queue`, `StageLinkKey` from
// `@miyoria/stage`); only the active profile id has no package yet.

import { type ProfileId, type ServiceKey, serviceKey } from "@miyoria/types";

// The active profile id (legacy `Arc<ProfileId>` service, provided by the app). It has no key in
// `@miyoria/types` yet, so the packages that need it share one key object through a global slot
// (keys are matched by identity), the same one `@miyoria/core`, `@miyoria/mcp` and
// `@miyoria/ext-host` use.
const SLOT = Symbol.for("miyoria.service-key.ProfileId");
const globals = globalThis as { [SLOT]?: ServiceKey<ProfileId> };
if (!globals[SLOT]) globals[SLOT] = serviceKey<ProfileId>("ProfileId");

/** Service: the active profile id. */
export const ActiveProfileKey: ServiceKey<ProfileId> = globals[SLOT];

/** Module id of the MCP module (`McpModule.ID`). */
export const MCP_MODULE_ID = "mcp";

/** Whether a `@miyoria/queue` error is `QueueError::NotFound`. */
export function isQueueNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { kind?: unknown }).kind === "not_found") return true;
  return error instanceof Error && error.message.startsWith("no item #");
}
