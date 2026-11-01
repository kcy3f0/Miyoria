// Spike 1b — play a local audio file into the voice channel (simulates TTS output).
// Measures local start-up latency (play() -> first Opus frame ready) for:
//   ffmpeg — file path handed to the library, which spawns ffmpeg + Opus encoder
//   raw    — file pre-decoded to 48k stereo s16le in memory, fed as StreamType.Raw
//            (closest to the production path where TTS streams PCM directly)
import { discordTarget, num, str } from "./lib/env.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  StreamType,
} from "@discordjs/voice";
import { daveInfo, joinDjs, loginSelf, onShutdown, resolveTarget } from "./lib/discord.js";
import { log, now } from "./lib/log.js";

const cfg = {
  ...discordTarget(),
  backend: str("PLAY_BACKEND", "djs"),
  file: str("PLAY_FILE", "sample.wav"),
  repeat: Math.max(1, num("PLAY_REPEAT", 3)),
  modes: str("PLAY_MODES", "ffmpeg,raw").split(",").map((s) => s.trim()),
  ffmpeg: str("FFMPEG_PATH", "ffmpeg"),
};

// Set as soon as we are connected, so Ctrl+C mid-playback still leaves the channel.
let cleanup: () => void = () => {};

/** Decode any audio file to 48 kHz stereo s16le with the system ffmpeg. */
function decodeToPcm(file: string): Buffer {
  const r = spawnSync(
    cfg.ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString()}`);
  return r.stdout;
}

async function runDjs(): Promise<void> {
  const client = await loginSelf(cfg.token);
  const { guild } = await resolveTarget(client, cfg.guildId, cfg.channelId);
  const connection = await joinDjs(guild, cfg.channelId, { selfDeaf: true, selfMute: false });
  cleanup = () => {
    connection.destroy();
    client.destroy();
  };
  const player = createAudioPlayer();
  connection.subscribe(player);
  player.on("error", (e) => log("player:error", e.message));
  player.on("stateChange", (o, n) => log("player", `${o.status} -> ${n.status}`));

  const pcm = cfg.modes.includes("raw") ? decodeToPcm(cfg.file) : undefined;
  if (pcm) log("play", `pre-decoded ${(pcm.length / 4 / 48_000).toFixed(2)}s of PCM`);

  // Give the DAVE MLS handshake a moment; sending before it's ready goes out unencrypted/dropped.
  await new Promise((r) => setTimeout(r, 2000));
  log("dave", daveInfo(connection));

  for (let i = 1; i <= cfg.repeat; i++) {
    for (const mode of cfg.modes) {
      const t0 = now();
      const resource =
        mode === "raw" && pcm
          ? createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw })
          : createAudioResource(cfg.file); // string input => library spawns ffmpeg
      player.play(resource);
      await entersState(player, AudioPlayerStatus.Playing, 15_000);
      const startup = now() - t0;
      await entersState(player, AudioPlayerStatus.Idle, 10 * 60_000);
      log("result", { run: i, mode, startupMs: Math.round(startup), totalMs: Math.round(now() - t0) });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  log("main", "done", daveInfo(connection));
}

// Control group: the selfbot library's own (non-DAVE) voice stack.
async function runSelfbot(): Promise<void> {
  const client = await loginSelf(cfg.token);
  const { channel } = await resolveTarget(client, cfg.guildId, cfg.channelId);
  const conn = await client.voice.joinChannel(channel, { selfMute: false, selfDeaf: true });
  cleanup = () => {
    conn.disconnect();
    client.destroy();
  };
  conn.on("error", (e) => log("voice:error", e));
  conn.on("disconnect", (e) => log("voice:disconnect", e));
  for (let i = 1; i <= cfg.repeat; i++) {
    const t0 = now();
    const dispatcher = conn.playAudio(cfg.file);
    await new Promise<void>((resolve, reject) => {
      dispatcher.once("start", () => log("result", { run: i, mode: "selfbot", startupMs: Math.round(now() - t0) }));
      dispatcher.once("finish", () => resolve());
      dispatcher.once("error", reject);
    });
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main(): Promise<void> {
  if (!existsSync(cfg.file)) throw new Error(`PLAY_FILE not found: ${cfg.file}`);
  log("main", `backend=${cfg.backend} file=${cfg.file} repeat=${cfg.repeat} modes=${cfg.modes.join(",")}`);
  onShutdown(() => cleanup());
  await (cfg.backend === "selfbot" ? runSelfbot() : runDjs());
  cleanup();
  process.exit(0);
}

main().catch((e) => {
  log("main", "fatal", e);
  process.exit(1);
});
