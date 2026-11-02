// Agent commands: `/channel mode`, `/channel activeness`, `/voice mode` and
// `/admin persona show`, registered in the `commands` module's registry when it is available.
//
// Settings are shown with a view node (`channel.mode.view`, ...) and changed with a separate
// one (`admin.channel.mode`, ...): the command's node lets you look, changing (the argument or
// the select on the card) also needs the change node.
//
// The voice module registers the other `voice` commands (`join`, `leave`, `consent`, `golive`).

import {
  ArgKind,
  argSpec,
  type CardBlock,
  type CommandRegistry,
  CommandRegistryKey,
  type CommandReply,
  type ComponentInvocation,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  type Invocation,
  notice,
} from "@miyoria/commands";
import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import type { ContextKey } from "@miyoria/types";
import { type Activeness, type ChannelMode, parseActiveness, parseChannelMode } from "./config.js";
import type { AgentHandle } from "./handle.js";
import type { PersonaHandle } from "./persona.js";
import { charCount } from "./util.js";

const log = getLogger("agent.commands");

export const PATHS = [
  "channel mode",
  "channel activeness",
  "admin persona show",
  "voice mode",
] as const;
const NOT_SAVED = "設定沒有寫入資料庫，重新啟動後會恢復原狀。";
const MODES: readonly ChannelMode[] = ["off", "mention-only", "ambient", "always"];
const LEVELS: readonly Activeness[] = ["low", "medium", "high"];
const MODE_CHOICES = [...MODES, "reset"];

const NODES = {
  modeView: "channel.mode.view",
  modeSet: "admin.channel.mode",
  activenessView: "channel.activeness.view",
  activenessSet: "admin.channel.activeness",
  voiceView: "voice.mode.view",
  voiceSet: "admin.voice.mode",
} as const;

const R = {
  mode: "channel:mode:set",
  activeness: "channel:activeness:set",
  voice: "voice:mode:set",
} as const;

/**
 * Remembers which registry the commands went into, so they can be removed on stop and
 * re-registered when the `commands` module provides a different registry.
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

export function modeLabel(mode: ChannelMode): string {
  switch (mode) {
    case "off":
      return "不說話";
    case "mention-only":
      return "被提及才回覆";
    case "ambient":
      return "會主動加入對話";
    case "always":
      return "每則訊息都回覆";
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

function cannotChange(node: string): CommandReply {
  return notice("error", "你沒有變更這項設定的權限。", `需要權限：${node}`);
}

/** One setting: how to read, label and write it in a context. */
interface Setting<T extends string> {
  title: string;
  /** e.g. "這個頻道的聊天模式". */
  subject: string;
  values: readonly T[];
  label: (value: T) => string;
  parse: (raw: string) => T;
  current: (ctx: ContextKey) => T;
  override: (ctx: ContextKey) => T | null;
  set: (ctx: ContextKey, value: T | null) => Promise<void>;
  setNode: string;
  route: string;
}

function settingCard<T extends string>(
  s: Setting<T>,
  ctx: ContextKey,
  note: string | null = null,
): CommandReply {
  const current = s.current(ctx);
  const source = s.override(ctx) !== null ? "（已自訂）" : "（預設）";
  const blocks: CardBlock[] = [
    { type: "text", text: `${s.subject}：\`${current}\` ${s.label(current)}${source}` },
  ];
  if (note) blocks.push({ type: "muted", text: note });
  blocks.push({
    type: "select",
    select: {
      id: componentId(s.route),
      placeholder: "變更設定…",
      options: [
        ...s.values.map((v) => ({
          label: `${v}（${s.label(v)}）`,
          value: v,
          default: v === current,
        })),
        { label: "恢復預設", value: "reset" },
      ],
    },
  });
  return cardReply(blocks, { title: s.title, accent: "neutral", session: {} });
}

async function change<T extends string>(
  s: Setting<T>,
  ctx: ContextKey,
  raw: string,
): Promise<CommandReply> {
  let value: T | null = null;
  if (raw !== "reset") {
    value = tryParse(s.parse, raw);
    if (value === null) return notice("warn", `不認得的設定值 \`${raw}\`。`);
  }
  const saved = await save(s.set(ctx, value));
  if (saved !== null) log.warn({ error: errorMessage(saved) }, "could not persist agent setting");
  const current = s.current(ctx);
  const text =
    value === null
      ? `已將${s.subject}恢復為預設：\`${current}\` ${s.label(current)}。`
      : `已將${s.subject}設為 \`${current}\` ${s.label(current)}。`;
  return notice("success", text, saved === null ? null : NOT_SAVED);
}

/** The command handler: show the card, or change the value when an argument was given. */
function settingCommand<T extends string>(
  setting: (inv: Invocation) => { s: Setting<T>; ctx: ContextKey } | CommandReply,
  arg: string,
) {
  return async (inv: Invocation): Promise<CommandReply> => {
    const found = setting(inv);
    if ("text" in found) return found;
    const { s, ctx } = found;
    const raw = inv.str(arg);
    if (raw === null) return settingCard(s, ctx);
    if (!(await inv.allowed(s.setNode))) return cannotChange(s.setNode);
    return change(s, ctx, raw);
  };
}

/** The select on the card: changes the value and shows the updated card. */
function settingRoute<T extends string>(
  route: string,
  setNode: string,
  setting: (inv: Invocation) => { s: Setting<T>; ctx: ContextKey } | CommandReply,
) {
  return {
    route,
    permission: setNode,
    handle: async (inv: ComponentInvocation): Promise<ComponentResult> => {
      const found = setting(inv);
      if ("text" in found) return ComponentResult.reply(found);
      const raw = inv.values[0];
      if (raw === undefined) return ComponentResult.update(settingCard(found.s, found.ctx));
      const result = await change(found.s, found.ctx, raw);
      if (result.tone === "warn" || result.tone === "error") return ComponentResult.reply(result);
      return ComponentResult.update(settingCard(found.s, found.ctx, result.text));
    },
  };
}

function register(registry: CommandRegistry, handle: AgentHandle, persona: PersonaHandle): void {
  const modeSetting = (title: string, subject: string, setNode: string, route: string) =>
    ({
      title,
      subject,
      values: MODES,
      label: modeLabel,
      parse: parseChannelMode,
      current: (ctx) => handle.channelMode(ctx),
      override: (ctx) => handle.channelModeOverride(ctx),
      set: (ctx, value) => handle.setChannelMode(ctx, value),
      setNode,
      route,
    }) satisfies Setting<ChannelMode>;

  const channelMode = modeSetting("聊天模式", "她在這個頻道的聊天模式", NODES.modeSet, R.mode);
  const activeness: Setting<Activeness> = {
    title: "主動程度",
    subject: "她在這個頻道主動發話的程度",
    values: LEVELS,
    label: activenessLabel,
    parse: parseActiveness,
    current: (ctx) => handle.activeness(ctx),
    override: (ctx) => handle.activenessOverride(ctx),
    set: (ctx, value) => handle.setActiveness(ctx, value),
    setNode: NODES.activenessSet,
    route: R.activeness,
  };
  const voiceMode = modeSetting("語音模式", "她在語音頻道的聊天模式", NODES.voiceSet, R.voice);

  const here =
    <T extends string>(s: Setting<T>) =>
    (inv: Invocation) => ({ s, ctx: inv.context });
  const inVoice = (inv: Invocation) => {
    const guild = inv.context.scope;
    const ctx = guild === null ? null : handle.voiceContext(inv.context.platform, guild);
    if (ctx === null) {
      return notice("warn", "她目前不在這個伺服器的語音頻道中。", "請先使用 /voice join。");
    }
    return { s: voiceMode, ctx };
  };

  registry.register(
    commandSpec("channel mode", "查看或設定她在這個頻道的聊天模式", {
      args: [
        argSpec(
          "mode",
          "off / mention-only / ambient / always / reset（恢復預設）",
          ArgKind.choice(MODE_CHOICES),
          {
            required: false,
          },
        ),
      ],
      permission: NODES.modeView,
      ephemeral: true,
    }),
    settingCommand(here(channelMode), "mode"),
    { components: [settingRoute(R.mode, NODES.modeSet, here(channelMode))] },
  );

  registry.register(
    commandSpec("channel activeness", "查看或設定她在這個頻道主動發話的程度", {
      args: [
        argSpec(
          "level",
          "low / medium / high / reset（恢復預設）",
          ArgKind.choice([...LEVELS, "reset"]),
          { required: false },
        ),
      ],
      permission: NODES.activenessView,
      ephemeral: true,
    }),
    settingCommand(here(activeness), "level"),
    { components: [settingRoute(R.activeness, NODES.activenessSet, here(activeness))] },
  );

  registry.register(
    commandSpec("voice mode", "查看或設定她在語音頻道的聊天模式", {
      args: [
        argSpec(
          "mode",
          "off / mention-only / ambient / always / reset（恢復預設）",
          ArgKind.choice(MODE_CHOICES),
          {
            required: false,
          },
        ),
      ],
      permission: NODES.voiceView,
      ephemeral: true,
    }),
    settingCommand(inVoice, "mode"),
    { components: [settingRoute(R.voice, NODES.voiceSet, inVoice)] },
  );

  registry.register(
    commandSpec("admin persona show", "列出她的人格段落與字數", {
      permission: "admin.persona.view",
      ephemeral: true,
    }),
    () => personaCard(persona),
  );
}

function personaCard(persona: PersonaHandle): CommandReply {
  return persona.read((p) => {
    const lines = p.sections.map((s) => `\`${s.key}\`　${charCount(s.body)} 字`);
    const blocks: CardBlock[] = [
      { type: "text", text: lines.length === 0 ? "沒有任何人格段落。" : lines.join("\n") },
    ];
    if (p.examples.length > 0)
      blocks.push({ type: "muted", text: `範例對話：${p.examples.length} 則` });
    return cardReply(blocks, { title: `人格：${p.id}`, accent: "neutral" });
  });
}

/** The persona's sections as plain text (also used by the CLI and tests). */
export function personaSummary(persona: PersonaHandle): string {
  return personaCard(persona).text;
}
