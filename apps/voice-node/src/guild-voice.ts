// One voice session: the self account's connection to a single voice channel in a single guild.
// Owns the @discordjs/voice connection, the AudioPlayer + playback queue, and the capture manager.
import {
  createAudioPlayer,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
  entersState,
  joinVoiceChannel,
  VoiceConnectionDisconnectReason,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Client, Guild } from "@lng2004/discord.js-selfbot-v13";
import { CaptureManager, type StreamIdAllocator } from "./capture.js";
import type { Config } from "./config.js";
import { listParticipants, makeSpeakerResolver } from "./discord.js";
import type { LinkSink } from "./link.js";
import type { Logger } from "./log.js";
import { DiscordPlayerPort } from "./playback/discord-port.js";
import { type PlaybackEvent, PlaybackQueue } from "./playback/queue.js";
import { PlaybackSource } from "./playback/source.js";

export interface GuildVoiceDeps {
  client: Client<true>;
  guild: Guild;
  link: LinkSink;
  cfg: Config;
  ids: StreamIdAllocator;
  log: Logger;
  onPlaybackEvent: (ev: PlaybackEvent) => void;
  /** The connection died on its own (kicked, channel deleted, network). The owner should drop the session. */
  onLost: (session: GuildVoice, reason: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class GuildVoice {
  readonly guildId: string;
  channelId: string;

  private readonly d: GuildVoiceDeps;
  private readonly log: Logger;
  private connection: VoiceConnection | undefined;
  private player: AudioPlayer | undefined;
  private capture: CaptureManager | undefined;
  queue: PlaybackQueue | undefined;
  private closed = false;

  constructor(deps: GuildVoiceDeps, channelId: string) {
    this.d = deps;
    this.guildId = deps.guild.id;
    this.channelId = channelId;
    this.log = deps.log;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Joins the channel and waits until the voice connection is Ready. Throws on failure. */
  async connect(): Promise<void> {
    const { guild, client, cfg } = this.d;
    const connection = joinVoiceChannel({
      guildId: this.guildId,
      channelId: this.channelId,
      // Structurally identical to discord.js's adapter; only the nominal types differ.
      adapterCreator: guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
      // She has to hear people (selfDeaf must stay false or Discord sends no audio) and speak.
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
      debug: true,
    });
    this.connection = connection;

    connection.on("debug", (m) => this.log.debug("voice:", m));
    connection.on("error", (e) => this.log.warn("voice connection error:", e.message));
    connection.on("stateChange", (o, n) => {
      this.log.debug(`voice ${this.guildId}: ${o.status} -> ${n.status}`);
      void this.onStateChange(connection, n);
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      this.closed = true;
      try {
        connection.destroy();
      } catch {
        // already destroyed
      }
      throw new Error(
        `could not establish the voice connection within 30 s (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (this.closed) return;

    const player = createAudioPlayer();
    this.player = player;
    connection.subscribe(player);
    player.on("debug", (m) => this.log.debug("player:", m));

    this.queue = new PlaybackQueue({
      port: new DiscordPlayerPort(player, this.log),
      onEvent: this.d.onPlaybackEvent,
      createSource: (sampleRate) =>
        new PlaybackSource({
          sampleRate,
          maxBufferBytes: cfg.playbackMaxBufferS * sampleRate * 2,
          prebufferMs: cfg.playbackPrebufferMs,
          maxStarveMs: cfg.playbackMaxStarveMs,
        }),
      log: this.log,
    });

    this.capture = new CaptureManager({
      receiver: connection.receiver,
      link: this.d.link,
      guildId: this.guildId,
      getChannelId: () => this.channelId,
      selfId: client.user.id,
      silenceMs: cfg.silenceMs,
      ids: this.d.ids,
      resolveSpeaker: makeSpeakerResolver(client, guild, this.log),
      log: this.log,
    });
    this.capture.start();
  }

  /** Reports `joined` + `voice_state` to Core. */
  announce(): void {
    if (this.closed) return;
    this.d.link.send({ type: "joined", guild: this.guildId, channel: this.channelId });
    this.sendVoiceState();
  }

  sendVoiceState(): void {
    if (this.closed) return;
    this.d.link.send({
      type: "voice_state",
      guild: this.guildId,
      channel: this.channelId,
      participants: listParticipants(this.d.guild, this.channelId, this.d.client.user.id),
    });
  }

  /** An admin moved the self account to another channel (same guild). */
  noteMoved(channelId: string): void {
    if (this.closed || channelId === this.channelId) return;
    this.log.info(`moved ${this.channelId} -> ${channelId} in guild ${this.guildId}`);
    this.channelId = channelId;
    this.announce();
  }

  /** The Core link was re-established: it has forgotten everything. */
  onLinkReset(): void {
    this.capture?.onLinkReset();
  }

  /** The Core link went down: stop talking, nobody is driving us. */
  onLinkDown(): void {
    this.queue?.clear();
  }

  /** Leaves the channel and releases everything. Idempotent. */
  close(): void {
    if (this.closed && !this.connection) return;
    this.closed = true;
    this.capture?.stop();
    this.queue?.clear();
    this.player?.stop(true);
    const c = this.connection;
    this.connection = undefined;
    if (c && c.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        c.destroy();
      } catch (err) {
        this.log.debug("destroy failed:", err);
      }
    }
  }

  private lost(reason: string): void {
    if (this.closed) return;
    this.d.onLost(this, reason);
  }

  /** Called by the owner when the gateway says the self account is no longer in the channel. */
  notifyDisconnected(reason: string): void {
    this.lost(reason);
  }

  /** Standard @discordjs/voice recovery: give a moved/kicked connection a moment, then rejoin or give up. */
  private async onStateChange(
    connection: VoiceConnection,
    state: VoiceConnection["state"],
  ): Promise<void> {
    if (this.closed || this.connection !== connection) return;
    if (state.status === VoiceConnectionStatus.Destroyed) {
      this.lost("voice connection destroyed");
      return;
    }
    if (state.status !== VoiceConnectionStatus.Disconnected) return;

    if (
      state.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
      state.closeCode === 4014
    ) {
      // Moved to another channel, or kicked. If we are moved, the connection resumes by itself.
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, 5000);
      } catch {
        this.lost("disconnected from the voice channel");
      }
      return;
    }
    if (connection.rejoinAttempts < 5) {
      await sleep((connection.rejoinAttempts + 1) * 5000);
      if (!this.closed && this.connection === connection && connection.state.status === VoiceConnectionStatus.Disconnected) {
        connection.rejoin();
      }
      return;
    }
    this.lost("voice connection lost");
  }
}
