// Shared Discord plumbing: self-account login and @discordjs/voice joining via the
// selfbot library's `guild.voiceAdapterCreator` (the selfbot lib explicitly wires
// VOICE_STATE_UPDATE / VOICE_SERVER_UPDATE into @discordjs/voice adapters).
import {
  type DiscordGatewayAdapterCreator,
  entersState,
  joinVoiceChannel,
  NetworkingStatusCode,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { Client, type Guild, type VoiceBasedChannel } from "@lng2004/discord.js-selfbot-v13";
import { bool } from "./env.js";
import { log } from "./log.js";

export async function loginSelf(token: string): Promise<Client<true>> {
  const client = new Client();
  const ready = new Promise<void>((resolve) => client.once("ready", () => resolve()));
  await client.login(token);
  await ready;
  log("gateway", `logged in as ${client.user?.tag} (${client.user?.id})`);
  return client as Client<true>;
}

export async function resolveTarget(
  client: Client<true>,
  guildId: string,
  channelId: string,
): Promise<{ guild: Guild; channel: VoiceBasedChannel }> {
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
  const channel = await client.channels.fetch(channelId);
  if (!channel || !("bitrate" in channel)) {
    throw new Error(`channel ${channelId} is not a guild voice channel`);
  }
  return { guild, channel: channel as VoiceBasedChannel };
}

// Lines from @discordjs/voice debug output that are relevant to DAVE / transport crypto.
const DAVE_RE = /dave|mls|transition|e2ee|epoch|privacy|encrypt|decrypt|protocol|select/i;

/** Join with @discordjs/voice (DAVE-capable) and wait until Ready. */
export async function joinDjs(
  guild: Guild,
  channelId: string,
  opts: { selfDeaf: boolean; selfMute: boolean },
): Promise<VoiceConnection> {
  const verbose = bool("VOICE_DEBUG", false);
  const connection = joinVoiceChannel({
    guildId: guild.id,
    channelId,
    // Structurally identical to discord.js's adapter; only the nominal types differ.
    adapterCreator: guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
    selfDeaf: opts.selfDeaf,
    selfMute: opts.selfMute,
    daveEncryption: true, // advertise max_dave_protocol_version (default true; explicit for the spike)
    debug: true,
  });

  connection.on("debug", (m) => {
    if (verbose || DAVE_RE.test(m)) log("voice:debug", m);
  });
  connection.on("error", (e) => log("voice:error", e));
  connection.on("stateChange", (o, n) => log("voice", `state ${o.status} -> ${n.status}`));
  connection.on("transitioned", (id) => {
    log("dave", `transitioned (id ${id})`, daveInfo(connection));
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  log("voice", "ready", daveInfo(connection));
  return connection;
}

/** Everything @discordjs/voice exposes about the negotiated encryption. */
export function daveInfo(connection: VoiceConnection): Record<string, unknown> {
  const s = connection.state;
  if (s.status !== VoiceConnectionStatus.Ready) return { status: s.status };
  const ns = s.networking.state;
  if (ns.code !== NetworkingStatusCode.Ready && ns.code !== NetworkingStatusCode.Resuming) {
    return { networking: NetworkingStatusCode[ns.code] };
  }
  return {
    transportEncryption: ns.connectionData.encryptionMode,
    // 0 = no E2EE (passthrough); >= 1 = DAVE protocol version in use
    daveProtocolVersion: ns.dave?.protocolVersion ?? 0,
    daveSessionReady: ns.dave?.session?.ready ?? false,
    voicePrivacyCode: connection.voicePrivacyCode ?? null,
    connectedClients: [...ns.connectionData.connectedClients],
  };
}

/** Ctrl+C handler that runs cleanup once, then exits. */
export function onShutdown(cleanup: () => void | Promise<void>): void {
  let done = false;
  const handler = async () => {
    if (done) return;
    done = true;
    log("main", "shutting down…");
    try {
      await cleanup();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}
