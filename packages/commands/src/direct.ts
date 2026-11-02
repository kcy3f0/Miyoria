// Cards sent outside a command interaction: a `CommandReply` posted as a new direct message,
// e.g. the approval card the gate sends to the owners. Its controls are routed like any other
// (`mi:<route>:...` → the command that declared the route, under that command's permission).

import { type AccountRef, type MessageRef, type PlatformId, serviceKey } from "@miyoria/types";
import type { CommandReply } from "./reply.js";

/** Provided by a platform module (the Discord bot) as `ReplySinkKey`. */
export interface ReplySink {
  readonly platform: PlatformId;
  /** Sends `reply` (rendered like a command reply, never pinging anyone) as a DM to `account`. */
  sendDirect(account: AccountRef, reply: CommandReply, signal?: AbortSignal): Promise<MessageRef>;
}

export const ReplySinkKey = serviceKey<ReplySink>("ReplySink");
