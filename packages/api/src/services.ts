// Services the admin API looks up per request that other modules own. Their keys come from the
// owning packages (`PersonaHandleKey` from `@miyoria/agent`, `SocialKey` from
// `@miyoria/social`, `MemoryEngineKey` from `@miyoria/memory`, `AuthServiceKey` from
// `@miyoria/auth`, `ExtensionCatalogKey` from `@miyoria/ext-host`, `McpStatusKey` from
// `@miyoria/mcp`, `RequestQueueKey` from `@miyoria/queue`, `StageLinkKey` from
// `@miyoria/stage`, `ProfileIdKey` from `@miyoria/types`).

import { ProfileIdKey } from "@miyoria/types";

/** Service: the active profile id (alias of `ProfileIdKey`). */
export const ActiveProfileKey = ProfileIdKey;

/** Module id of the MCP module (`McpModule.ID`). */
export const MCP_MODULE_ID = "mcp";

/** Whether a `@miyoria/queue` error is `QueueError::NotFound`. */
export function isQueueNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { kind?: unknown }).kind === "not_found") return true;
  return error instanceof Error && error.message.startsWith("no item #");
}
