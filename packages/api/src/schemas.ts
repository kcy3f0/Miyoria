// Zod schemas of the shared wire types that arrive in request bodies.

import type { AuthScope } from "@miyoria/store";
import { type ContextKey, contextKeyEquals } from "@miyoria/types";
import { z } from "zod";

export const AccountRefSchema = z.object({ platform: z.string(), id: z.string() });

export const ContextKeySchema = z.object({
  platform: z.string(),
  scope: z.string().nullable().default(null),
  channel: z.string(),
  kind: z.enum(["channel", "thread", "dm", "voice"]),
});

export const AuthScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }),
  z.object({ type: z.literal("guild"), platform: z.string(), guild: z.string() }),
  z.object({ type: z.literal("channel"), context: ContextKeySchema }),
]);

export function scopeEquals(a: AuthScope, b: AuthScope): boolean {
  switch (a.type) {
    case "global":
      return b.type === "global";
    case "guild":
      return b.type === "guild" && a.platform === b.platform && a.guild === b.guild;
    case "channel":
      return b.type === "channel" && contextKeyEquals(a.context, b.context as ContextKey);
  }
}
