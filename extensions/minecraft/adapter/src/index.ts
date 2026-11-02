// Minecraft game adapter extension: connects to the miyoria-bridge mod and
// exposes it as `game.minecraft.observe` / `game.minecraft.act` tools and
// `game.minecraft.*` events (docs/ARCHITECTURE.md §12.3–§12.4).

import { defineExtension } from "@miyoria/sdk";
import { MinecraftAdapter } from "./adapter.js";
import { BridgeClient } from "./bridge.js";
import { type AdapterConfig, bridgeConfigPath, resolveEndpoint } from "./config.js";

export { MinecraftAdapter, GAME_ID } from "./adapter.js";
export { BridgeClient, BridgeError } from "./bridge.js";
export { ACTIONS, toRequests } from "./actions.js";
export { mapEvent } from "./events.js";
export { compactState, summarize } from "./summary.js";
export { bridgeConfigPath, defaultMinecraftDir, resolveEndpoint } from "./config.js";

export default defineExtension({
  async activate(ctx) {
    const config = ctx.config as AdapterConfig;
    let warned = false;
    const endpoint = async () => {
      const found = await resolveEndpoint(config);
      if (found.token === "" && !warned) {
        warned = true;
        ctx.log.warn(
          'no miyoria-bridge token: start Minecraft once with the mod, then set minecraft_dir in [extensions."miyoria.minecraft"]',
          { looked_in: bridgeConfigPath(config) ?? null },
        );
      } else if (found.token !== "") {
        warned = false;
      }
      return found;
    };
    const bridge = new BridgeClient({
      endpoint,
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
