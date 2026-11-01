// Spike 1a — per-user voice receive.
// Joins a voice channel with the self account and writes one WAV per utterance per
// speaker: {RECORDINGS_DIR}/{userId}_{timestamp}.wav (+ index.jsonl with metadata).
//
// Backends (RECEIVE_BACKEND):
//   djs     — @discordjs/voice 0.19 (DAVE via @snazzah/davey) driven through the
//             selfbot client's guild.voiceAdapterCreator. Expected to work under DAVE.
//   selfbot — discord.js-selfbot-v13's built-in voice stack (transport crypto only,
//             no DAVE code at all). Control group: shows what happens without DAVE.
import { bool, discordTarget, num, str } from "./lib/env.js";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import type { Client, User } from "@lng2004/discord.js-selfbot-v13";
import OpusScript from "opusscript";
import { daveInfo, joinDjs, loginSelf, onShutdown, resolveTarget } from "./lib/discord.js";
import { fileStamp, log, now } from "./lib/log.js";
import { stereoToMono, writeWav } from "./lib/wav.js";

const SAMPLE_RATE = 48_000;
const cfg = {
  ...discordTarget(),
  backend: str("RECEIVE_BACKEND", "djs"),
  dir: str("RECORDINGS_DIR", "recordings"),
  silenceMs: num("RECEIVE_SILENCE_MS", 800),
  channels: num("RECEIVE_CHANNELS", 1) === 2 ? 2 : 1,
  minMs: num("RECEIVE_MIN_MS", 300),
  verbose: bool("VOICE_DEBUG", false),
};

/** One in-progress utterance of one speaker. PCM is always stereo s16le @ 48k here. */
interface Utterance {
  userId: string;
  startedAt: Date;
  t0: number; // speaking-start (ms, perf clock)
  tFirstPacket?: number;
  packets: number;
  decodeErrors: number;
  pcm: Buffer[];
}

const active = new Map<string, Utterance>();
let client: Client<true>;

function displayName(userId: string): string {
  const u = client.users.cache.get(userId);
  return u ? `${u.username}` : "?";
}

function begin(userId: string): Utterance {
  const u: Utterance = { userId, startedAt: new Date(), t0: now(), packets: 0, decodeErrors: 0, pcm: [] };
  active.set(userId, u);
  return u;
}

async function finish(u: Utterance): Promise<void> {
  active.delete(u.userId);
  const stereo = Buffer.concat(u.pcm);
  const durMs = (stereo.length / 4 / SAMPLE_RATE) * 1000;
  const meta = {
    userId: u.userId,
    user: displayName(u.userId),
    startedAt: u.startedAt.toISOString(),
    durationMs: Math.round(durMs),
    wallMs: Math.round(now() - u.t0),
    firstPacketMs: u.tFirstPacket === undefined ? null : Math.round(u.tFirstPacket - u.t0),
    packets: u.packets,
    decodeErrors: u.decodeErrors,
    backend: cfg.backend,
    file: null as string | null,
  };
  if (durMs < cfg.minMs) {
    log("utter", `drop ${u.userId} (${meta.durationMs}ms < ${cfg.minMs}ms)`, meta);
    return;
  }
  const file = `${u.userId}_${fileStamp(u.startedAt)}.wav`;
  const pcm = cfg.channels === 1 ? stereoToMono(stereo) : stereo;
  await writeWav(join(cfg.dir, file), pcm, SAMPLE_RATE, cfg.channels);
  meta.file = file;
  await appendFile(join(cfg.dir, "index.jsonl"), `${JSON.stringify(meta)}\n`);
  log("utter", `saved ${file}`, meta);
}

// ── Backend: @discordjs/voice (DAVE) ─────────────────────────────────────────
async function runDjs(): Promise<() => void> {
  const { guild } = await resolveTarget(client, cfg.guildId, cfg.channelId);
  // selfDeaf MUST be false, otherwise Discord sends us no audio at all.
  const connection: VoiceConnection = await joinDjs(guild, cfg.channelId, { selfDeaf: false, selfMute: true });
  const { receiver } = connection;

  receiver.ssrcMap.on("create", (d) => log("ssrc", `user ${d.userId} (${displayName(d.userId)}) -> audio ssrc ${d.audioSSRC}`));

  receiver.speaking.on("start", (userId) => {
    if (userId === client.user.id) return;
    log("speak", `START ${userId} (${displayName(userId)})`);
    if (active.has(userId)) return; // previous utterance still open (within RECEIVE_SILENCE_MS)

    const u = begin(userId);
    // One Opus decoder per stream: decoder state must not be shared across users.
    const decoder = new OpusScript(SAMPLE_RATE, 2, OpusScript.Application.AUDIO);
    const stream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: cfg.silenceMs },
    });
    stream.on("data", (opus: Buffer) => {
      u.tFirstPacket ??= now();
      u.packets++;
      try {
        // Buffer.from copies out of the WASM heap before the next decode reuses it.
        u.pcm.push(Buffer.from(decoder.decode(opus)));
      } catch {
        // If DAVE decryption silently failed, payloads are ciphertext -> Opus errors here.
        u.decodeErrors++;
      }
    });
    stream.once("end", () => {
      decoder.delete();
      void finish(u);
    });
    stream.once("error", (e) => log("speak", `stream error ${userId}`, e));
  });
  receiver.speaking.on("end", (userId) => {
    if (userId !== client.user.id) log("speak", `STOP  ${userId} (${displayName(userId)})`);
  });

  const timer = setInterval(() => log("status", daveInfo(connection), { speaking: [...active.keys()] }), 30_000);
  return () => {
    clearInterval(timer);
    connection.destroy();
  };
}

// ── Backend: discord.js-selfbot-v13 built-in voice (no DAVE) ────────────────
async function runSelfbot(): Promise<() => void> {
  const { channel } = await resolveTarget(client, cfg.guildId, cfg.channelId);
  const conn = await client.voice.joinChannel(channel, { selfMute: true, selfDeaf: false });
  log("voice", `selfbot voice connected (status ${conn.status}); this stack has no DAVE support`);
  conn.on("debug", (m) => {
    if (cfg.verbose || /mode|encrypt|close|4017|dave|e2ee/i.test(m)) log("voice:debug", m);
  });
  conn.on("error", (e) => log("voice:error", e));
  conn.on("failed", (e) => log("voice:failed", e));
  conn.on("disconnect", (e) => log("voice:disconnect", e));
  conn.receiver.on("debug", (e) => log("receiver:debug", e));

  conn.on("speaking", (user: User | undefined, speaking) => {
    if (!user || user.id === client.user.id) return;
    const on = speaking.has("SPEAKING");
    log("speak", `${on ? "START" : "STOP "} ${user.id} (${user.username})`);
    if (!on || active.has(user.id)) return;

    const u = begin(user.id);
    // mode 'pcm' = prism-media Opus decoder -> stereo s16le 48k; ends ~250ms after last packet.
    const pcm = conn.receiver.createStream(user, { mode: "pcm", end: "silence" });
    pcm.on("data", (chunk: Buffer) => {
      u.tFirstPacket ??= now();
      u.packets++;
      u.pcm.push(chunk);
    });
    pcm.on("error", (e) => {
      u.decodeErrors++;
      log("speak", `pcm error ${user.id}`, e);
    });
    pcm.once("end", () => void finish(u));
  });

  return () => conn.disconnect();
}

async function main(): Promise<void> {
  await mkdir(cfg.dir, { recursive: true });
  client = await loginSelf(cfg.token);
  log("main", `backend=${cfg.backend} silence=${cfg.silenceMs}ms channels=${cfg.channels} -> ${cfg.dir}/`);
  const stop = cfg.backend === "selfbot" ? await runSelfbot() : await runDjs();
  log("main", "listening — talk in the channel (several people at once is the interesting case). Ctrl+C to stop.");

  onShutdown(async () => {
    // Flush whatever is still open so a Ctrl+C mid-sentence still yields a file.
    await Promise.all([...active.values()].map((u) => finish(u)));
    stop();
    client.destroy();
  });
}

main().catch((e) => {
  log("main", "fatal", e);
  process.exit(1);
});
