// Minecraft game adapter extension: connects to the miyoria-bridge mod and
// exposes it as `game.minecraft.observe` / `game.minecraft.act` tools and
// `game.minecraft.*` events (docs/ARCHITECTURE.md §12.3–§12.4).

import { defineExtension } from "@miyoria/sdk";
import { MinecraftAdapter } from "./adapter.js";
import { BridgeClient } from "./bridge.js";
import { type AdapterConfig, resolveEndpoint } from "./config.js";

export { MinecraftAdapter, GAME_ID } from "./adapter.js";
export { BridgeClient, BridgeError } from "./bridge.js";
export { ACTIONS, toRequests } from "./actions.js";
export { mapEvent } from "./events.js";
export { compactState, summarize } from "./summary.js";
export { resolveEndpoint } from "./config.js";

export default defineExtension({
  async activate(ctx) {
    const config = ctx.config as AdapterConfig;
    const bridge = new BridgeClient({
      endpoint: () => resolveEndpoint(config),
      requestTimeoutMs: config.request_timeout_ms,
      reconnectMinMs: config.reconnect_min_ms,
      reconnectMaxMs: config.reconnect_max_ms,
      log: ctx.log,
    });
    const adapter = new MinecraftAdapter(bridge, {
      damageImportant: config.damage_important,
      allowCommands: config.allow_commands,
    });
    await ctx.game.registerAdapter(adapter);
    bridge.start();
    ctx.onShutdown(() => {
      bridge.close();
      adapter.close();
    });
  },
});
