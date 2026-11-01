// Gateway event handling: messages, typing, readiness and interactions.

import type { CommandRegistry } from "@miyoria/commands";
import { errorMessage, getLogger, type ModuleContext } from "@miyoria/kernel";
import type { ContextKind, PlatformSinks } from "@miyoria/types";
import { type ChannelType, type Client, Events, type Message, MessageType } from "discord.js";
import type { DiscordConfig } from "./config.js";
import { handleCommandInteraction } from "./interaction.js";
import { account, contextKey, incomingMessage, kindOf, PLATFORM } from "./mapping.js";
import { DiscordSink } from "./sink.js";
import { runSyncLoop, syncCommands } from "./sync.js";

const log = getLogger("discord.handler");

const MAX_KIND_CACHE = 10_000;

/** State shared by the gateway handler and the module. */
export class Shared {
  /** The bot account plus every configured self account. */
  readonly selfIds: Set<string>;
  ready = false;
  #syncStarted = false;
  readonly #kinds = new Map<string, ContextKind>();

  constructor(
    readonly config: DiscordConfig,
    selfIds: Iterable<string>,
    readonly registry: CommandRegistry,
    readonly sinks: PlatformSinks | null,
  ) {
    this.selfIds = new Set(selfIds);
  }

  /** `true` the first time, so the sync task starts once per module run. */
  claimSync(): boolean {
    if (this.#syncStarted) return false;
    this.#syncStarted = true;
    return true;
  }

  kind(channel: string): ContextKind | undefined {
    return this.#kinds.get(channel);
  }

  rememberKind(channel: string, kind: ContextKind): void {
    if (this.#kinds.size >= MAX_KIND_CACHE) this.#kinds.clear();
    this.#kinds.set(channel, kind);
  }
}

/** Connects a discord.js `Client` to the event bus and the command registry. */
export class GatewayBridge {
  constructor(
    private readonly ctx: ModuleContext,
    private readonly shared: Shared,
  ) {}

  /** Registers all gateway listeners. Listener errors are logged, never thrown. */
  attach(client: Client): void {
    client.on(Events.ClientReady, (ready) => this.guard("ready", () => this.onReady(ready)));
    client.on(Events.MessageCreate, (msg) =>
      this.guard("message", () => this.onMessage(client, msg)),
    );
    client.on(Events.TypingStart, (typing) =>
      this.guard("typing", async () => {
        const kind = await this.channelKind(
          client,
          typing.guild?.id ?? null,
          typing.channel.id,
          typing.channel.type,
        );
        this.ctx.publish({
          type: "platform_typing",
          data: {
            context: contextKey(typing.guild?.id ?? null, typing.channel.id, kind),
            account: account(typing.user.id),
          },
        });
      }),
    );
    client.on(Events.ThreadCreate, (thread) => {
      this.shared.rememberKind(thread.id, kindOf(thread.type));
    });
    client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      this.guard("interaction", async () => {
        const kind =
          interaction.guildId === null
            ? "dm"
            : interaction.channel
              ? kindOf(interaction.channel.type)
              : await this.channelKind(client, interaction.guildId, interaction.channelId);
        await handleCommandInteraction(this.shared.registry, interaction, kind);
      });
    });
  }

  /** Runs a listener body; failures are logged and never escape into discord.js. */
  private guard(what: string, body: () => void | Promise<void>): void {
    // Fire and forget: discord.js does not await listeners, and an escaping rejection would
    // crash the process.
    void Promise.resolve()
      .then(body)
      .catch((error: unknown) => {
        log.warn({ handler: what, error: errorMessage(error) }, "gateway handler failed");
      });
  }

  private onReady(client: Client<true>): void {
    const bot = client.user.id;
    log.info(
      { user: client.user.username, id: bot, guilds: client.guilds.cache.size },
      "discord bot ready",
    );
    // The bot account first, then her other accounts in id order.
    this.shared.selfIds.add(bot);
    const others = [...this.shared.selfIds]
      .filter((id) => id !== bot)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    for (const id of [bot, ...others]) {
      this.ctx.publish({
        type: "platform_ready",
        data: { platform: PLATFORM, self_account: account(id) },
      });
    }
    this.shared.sinks?.register(new DiscordSink(client.rest));
    this.shared.ready = true;

    if (this.shared.claimSync()) {
      const { registry, config } = this.shared;
      this.ctx.spawn("command-sync", (signal) =>
        runSyncLoop({
          registry,
          signal,
          sync: () =>
            syncCommands(
              client.rest,
              client.application.id,
              registry,
              config.command_guilds,
              signal,
            ),
        }),
      );
    }
  }

  private async onMessage(client: Client, msg: Message): Promise<void> {
    if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) return;
    if (msg.content === "" && msg.attachments.size === 0) return;
    const kind = await this.channelKind(client, msg.guildId, msg.channelId, msg.channel?.type);
    const repliedAuthor = await repliedAuthorId(msg);
    this.ctx.publish({
      type: "platform_message_created",
      data: incomingMessage(msg, kind, this.shared.selfIds, repliedAuthor),
    });
  }

  /** Channel / thread / DM, from the event itself, a memo, the gateway cache or REST. */
  private async channelKind(
    client: Client,
    guild: string | null,
    channel: string,
    known?: ChannelType,
  ): Promise<ContextKind> {
    if (guild === null) return "dm";
    const remembered = this.shared.kind(channel);
    if (remembered) return remembered;
    let type = known ?? client.channels.cache.get(channel)?.type;
    if (type === undefined) {
      try {
        type = (await client.channels.fetch(channel))?.type;
      } catch (error) {
        log.debug({ channel, error: errorMessage(error) }, "cannot resolve channel kind");
        return "channel";
      }
    }
    const kind = type === undefined ? "channel" : kindOf(type);
    this.shared.rememberKind(channel, kind);
    return kind;
  }
}

/** The author of the message `msg` replies to (cache first, then one REST call). */
async function repliedAuthorId(msg: Message): Promise<string | null> {
  const ref = msg.reference?.messageId;
  if (msg.type !== MessageType.Reply || !ref) return null;
  const cached = msg.channel.messages.cache.get(ref);
  if (cached) return cached.author.id;
  try {
    return (await msg.fetchReference()).author.id;
  } catch (error) {
    log.debug({ message: msg.id, error: errorMessage(error) }, "cannot fetch replied message");
    return null;
  }
}
