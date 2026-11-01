// Spike 1c — Go Live: stream a local video file or an OBS RTMP/SRT feed into the
// voice channel with @dank074/discord-video-stream (WebRTC, H264/H265, DAVE-capable sender).
//
// GOLIVE_VOICE (how the voice-channel session is obtained):
//   dvs    — the library's own Streamer.joinVoice(). NOTE: it always joins with
//            self_deaf=true, so this account cannot hear anyone while streaming.
//   hybrid — @discordjs/voice holds the voice session (selfDeaf=false, receive works),
//            and only the Go Live *stream* connection comes from discord-video-stream,
//            reusing the voice session id. This is the "one node does everything"
//            layout Phase 2 needs; it pokes a private field, so treat it as experimental.
import { bool, discordTarget, num, str } from "./lib/env.js";
import { spawn } from "node:child_process";
import {
  Encoders,
  type EncoderSettingsGetter,
  playStream,
  prepareStream,
  Streamer,
  Utils,
  VoiceConnection as DvsVoiceConnection,
} from "@dank074/discord-video-stream";
import { NetworkingStatusCode, type VoiceConnection, VoiceConnectionStatus } from "@discordjs/voice";
import { daveInfo, joinDjs, loginSelf, onShutdown, resolveTarget } from "./lib/discord.js";
import { log, now } from "./lib/log.js";

const cfg = {
  ...discordTarget(),
  voice: str("GOLIVE_VOICE", "dvs"),
  input: str("GOLIVE_INPUT", "sample.mp4"),
  encoder: str("GOLIVE_ENCODER", "nvenc"),
  nvencPreset: str("GOLIVE_NVENC_PRESET", "p4"),
  codec: str("GOLIVE_CODEC", "H264"),
  height: num("GOLIVE_HEIGHT", 1080),
  fps: num("GOLIVE_FPS", 60),
  bitrate: num("GOLIVE_BITRATE_KBPS", 6000),
  bitrateMax: num("GOLIVE_BITRATE_MAX_KBPS", 8000),
  noTranscode: bool("GOLIVE_NO_TRANSCODE", false),
  hwDecode: bool("GOLIVE_HWACCEL_DECODE", true),
  loop: bool("GOLIVE_LOOP", false),
  gpuMonitor: bool("GOLIVE_GPU_MONITOR", true),
};

const isRtmp = cfg.input.startsWith("rtmp://");
const isLive = isRtmp || cfg.input.startsWith("srt://") || cfg.input.startsWith("udp://");

function makeEncoder(): EncoderSettingsGetter {
  if (cfg.encoder === "nvenc") {
    // h264_nvenc / hevc_nvenc. On a 4070 SUPER the NVENC block is separate from the
    // 3D/CUDA cores, so the game barely notices; OBS uses the same block (session limit
    // is not an issue on current drivers). p1–p3 = lowest latency, p4 = balanced.
    return Encoders.nvenc({
      preset: cfg.nvencPreset as "p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7",
      spatialAq: false,
      temporalAq: false,
    });
  }
  return Encoders.software({
    x264: { preset: "superfast", tune: "zerolatency" },
    x265: { preset: "superfast", tune: "zerolatency" },
  });
}

/** ffmpeg input options for the chosen source. */
function inputOptions(): string[] {
  const opts: string[] = [];
  // ffmpeg acts as the RTMP *server*; point OBS at it (README has the OBS settings).
  if (isRtmp) opts.push("-listen", "1");
  if (cfg.loop && !isLive) opts.push("-stream_loop", "-1");
  return opts;
}

/** Samples GPU util every 2 s: sm% (3D/CUDA), enc% (NVENC), dec% (NVDEC). */
function startGpuMonitor(): () => void {
  if (!cfg.gpuMonitor) return () => {};
  const p = spawn("nvidia-smi", ["dmon", "-s", "u", "-d", "2"], { stdio: ["ignore", "pipe", "ignore"] });
  p.on("error", () => log("gpu", "nvidia-smi not found; skipping GPU sampling"));
  p.stdout.on("data", (b: Buffer) => {
    for (const line of b.toString().split(/\r?\n/)) if (line.trim()) log("gpu", line.trim());
  });
  return () => p.kill();
}

/** Samples this Node process's CPU (the ffmpeg child is separate — see Task Manager). */
function startCpuMonitor(): () => void {
  let last = process.cpuUsage();
  let lastT = now();
  const t = setInterval(() => {
    const cur = process.cpuUsage();
    const dt = (now() - lastT) * 1000; // µs
    const pct = ((cur.user - last.user + cur.system - last.system) / dt) * 100;
    log("cpu", `node process ${pct.toFixed(1)}% of one core, rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`);
    last = cur;
    lastT = now();
  }, 10_000);
  return () => clearInterval(t);
}

function dvsDave(streamer: Streamer): Record<string, unknown> {
  const v = streamer.voiceConnection;
  const s = v?.streamConnection;
  return {
    voiceDaveReady: v ? Boolean(v.daveReady) : null,
    voiceDaveVersion: v?.daveSession?.protocolVersion ?? 0,
    streamDaveReady: s ? Boolean(s.daveReady) : null,
    streamDaveVersion: s?.daveSession?.protocolVersion ?? 0,
  };
}

/** Hybrid: register a never-started dvs VoiceConnection that only carries the djs session id. */
function attachDjsSession(streamer: Streamer, djs: VoiceConnection, guildId: string, channelId: string): void {
  const s = djs.state;
  if (s.status !== VoiceConnectionStatus.Ready) throw new Error("djs connection not ready");
  const ns = s.networking.state;
  if (ns.code !== NetworkingStatusCode.Ready) throw new Error("djs networking not ready");
  const shell = new DvsVoiceConnection(streamer, guildId, streamer.client.user!.id, channelId, () => {});
  // Sets session_id only; without tokens the shell never opens its own voice websocket.
  shell.setSession(ns.connectionOptions.sessionId);
  (streamer as unknown as { _voiceConnection?: DvsVoiceConnection })._voiceConnection = shell;
  log("hybrid", `reusing djs voice session ${ns.connectionOptions.sessionId.slice(0, 8)}… for Go Live`);
}

async function main(): Promise<void> {
  log("main", { ...cfg, isLive });
  const client = await loginSelf(cfg.token);
  const streamer = new Streamer(client);
  let djs: VoiceConnection | undefined;

  if (cfg.voice === "hybrid") {
    const { guild } = await resolveTarget(client, cfg.guildId, cfg.channelId);
    djs = await joinDjs(guild, cfg.channelId, { selfDeaf: false, selfMute: true });
    // Prove receive keeps flowing while we stream.
    djs.receiver.speaking.on("start", (id) => id !== client.user.id && log("speak", `START ${id}`));
    djs.receiver.speaking.on("end", (id) => id !== client.user.id && log("speak", `STOP  ${id}`));
    attachDjsSession(streamer, djs, cfg.guildId, cfg.channelId);
  } else {
    await streamer.joinVoice(cfg.guildId, cfg.channelId);
    log("voice", "dvs voice connected (self-deafened by the library)", dvsDave(streamer));
  }

  const abort = new AbortController();
  const stopGpu = startGpuMonitor();
  const stopCpu = startCpuMonitor();
  onShutdown(() => {
    abort.abort();
    stopGpu();
    stopCpu();
    streamer.stopStream();
    if (djs) djs.destroy();
    else streamer.leaveVoice();
    client.destroy();
  });

  const { command, output } = prepareStream(
    cfg.input,
    {
      encoder: makeEncoder(),
      noTranscoding: cfg.noTranscode,
      height: cfg.height,
      frameRate: cfg.fps,
      bitrateVideo: cfg.bitrate,
      bitrateVideoMax: cfg.bitrateMax,
      videoCodec: Utils.normalizeVideoCodec(cfg.codec),
      includeAudio: true,
      hardwareAcceleratedDecoding: cfg.hwDecode,
      minimizeLatency: isLive,
      customInputOptions: inputOptions(),
      logLevel: "warning",
    },
    abort.signal,
  );
  command.on("start", (cmd) => log("ffmpeg", cmd));
  command.on("error", (err, _stdout, stderr) => {
    if (!abort.signal.aborted) log("ffmpeg:error", err.shortMessage ?? err.message, stderr.slice(-2000));
  });
  let lastProgress = 0;
  command.on("progress", (p) => {
    if (now() - lastProgress < 5000) return;
    lastProgress = now();
    log("ffmpeg", `fps=${p.currentFps} kbps=${p.currentKbps} t=${p.timemark.toFixed(1)}s frames=${p.frames}`);
  });

  if (isRtmp) log("main", `waiting for OBS to push to ${cfg.input} …`);
  const t0 = now();
  const statusTimer = setInterval(() => log("dave", dvsDave(streamer), djs ? daveInfo(djs) : {}), 15_000);
  // playStream creates the Go Live stream connection, demuxes ffmpeg's NUT output and paces it.
  const done = playStream(output, streamer, { type: "go-live" }, abort.signal);
  // createStream() resolves inside playStream; poll briefly for the stream connection to report DAVE.
  setTimeout(() => log("golive", `~${Math.round(now() - t0)}ms after start`, dvsDave(streamer)), 5000);
  try {
    await done;
    log("golive", "finished");
  } catch (e) {
    if (!abort.signal.aborted) log("golive", "error", e);
  } finally {
    clearInterval(statusTimer);
    stopGpu();
    stopCpu();
    streamer.stopStream();
    if (djs) djs.destroy();
    else streamer.leaveVoice();
    client.destroy();
    process.exit(0);
  }
}

main().catch((e) => {
  log("main", "fatal", e);
  process.exit(1);
});
