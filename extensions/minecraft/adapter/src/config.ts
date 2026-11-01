// Where the miyoria-bridge mod listens and which token it expects.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** `[extensions."miyoria.minecraft"]` config (everything optional). */
export interface AdapterConfig {
  /** Full WebSocket URL, e.g. `"ws://127.0.0.1:7890"`. Wins over `host` / `port`. */
  url?: string;
  host?: string;
  port?: number;
  /** Shared secret; defaults to the one in the mod's config file. */
  token?: string;
  /** Minecraft instance directory; the mod config is `<dir>/config/miyoria-bridge.json`. */
  minecraft_dir?: string;
  /** Explicit path of `miyoria-bridge.json` (wins over `minecraft_dir`). */
  bridge_config?: string;
  request_timeout_ms?: number;
  reconnect_min_ms?: number;
  reconnect_max_ms?: number;
  /** Damage of at least this many points counts as important (worth commentary). */
  damage_important?: number;
  /** Let the `chat` action send `/commands` (off: cheats in her hands are a bad idea). */
  allow_commands?: boolean;
}

export interface Endpoint {
  url: string;
  token: string;
}

export const DEFAULT_PORT = 7890;

interface BridgeFile {
  port?: number;
  token?: string;
}

async function readBridgeFile(path: string): Promise<BridgeFile | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as BridgeFile;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the endpoint: config fields, then the environment
 * (`MIYORIA_MC_URL`, `MIYORIA_MC_TOKEN`, `MIYORIA_MC_DIR`,
 * `MIYORIA_MC_BRIDGE_CONFIG`), then the mod's own config file. Re-run on
 * every connection attempt so a regenerated token is picked up.
 */
export async function resolveEndpoint(
  config: AdapterConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Endpoint> {
  const filePath =
    config.bridge_config ??
    env.MIYORIA_MC_BRIDGE_CONFIG ??
    (config.minecraft_dir ?? env.MIYORIA_MC_DIR
      ? join(config.minecraft_dir ?? env.MIYORIA_MC_DIR ?? "", "config", "miyoria-bridge.json")
      : undefined);
  const file = filePath ? await readBridgeFile(filePath) : undefined;
  const url =
    config.url ??
    env.MIYORIA_MC_URL ??
    `ws://${config.host ?? "127.0.0.1"}:${config.port ?? file?.port ?? DEFAULT_PORT}`;
  const token = config.token ?? env.MIYORIA_MC_TOKEN ?? file?.token ?? "";
  return { url, token };
}
