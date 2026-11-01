// Keeps Discord's application commands in step with the `CommandRegistry`.

import type { CommandRegistry } from "@miyoria/commands";
import { errorMessage, getLogger, sleep } from "@miyoria/kernel";
import { Routes } from "discord.js";
import { buildTree, type SlashCommandJson, toCreateCommands } from "./slash.js";

const log = getLogger("discord.sync");

/** Batches bursts of command registrations into one sync. */
export const SYNC_DEBOUNCE_MS = 2_000;

/** The registry methods the syncer reads. */
export type CommandSource = Pick<CommandRegistry, "specs" | "groupDescription" | "version">;

/** The slice of the REST client the syncer uses (`put` with a body). */
export interface SyncRest {
  put(route: `/${string}`, options?: { body?: unknown; signal?: AbortSignal }): Promise<unknown>;
}

/** The JSON bodies of the registry's current commands. */
export function currentCommands(registry: CommandSource): SlashCommandJson[] {
  const tree = buildTree(registry.specs(), (path) => registry.groupDescription(path) ?? null);
  return toCreateCommands(tree);
}

/**
 * Overwrites the application commands with the registry's current set: globally when
 * `commandGuilds` is empty, otherwise in each listed guild. Failures are logged, not thrown.
 */
export async function syncCommands(
  rest: SyncRest,
  applicationId: string,
  registry: CommandSource,
  commandGuilds: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const body = currentCommands(registry);
  const count = body.length;
  if (commandGuilds.length === 0) {
    try {
      await rest.put(Routes.applicationCommands(applicationId), { body, signal });
      log.info({ count }, "synced global slash commands");
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot sync global slash commands");
    }
    return;
  }
  for (const guild of commandGuilds) {
    try {
      await rest.put(Routes.applicationGuildCommands(applicationId, guild), { body, signal });
      log.info({ guild, count }, "synced guild slash commands");
    } catch (error) {
      log.warn({ guild, error: errorMessage(error) }, "cannot sync guild slash commands");
    }
  }
}

export interface SyncLoopOptions {
  registry: Pick<CommandRegistry, "subscribe" | "version">;
  /** Runs one sync. Called once at the start and after each (debounced) registry change. */
  sync(): Promise<void>;
  debounceMs?: number;
  signal: AbortSignal;
}

/**
 * Syncs once, then again after the registry changed and stayed quiet for `debounceMs`. Returns
 * when `signal` aborts.
 */
export async function runSyncLoop(options: SyncLoopOptions): Promise<void> {
  const { registry, sync, signal } = options;
  const debounceMs = options.debounceMs ?? SYNC_DEBOUNCE_MS;
  const changes = registry.subscribe(signal);
  try {
    let synced = registry.version();
    await sync();
    for (;;) {
      if ((await changes.changed()) === null) return;
      try {
        await sleep(debounceMs, signal);
      } catch {
        return; // aborted
      }
      // Changes during the sleep are covered by reading the version now.
      if (registry.version() === synced) continue;
      synced = registry.version();
      await sync();
    }
  } finally {
    changes.close();
  }
}
