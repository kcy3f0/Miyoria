// The voice node proper: translates Voice Link commands from Core into Discord voice sessions
// and Discord voice events back into Voice Link messages.
import type { Client, VoiceState } from "@lng2004/discord.js-selfbot-v13";
import { StreamIdAllocator } from "./capture.js";
import type { Config } from "./config.js";
import { findUserVoiceChannel, resolveVoiceChannel } from "./discord.js";
import { GuildVoice } from "./guild-voice.js";
import type { CoreLink } from "./link.js";
import type { Logger } from "./log.js";
import type { PlaybackEvent } from "./playback/queue.js";
import type { CoreMessage, NodeMessage } from "./protocol.js";

export class VoiceNode {
  private readonly sessions = new Map<string, GuildVoice>();
  /** play id -> guild id, for routing binary audio frames (they carry no guild). */
  private readonly plays = new Map<number, string>();
  /** Per-guild promise chain so join / leave for one guild never interleave. */
  private readonly ops = new Map<string, Promise<void>>();
  private readonly ids = new StreamIdAllocator();
  private shuttingDown = false;

  constructor(
    private readonly client: Client<true>,
    private readonly link: CoreLink,
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.link.on("ready", () => this.onLinkReady());
    this.link.on("down", () => this.onLinkDown());
    this.link.on("message", (msg) => this.onCoreMessage(msg));
    this.link.on("playbackAudio", (play, pcm) => this.onPlaybackAudio(play, pcm));
    this.client.on("voiceStateUpdate", (oldState, newState) => this.onVoiceStateUpdate(oldState, newState));
  }

  /** Leaves every channel, telling Core. Call before closing the link. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const session of [...this.sessions.values()]) this.dropSession(session, "shutdown");
    this.plays.clear();
    await Promise.allSettled([...this.ops.values()]);
  }

  // ── Core link events ─────────────────────────────────────────────────────

  private onLinkReady(): void {
    // A (re)connected Core has no state: tell it where we are.
    for (const s of this.sessions.values()) {
      s.onLinkReset();
      s.announce();
    }
  }

  private onLinkDown(): void {
    // Nobody is driving playback any more, and Core has forgotten every play id.
    this.plays.clear();
    for (const s of this.sessions.values()) s.onLinkDown();
  }

  private onCoreMessage(msg: CoreMessage): void {
    switch (msg.type) {
      case "join":
        this.enqueue(msg.guild, () => this.doJoin(msg.guild, msg.channel, msg.user_id));
        break;
      case "leave":
        this.enqueue(msg.guild, () => this.doLeave(msg.guild));
        break;
      case "play_start":
        this.doPlayStart(msg.play, msg.guild, msg.sample_rate);
        break;
      case "play_end":
        this.sessionForPlay(msg.play)?.queue?.end(msg.play);
        break;
      case "play_stop":
        this.sessionForPlay(msg.play)?.queue?.stop(msg.play, msg.fade_ms);
        break;
      default:
        break; // welcome / ping are handled by the link
    }
  }

  private onPlaybackAudio(play: number, pcm: Buffer): void {
    const accepted = this.sessionForPlay(play)?.queue?.push(play, pcm);
    if (accepted === undefined) this.log.debug(`audio for unknown play ${play}, dropped`);
  }

  // ── commands ─────────────────────────────────────────────────────────────

  private enqueue(guildId: string, op: () => Promise<void>): void {
    const prev = this.ops.get(guildId) ?? Promise.resolve();
    const next = prev
      .then(op)
      .catch((err: unknown) => {
        this.log.error(`operation failed for guild ${guildId}:`, err);
        this.sendError(`internal error: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (this.ops.get(guildId) === next) this.ops.delete(guildId);
      });
    this.ops.set(guildId, next);
  }

  private sendError(message: string): void {
    this.log.warn(message);
    this.link.send({ type: "error", message });
  }

  private async doJoin(guildId: string, channelHint: string | undefined, userId: string | undefined): Promise<void> {
    if (this.shuttingDown) return;
    const guild =
      this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      this.sendError(`join: guild ${guildId} not found (is the self account a member?)`);
      return;
    }

    let channelId = channelHint;
    if (!channelId) {
      // join by user: follow that member into whatever voice channel they are in right now
      channelId = (await findUserVoiceChannel(guild, userId as string)) ?? undefined;
      if (!channelId) {
        this.sendError(`join: user ${userId} is not in a voice channel in guild ${guildId}`);
        return;
      }
    }

    const existing = this.sessions.get(guildId);
    if (existing && !existing.isClosed && existing.channelId === channelId) {
      existing.announce(); // already there; re-report so Core is in sync
      return;
    }

    const lookup = await resolveVoiceChannel(guild, channelId);
    if (!lookup.ok) {
      this.sendError(`join: ${lookup.error}`);
      return;
    }

    if (existing) this.dropSession(existing, "moved");

    const session = new GuildVoice(
      {
        client: this.client,
        guild,
        link: this.link,
        cfg: this.cfg,
        ids: this.ids,
        log: this.log,
        onPlaybackEvent: (ev) => this.onPlaybackEvent(ev),
        onLost: (s, reason) => this.onSessionLost(s, reason),
      },
      channelId,
    );
    try {
      await session.connect();
    } catch (err) {
      session.close();
      this.sendError(`join: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (this.shuttingDown) {
      session.close();
      return;
    }
    this.sessions.set(guildId, session);
    this.log.info(`joined channel ${channelId} in guild ${guildId}`);
    session.announce();
  }

  private async doLeave(guildId: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) {
      this.link.send({ type: "left", guild: guildId, reason: "not in a voice channel" });
      return;
    }
    this.dropSession(session, "leave");
  }

  private doPlayStart(play: number, guildId: string, sampleRate: number): void {
    const fail = (error: string): void => {
      this.link.send({ type: "playback", play, state: "failed", error });
    };
    const session = this.sessions.get(guildId);
    if (!session || session.isClosed || !session.queue) {
      fail(`not in a voice channel in guild ${guildId}`);
      return;
    }
    if (this.plays.has(play)) {
      fail(`play id ${play} is already in use`);
      return;
    }
    const r = session.queue.start(play, sampleRate);
    if (!r.ok) {
      fail(r.error);
      return;
    }
    this.plays.set(play, guildId);
  }

  private sessionForPlay(play: number): GuildVoice | undefined {
    const guildId = this.plays.get(play);
    return guildId === undefined ? undefined : this.sessions.get(guildId);
  }

  private onPlaybackEvent(ev: PlaybackEvent): void {
    if (ev.state !== "started") this.plays.delete(ev.play);
    const msg: Extract<NodeMessage, { type: "playback" }> = {
      type: "playback",
      play: ev.play,
      state: ev.state,
    };
    if (ev.error !== undefined) msg.error = ev.error;
    this.link.send(msg);
  }

  // ── session lifecycle ────────────────────────────────────────────────────

  /** Tears a session down and tells Core. */
  private dropSession(session: GuildVoice, reason: string): void {
    if (this.sessions.get(session.guildId) === session) this.sessions.delete(session.guildId);
    // close() clears the playback queue; its events carry play ids, so forget them afterwards
    session.close();
    for (const [play, guild] of this.plays) if (guild === session.guildId) this.plays.delete(play);
    this.link.send({ type: "left", guild: session.guildId, reason });
    this.log.info(`left guild ${session.guildId} (${reason})`);
  }

  private onSessionLost(session: GuildVoice, reason: string): void {
    this.dropSession(session, reason);
  }

  private onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!guildId) return;
    const session = this.sessions.get(guildId);
    if (!session || session.isClosed) return;
    const selfId = this.client.user.id;
    const userId = newState.id;

    if (userId === selfId) {
      if (newState.channelId === null) {
        session.notifyDisconnected("disconnected from the voice channel");
        return;
      }
      if (newState.channelId !== session.channelId) {
        session.noteMoved(newState.channelId);
        return;
      }
    }
    if (oldState.channelId === session.channelId || newState.channelId === session.channelId) {
      session.sendVoiceState();
    }
  }
}
