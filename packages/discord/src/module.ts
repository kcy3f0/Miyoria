// Module `platform.discord.bot`: the official bot account. Text messages, reactions, typing and
// slash commands; never voice.
//
// Developer Portal setup:
//
// 1. Create an application at https://discord.com/developers/applications and add a bot under
//    **Bot**. Copy its token into the environment (e.g. `DISCORD_BOT_TOKEN`) and reference it
//    as `token = "${DISCORD_BOT_TOKEN}"`.
// 2. Under **Bot -> Privileged Gateway Intents**, enable **Message Content Intent**. Without it
//    the gateway refuses to connect (disallowed intents) and the module keeps failing.
// 3. Invite the bot with the `bot` and `applications.commands` scopes and the permissions View
//    Channels, Send Messages, Send Messages in Threads, Read Message History and Add Reactions.
// 4. For instant command updates during development, list your server ids in `command_guilds`;
//    otherwise commands are registered globally. The first sync of every run clears the scope
//    not in use, so switching modes leaves no duplicates; `miyoria discord commands reset`
//    clears everything by hand.

import { CommandRegistryKey, CommandsModule } from "@miyoria/commands";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  type ModuleManifest,
  withTimeout,
} from "@miyoria/kernel";
import { PlatformSinksKey } from "@miyoria/types";
import { Client, Events, GatewayIntentBits, Options, Partials } from "discord.js";
import { DiscordConfigSchema, validateDiscordConfig } from "./config.js";
import { GatewayBridge, Shared } from "./handler.js";
import { PLATFORM, parseUserIds } from "./mapping.js";

/** How long to wait for the gateway to close after a shutdown request. */
export const SHUTDOWN_GRACE_MS = 3_000;

/** Gateway close codes after which reconnecting is pointless. */
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/**
 * Gateway intents the bot needs. `MessageContent` is privileged and must be enabled in the
 * Developer Portal.
 */
export function intents(): number {
  return (
    GatewayIntentBits.Guilds |
    GatewayIntentBits.GuildMessages |
    GatewayIntentBits.DirectMessages |
    GatewayIntentBits.MessageContent |
    GatewayIntentBits.GuildMessageTyping |
    GatewayIntentBits.DirectMessageTyping
  );
}

/** Creates the client. Channel and user partials are needed for DMs and typing events. */
export function createClient(): Client {
  return new Client({
    intents: intents(),
    partials: [Partials.Channel, Partials.User],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 100,
    }),
  });
}

export class DiscordBotModule implements Module {
  static readonly ID = "platform.discord.bot";

  readonly manifest: ModuleManifest = defineManifest(DiscordBotModule.ID, "Discord bot", {
    description: "Discord bot account: text messages and slash commands",
    requires: [CommandsModule.ID],
    configSchema: DiscordConfigSchema,
  });

  #running: Shared | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(DiscordConfigSchema);
    validateDiscordConfig(config);
    const selfIds = parseUserIds(config.self_account_ids);
    const registry = ctx.services.require(CommandRegistryKey);
    const sinks = ctx.services.get(PlatformSinksKey) ?? null;
    if (sinks === null) {
      ctx.log.warn("PlatformSinks service missing; output actions cannot reach Discord");
    }
    const shared = new Shared(config, selfIds, registry, sinks);
    this.#running = shared;
    const client = createClient();
    new GatewayBridge(ctx, shared).attach(client);
    // The token stays in this closure; it is never logged or put in an error message.
    const token = config.token;
    ctx.spawn("gateway", (signal) => runGateway(client, token, shared, ctx, signal));
  }

  async stop(): Promise<void> {
    const shared = this.#running;
    this.#running = null;
    if (shared) {
      shared.ready = false;
      shared.sessions.closeAll();
      shared.sinks?.unregister(PLATFORM);
    }
  }

  async health(): Promise<Health> {
    const shared = this.#running;
    if (shared === null) return { status: "unhealthy", reason: "not running" };
    return shared.ready ? HEALTHY : { status: "degraded", reason: "connecting to Discord" };
  }
}

/**
 * Logs in and keeps the gateway open until `signal` aborts (then closes it cleanly). Rejects when
 * the login fails or Discord closes the gateway for good (bad token, disallowed intents), so the
 * supervisor restarts the module with backoff.
 */
async function runGateway(
  client: Client,
  token: string,
  shared: Shared,
  ctx: ModuleContext,
  signal: AbortSignal,
): Promise<void> {
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const fatal = new Promise<never>((_, reject) => {
    client.on(Events.ShardDisconnect, (event) => {
      shared.ready = false;
      if (FATAL_CLOSE_CODES.has(event.code)) {
        reject(new Error(`Discord gateway closed with code ${event.code}`));
      }
    });
  });
  // Handled below via the race; this keeps a late rejection (after shutdown) from being unhandled.
  fatal.catch(() => undefined);
  client.on(Events.ShardReady, () => {
    shared.ready = true;
  });
  client.on(Events.ShardResume, () => {
    shared.ready = true;
  });
  client.on(Events.Error, (error) => {
    ctx.log.warn({ error: errorMessage(error) }, "Discord client error");
  });
  client.on(Events.ShardError, (error) => {
    ctx.log.warn({ error: errorMessage(error) }, "Discord shard error");
  });

  const login = client.login(token);
  login.catch(() => undefined); // an abort during login settles the race below instead
  try {
    await Promise.race([login, aborted, fatal]);
    if (!signal.aborted) await Promise.race([aborted, fatal]);
  } finally {
    ctx.log.info("shutting down Discord gateway");
    await withTimeout(
      client.destroy().catch((error: unknown) => {
        ctx.log.debug({ error: errorMessage(error) }, "error while closing the gateway");
      }),
      SHUTDOWN_GRACE_MS,
    );
  }
}
