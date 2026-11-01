import type { ContextKey } from "@miyoria/types";
import { type ArgValue, Invocation, parseAccount, splitPath } from "../src/index.js";

export const dmContext: ContextKey = { platform: "discord", scope: null, channel: "9", kind: "dm" };

export const guildContext: ContextKey = {
  platform: "discord",
  scope: "10",
  channel: "20",
  kind: "channel",
};

/** An invocation by `discord:<invoker>` in a DM (or `context`). */
export function inv(
  path: string,
  invoker: string,
  args: Record<string, ArgValue> = {},
  context: ContextKey = dmContext,
): Invocation {
  return new Invocation({
    path: splitPath(path),
    args,
    invoker: parseAccount(`discord:${invoker}`),
    invoker_display_name: "someone",
    context,
    invoker_is_guild_admin: false,
  });
}
