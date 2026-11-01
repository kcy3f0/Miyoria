// Agent commands (`mode`, `activeness`, `persona show`, `voice mode`), registered in the
// `commands` module's registry when it is available.
//
// The voice module registers the other `voice` commands (`join`, `leave`, `voice consent`).

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  CommandRegistryKey,
  CommandReply,
  commandSpec,
  type Invocation,
} from "@miyoria/commands";
import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import type { ContextKey } from "@miyoria/types";
import { type Activeness, type ChannelMode, parseActiveness, parseChannelMode } from "./config.js";
import type { AgentHandle } from "./handle.js";
import type { PersonaHandle } from "./persona.js";
import { charCount } from "./util.js";

const log = getLogger("agent.commands");

export const PATHS = ["mode", "activeness", "persona show", "voice mode"] as const;
const NOT_SAVED = "\n(不過沒存起來……重開之後我就會忘記喔。)";
const NOT_IN_VOICE = "我現在又沒有在這個伺服器的語音頻道裡……先叫我進語音啦。";
const MODE_CHOICES = ["off", "mention-only", "ambient", "always", "reset"];

/**
 * Remembers which registry the commands went into, so they can be removed on stop and
 * re-registered when the `commands` module restarts.
 */
export class AgentCommands {
  #installed: CommandRegistry | null = null;

  /** Registers the commands in the current `CommandRegistry` service, if any. */
  install(services: ServiceLookup, handle: AgentHandle, persona: PersonaHandle): void {
    const registry = services.get(CommandRegistryKey);
    if (!registry) {
      log.debug("no command registry, agent commands not registered");
      return;
    }
    if (this.#installed === registry) return;
    if (this.#installed) unregister(this.#installed);
    this.#installed = null;
    try {
      register(registry, handle, persona);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not register agent commands");
      unregister(registry);
      return;
    }
    // Shares the `voice` group with the voice module; a conflict there must not cost the other
    // commands.
    try {
      registerVoice(registry, handle);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not register `voice mode`");
    }
    this.#installed = registry;
  }

  uninstall(): void {
    if (this.#installed) unregister(this.#installed);
    this.#installed = null;
  }
}

function unregister(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}

function register(registry: CommandRegistry, handle: AgentHandle, persona: PersonaHandle): void {
  registry.register(
    commandSpec("mode", "查看或設定這個頻道的聊天模式", {
      args: [
        argSpec(
          "mode",
          "off / mention-only / ambient / always / reset(恢復預設)",
          ArgKind.choice(MODE_CHOICES),
          { required: false },
        ),
      ],
      permission: "admin.channel.mode",
    }),
    (inv) => mode(handle, inv),
  );

  registry.register(
    commandSpec("activeness", "查看或設定我在這個頻道主動插話的程度", {
      args: [
        argSpec(
          "level",
          "low / medium / high / reset(恢復預設)",
          ArgKind.choice(["low", "medium", "high", "reset"]),
          { required: false },
        ),
      ],
      permission: "admin.channel.activeness",
    }),
    (inv) => activeness(handle, inv),
  );

  registry.setGroupDescription("persona", "人格設定");
  registry.register(
    commandSpec("persona show", "列出人格段落與字數", {
      permission: "admin.persona.view",
      ephemeral: true,
    }),
    () => CommandReply.ephemeral(personaSummary(persona)),
  );
}

function registerVoice(registry: CommandRegistry, handle: AgentHandle): void {
  if (registry.groupDescription(["voice"]) === undefined) {
    registry.setGroupDescription("voice", "語音");
  }
  registry.register(
    commandSpec("voice mode", "查看或設定我在這個伺服器語音頻道裡的聊天模式", {
      args: [
        argSpec(
          "mode",
          "off / mention-only / ambient / always / reset(恢復預設)",
          ArgKind.choice(MODE_CHOICES),
          { required: false },
        ),
      ],
      permission: "admin.voice.mode",
    }),
    (inv) => voiceMode(handle, inv),
  );
}

export function modeLabel(mode: ChannelMode): string {
  switch (mode) {
    case "off":
      return "完全不說話";
    case "mention-only":
      return "被叫到才回";
    case "ambient":
      return "會自己插話";
    case "always":
      return "每句都回";
  }
}

export function activenessLabel(level: Activeness): string {
  switch (level) {
    case "low":
      return "低";
    case "medium":
      return "普通";
    case "high":
      return "高";
  }
}

function tryParse<T>(parse: (s: string) => T, value: string): T | null {
  try {
    return parse(value);
  } catch {
    return null;
  }
}

/** `null` when saved, else the error. */
async function save(op: Promise<void>): Promise<unknown> {
  try {
    await op;
    return null;
  } catch (error) {
    return error ?? new Error("unknown error");
  }
}

function withSaveNote(text: string, saved: unknown): string {
  if (saved === null) return text;
  log.warn({ error: errorMessage(saved) }, "could not persist agent setting");
  return text + NOT_SAVED;
}

async function mode(handle: AgentHandle, inv: Invocation): Promise<CommandReply> {
  const ctx = inv.context;
  const value = inv.str("mode");
  let reply: string;
  if (value === null) {
    const current = handle.channelMode(ctx);
    const source = handle.channelModeOverride(ctx) !== null ? "有人特別設定的" : "預設";
    reply = `這裡現在是 \`${current}\`(${modeLabel(current)}),${source}。`;
  } else if (value === "reset") {
    const saved = await save(handle.setChannelMode(ctx, null));
    const current = handle.channelMode(ctx);
    reply = withSaveNote(`好啦,恢復成預設的 \`${current}\`(${modeLabel(current)})了。`, saved);
  } else {
    const parsed = tryParse(parseChannelMode, value);
    if (parsed === null) {
      reply = `\`${value}\` 是什麼模式啦?`;
    } else {
      const saved = await save(handle.setChannelMode(ctx, parsed));
      const line =
        parsed === "off"
          ? "……好啦,我在這裡閉嘴就是了。哼。"
          : `知道了,這裡改成 \`${parsed}\`(${modeLabel(parsed)})。才不是因為你叫我才改的喔。`;
      reply = withSaveNote(line, saved);
    }
  }
  return CommandReply.public(reply);
}

/** `voice mode`: the mode of the voice channel she is in, in the guild the command came from. */
async function voiceMode(handle: AgentHandle, inv: Invocation): Promise<CommandReply> {
  const guild = inv.context.scope;
  const ctx: ContextKey | null =
    guild === null ? null : handle.voiceContext(inv.context.platform, guild);
  if (ctx === null) return CommandReply.ephemeral(NOT_IN_VOICE);
  const value = inv.str("mode");
  let reply: string;
  if (value === null) {
    const current = handle.channelMode(ctx);
    const source = handle.channelModeOverride(ctx) !== null ? "有人特別設定的" : "預設";
    reply = `我在語音裡現在是 \`${current}\`(${modeLabel(current)}),${source}。`;
  } else if (value === "reset") {
    const saved = await save(handle.setChannelMode(ctx, null));
    const current = handle.channelMode(ctx);
    reply = withSaveNote(`好啦,語音恢復成預設的 \`${current}\`(${modeLabel(current)})了。`, saved);
  } else {
    const parsed = tryParse(parseChannelMode, value);
    if (parsed === null) {
      reply = `\`${value}\` 是什麼模式啦?`;
    } else {
      const saved = await save(handle.setChannelMode(ctx, parsed));
      const line =
        parsed === "off"
          ? "……好啦,我在語音裡只聽不說就是了。哼。"
          : `知道了,語音裡改成 \`${parsed}\`(${modeLabel(parsed)})。才不是因為你叫我才改的喔。`;
      reply = withSaveNote(line, saved);
    }
  }
  return CommandReply.public(reply);
}

async function activeness(handle: AgentHandle, inv: Invocation): Promise<CommandReply> {
  const ctx = inv.context;
  const value = inv.str("level");
  let reply: string;
  if (value === null) {
    const current = handle.activeness(ctx);
    const source = handle.activenessOverride(ctx) !== null ? "有人特別設定的" : "預設";
    reply = `我在這裡的主動程度是 \`${current}\`(${activenessLabel(current)}),${source}。`;
  } else if (value === "reset") {
    const saved = await save(handle.setActiveness(ctx, null));
    const current = handle.activeness(ctx);
    reply = withSaveNote(
      `好啦,恢復成預設的 \`${current}\`(${activenessLabel(current)})了。`,
      saved,
    );
  } else {
    const parsed = tryParse(parseActiveness, value);
    if (parsed === null) {
      reply = `\`${value}\` 是什麼程度啦?`;
    } else {
      const saved = await save(handle.setActiveness(ctx, parsed));
      const line =
        parsed === "low"
          ? "好啦,我少講一點。反正我也沒很想跟你們聊。"
          : parsed === "medium"
            ? "知道了,照平常那樣。"
            : "要我多說話?哼……既然你們這麼想聽,那就勉強陪你們吧。";
      reply = withSaveNote(line, saved);
    }
  }
  return CommandReply.public(reply);
}

export function personaSummary(persona: PersonaHandle): string {
  return persona.read((p) => {
    let out = `\`${p.id}\` 的人格段落:`;
    if (p.sections.length === 0) out += "\n(沒有)";
    for (const s of p.sections) out += `\n\`${s.key}\`:${charCount(s.body)} 字`;
    if (p.examples.length > 0) out += `\n範例對話:${p.examples.length} 則`;
    return out;
  });
}
