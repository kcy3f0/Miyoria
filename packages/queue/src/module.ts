import { type CommandRegistry, CommandRegistryKey } from "@miyoria/commands";
import {
  defineManifest,
  errorMessage,
  getLogger,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import { SocialSignalsKey, serviceKey } from "@miyoria/types";
import { registerCommands } from "./commands.js";
import { QueueConfigSchema } from "./config.js";
import { RequestQueue } from "./queue.js";

const log = getLogger("queue");

export const RequestQueueKey = serviceKey<RequestQueue>("RequestQueue");

interface Running {
  queue: RequestQueue;
  commands: { registry: CommandRegistry; paths: string[] } | null;
}

/**
 * Module `queue`: provides the `RequestQueue`, restores and snapshots its state, publishes
 * `queue.*` events and registers the queue commands.
 *
 * Uses the optional services `SettingsStore` (persistence), `SocialSignals` (affinity
 * weighting) and `CommandRegistry` (commands, module `commands`). Config: see `QueueConfig`.
 */
export class QueueModule implements Module {
  static readonly ID = "queue";
  readonly manifest = defineManifest(QueueModule.ID, "Request queue", {
    description: "Fair request queue with voting mode",
    optional: ["commands", "social"],
    configSchema: QueueConfigSchema,
  });
  #running: Running | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(QueueConfigSchema);
    const queue = new RequestQueue(config, {
      social: ctx.services.get(SocialSignalsKey) ?? null,
      store: ctx.services.get(SettingsStoreKey) ?? null,
      publisher: (event) => ctx.publish(event),
      clock: ctx.clock,
    });
    try {
      if (await queue.restore()) log.info("restored the request queue");
    } catch (error) {
      log.warn(
        { error: errorMessage(error) },
        "could not restore the request queue; starting empty",
      );
    }

    const registry = ctx.services.get(CommandRegistryKey);
    const commands = registry ? { registry, paths: registerCommands(registry, queue) } : null;

    ctx.provide(RequestQueueKey, queue);
    ctx.spawn("queue", (signal) => queue.run(signal));
    this.#running = { queue, commands };
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    if (running.commands) {
      for (const path of running.commands.paths) running.commands.registry.unregister(path);
    }
    await running.queue.persist();
  }
}
