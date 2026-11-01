// Module ids the core knows about, in boot order (legacy `boot.rs` `MODULES`). Kept free of
// imports so the CLI can list configured modules without loading any module package.

import type { Config } from "@miyoria/kernel";

/** Every module the core knows about, for `miyoria module list`. */
export const MODULE_IDS: readonly string[] = [
  "llm",
  "speech",
  "voice.link",
  "voice",
  "scheduler",
  "agent",
  "commands",
  "auth",
  "social",
  "mood",
  "memory",
  "initiative",
  "queue",
  "game",
  "mcp",
  "stage.link",
  "extensions",
  "platform.discord.bot",
  "recorder",
  "api",
];

/** Modules that cannot run without `token` in their section; an empty token disables them. */
export const NEEDS_TOKEN: readonly string[] = [
  "platform.discord.bot",
  "api",
  "voice.link",
  "stage.link",
];

/** `(id, enabled)` of every known module as the config file says. */
export function configuredModules(config: Config): Array<[string, boolean]> {
  return MODULE_IDS.map((id) => [id, config.module(id).enabled]);
}
