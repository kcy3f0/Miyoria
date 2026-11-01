// Config comes from the environment (a `.env` next to package.json is loaded if present).
import "dotenv/config";
import { parseLogLevel, type LogLevel } from "./log.js";

export interface Config {
  /** Self-account user token. Never logged. */
  selfToken: string;
  voiceLinkUrl: string;
  voiceLinkToken: string;
  logLevel: LogLevel;
  /** Silence after which a capture stream is closed (ms). */
  silenceMs: number;
  /** Max audio buffered for one playback (seconds of source audio). */
  playbackMaxBufferS: number;
  /** Audio accumulated before a playback starts (ms). */
  playbackPrebufferMs: number;
  /** Max time a playback may sit starved (silence-filled) waiting for Core (ms). */
  playbackMaxStarveMs: number;
}

export class ConfigError extends Error {}

function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(`${name}=${raw} is invalid (expected a number in ${min}..${max})`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const selfToken = str(env, "SELF_TOKEN");
  if (!selfToken) throw new ConfigError("SELF_TOKEN is missing (copy .env.example to .env and fill it in)");
  const voiceLinkUrl = str(env, "VOICE_LINK_URL") ?? "ws://127.0.0.1:7879/voice-link";
  if (!/^wss?:\/\//i.test(voiceLinkUrl)) {
    throw new ConfigError(`VOICE_LINK_URL must start with ws:// or wss:// (got ${voiceLinkUrl})`);
  }
  return {
    selfToken,
    voiceLinkUrl,
    voiceLinkToken: str(env, "VOICE_LINK_TOKEN") ?? "",
    logLevel: parseLogLevel(env["LOG_LEVEL"]),
    silenceMs: num(env, "SILENCE_MS", 400, 100, 5000),
    playbackMaxBufferS: num(env, "PLAYBACK_MAX_BUFFER_S", 60, 1, 600),
    playbackPrebufferMs: num(env, "PLAYBACK_PREBUFFER_MS", 60, 0, 2000),
    playbackMaxStarveMs: num(env, "PLAYBACK_MAX_STARVE_MS", 10_000, 500, 120_000),
  };
}
