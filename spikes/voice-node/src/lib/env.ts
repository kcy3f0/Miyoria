// Loads .env and exposes small typed getters. Import this module FIRST in every
// entry point: debug-level (used by discord-video-stream) reads DEBUG at load time.
import "dotenv/config";

export function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[config] missing ${name} — copy .env.example to .env and fill it in`);
    process.exit(1);
  }
  return v;
}

export function str(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`[config] ${name}=${raw} is not a number`);
    process.exit(1);
  }
  return n;
}

export function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Common Discord target used by all three scripts. */
export function discordTarget() {
  return {
    token: req("DISCORD_SELF_TOKEN"),
    guildId: req("DISCORD_GUILD_ID"),
    channelId: req("DISCORD_VOICE_CHANNEL_ID"),
  };
}
