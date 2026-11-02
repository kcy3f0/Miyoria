// Gateway event handling: messages, typing, readiness, interactions, and presence / voice state /
// member changes for the `world` module (presence.ts).

import { type CommandRegistry, PanelSessions } from "@miyoria/commands";
import { errorMessage, getLogger, type ModuleContext } from "@miyoria/kernel";
import {
  type AccountRef,
  type ContextKind,
  type PlatformSinks,
  PresencePrivacyKey,
} from "@miyoria/types";
import {
  type ChannelType,
  type Client,
  Events,
  type Interaction,
  type Message,
  MessageType,
  Routes,
} from "discord.js";
import type { DiscordConfig } from "./config.js";
import {
  handleAutocomplete,
  handleCommandInteraction,
  handleComponentInteraction,
  type InteractionEnv,
} from "./interaction.js";
import { account, contextKey, incomingMessage, kindOf, PLATFORM } from "./mapping.js";
import {
  type GuildMemberLike,
  memberEvent,
  memberUpdate,
  type PresenceLike,
  presenceEvent,
  presenceUpdate,
  type VoiceStateLike,
  voiceStateEvent,
  voiceStateUpdate,
} from "./presence.js";
import { DiscordSink } from "./sink.js";
import { runSyncLoop, syncCommands } from "./sync.js";

const log = getLogger("discord.handler");

const MAX_KIND_CACHE = 10_000;

/** The parts of a discord.js `Guild` the presence snapshot reads. */
export interface GuildLike {
  id: string;
  members: {
    fetch(): Promise<unknown>;
    cache: { values(): Iterable<GuildMemberLike> };
  };
  presences: { cache: { values(): Iterable<PresenceLike> } };
  voiceStates: { cache: { values(): Iterable<VoiceStateLike> } };
}

/** State shared by the gateway handler and the module. */
export class Shared {
  /** The bot account plus every configured self account. */
  readonly selfIds: Set<string>;
  ready = false;
  #syncStarted = false;
  readonly #kinds = new Map<string, ContextKind>();
  /** Messages with live controls (panels). */
  readonly sessions = new PanelSessions({
    onError: (error) => log.debug({ error: errorMessage(error) }, "cannot disable a panel"),
  });

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
      this.guard("interaction", () => this.onInteraction(client, interaction));
    });
    client.on(Events.PresenceUpdate, (_old, presence) =>
      this.guard("presence", () => this.onPresence(presence, false)),
    );
    client.on(Events.VoiceStateUpdate, (_old, state) =>
      this.guard("voice state", () => this.onVoiceState(state, false)),
    );
    client.on(Events.GuildMemberAdd, (member) =>
      this.guard("member", () => this.onMember(member, false)),
    );
    client.on(Events.GuildMemberUpdate, (_old, member) =>
      this.guard("member", () => this.onMember(member, false)),
    );
    client.on(Events.GuildMemberRemove, (member) =>
      this.guard("member", () => this.onMember(member, true)),
    );
    client.on(Events.GuildCreate, (guild) =>
      this.guard("guild snapshot", () => this.snapshotGuild(guild as unknown as GuildLike)),
    );
  }

  /**
   * Publishes everyone the gateway cache knows in `guild` (members, presences, voice states) as
   * `initial` updates, after fetching the member list when the members intent is on.
   */
  async snapshotGuild(guild: GuildLike): Promise<void> {
    if (this.shared.config.presence_intents) {
      try {
        await guild.members.fetch();
      } catch (error) {
        log.debug({ guild: guild.id, error: errorMessage(error) }, "cannot fetch guild members");
      }
      for (const member of guild.members.cache.values()) this.onMember(member, false);
      for (const presence of guild.presences.cache.values()) this.onPresence(presence, true);
    }
    for (const state of guild.voiceStates.cache.values()) this.onVoiceState(state, true);
  }

  /** Presence is only published for people who did not opt out (fails closed without `world`). */
  presenceAllowed(who: AccountRef): boolean {
    if (this.shared.selfIds.has(who.id)) return false;
    return this.ctx.services.get(PresencePrivacyKey)?.presenceAllowed(who) ?? false;
  }

  onPresence(presence: PresenceLike, initial: boolean): void {
    const update = presenceUpdate(presence, initial);
    if (update === null || !this.presenceAllowed(update.account)) return;
    this.ctx.publish(presenceEvent(update));
  }

  onVoiceState(state: VoiceStateLike, initial: boolean): void {
    this.ctx.publish(voiceStateEvent(voiceStateUpdate(state, initial)));
  }

  onMember(member: GuildMemberLike, left: boolean): void {
    this.ctx.publish(memberEvent(memberUpdate(member, left)));
  }

  /** The handlers' shared environment. */
  env(client: Client): InteractionEnv {
    return {
      registry: this.shared.registry,
      sessions: this.shared.sessions,
      editChannelMessage: async (channel, message, payload) => {
        await client.rest.patch(Routes.channelMessage(channel, message), {
          body: {
            components: payload.components,
            flags: payload.flags,
            allowed_mentions: { parse: [] },
          },
        });
      },
    };
  }

  /** Slash commands, autocomplete, buttons, select menus and modal submissions. */
  private async onInteraction(client: Client, interaction: Interaction): Promise<void> {
    const kindOfInteraction = async (): Promise<ContextKind> => {
      if (interaction.guildId === null) return "dm";
      if (interaction.channel) return kindOf(interaction.channel.type);
      return this.channelKind(client, interaction.guildId, interaction.channelId ?? "");
    };
    if (interaction.isChatInputCommand()) {
      const kind = await kindOfInteraction();
      await handleCommandInteraction(this.env(client), interaction, kind);
    } else if (interaction.isAutocomplete()) {
      const kind = await kindOfInteraction();
      await handleAutocomplete(this.env(client), interaction, kind);
    } else if (
      interaction.isButton() ||
      interaction.isStringSelectMenu() ||
      interaction.isModalSubmit()
    ) {
      const kind = await kindOfInteraction();
      await handleComponentInteraction(this.env(client), interaction, kind);
    }
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
    for (const guild of client.guilds.cache.values()) {
      this.guard("guild snapshot", () => this.snapshotGuild(guild as unknown as GuildLike));
    }

    if (this.shared.claimSync()) {
      const { registry, config } = this.shared;
      this.ctx.spawn("command-sync", (signal) =>
        runSyncLoop({
          registry,
          signal,
          sync: (first) =>
            syncCommands(client.rest, client.application.id, registry, config.command_guilds, {
              signal,
              // Once per run: clear the scope not in use (stale duplicates in the list).
              cleanup: first ? { guilds: [...client.guilds.cache.keys()] } : null,
            }),
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
