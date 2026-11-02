// `/stream start | stop | status | scene <name>` commands.

import {
  type AnyComponentRoute,
  ArgKind,
  argSpec,
  type CardBlock,
  type Choice,
  type CommandRegistry,
  type CommandReply,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  type Invocation,
  notice,
} from "@miyoria/commands";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { defaultStageStatus, type StageStatus, type StreamAction } from "../protocol.js";
import type { StageLink } from "./link.js";

const log = getLogger("stage.link");

/** Paths registered by `registerStreamCommands`. */
export const PATHS = ["stream start", "stream stop", "stream scene", "stream status"] as const;

const R = {
  start: "stream:start",
  stop: "stream:stop",
  scene: "stream:scene",
  refresh: "stream:refresh",
} as const;

const offline = () => notice("warn", "直播機目前沒有連線。", "請在直播機上執行 miyoria stage。");

/** One-line summary of a status. */
export function describeStatus(status: StageStatus): string {
  const on = (b: boolean) => (b ? "已連線" : "未連線");
  return `VTube Studio：${on(status.vts)}｜OBS：${on(status.obs)}｜場景：${status.scene ?? "—"}｜直播：${
    status.streaming ? "直播中" : "未直播"
  }`;
}

/**
 * OBS scene names the stage node reported, if its status carries them (`scenes`), plus the
 * current scene.
 */
export function sceneNames(status: StageStatus | null): string[] {
  const listed = (status as (StageStatus & { scenes?: unknown }) | null)?.scenes;
  const names = Array.isArray(listed)
    ? listed.filter((s): s is string => typeof s === "string")
    : [];
  if (status?.scene && !names.includes(status.scene)) names.unshift(status.scene);
  return names;
}

function statusCard(status: StageStatus, note: string | null = null): CommandReply {
  const blocks: CardBlock[] = [
    {
      type: "text",
      text: [
        `直播：${status.streaming ? "直播中" : "未直播"}`,
        `場景：${status.scene ?? "—"}`,
        `OBS：${status.obs ? "已連線" : "未連線"}　VTube Studio：${status.vts ? "已連線" : "未連線"}`,
      ].join("\n"),
    },
  ];
  if (note) blocks.push({ type: "muted", text: note });
  const scenes = sceneNames(status);
  if (scenes.length > 1) {
    blocks.push({
      type: "select",
      select: {
        id: componentId(R.scene),
        placeholder: "切換場景…",
        options: scenes.slice(0, 25).map((s) => ({
          label: s,
          value: s,
          default: s === status.scene,
        })),
      },
    });
  }
  blocks.push({
    type: "buttons",
    buttons: [
      status.streaming
        ? { id: componentId(R.stop), label: "停止直播", style: "danger" }
        : { id: componentId(R.start), label: "開始直播", style: "primary" },
      { id: componentId(R.refresh), label: "重新整理", style: "secondary" },
    ],
  });
  return cardReply(blocks, {
    title: "直播狀態",
    accent: status.streaming ? "success" : "neutral",
    session: {},
  });
}

/** Registers the stream commands. Undo with `unregisterStreamCommands`. */
export function registerStreamCommands(registry: CommandRegistry, link: StageLink): void {
  const stream = async (action: StreamAction): Promise<CommandReply> => {
    if (!link.isConnected()) return offline();
    try {
      const status = await link.stream(action);
      if (status.streaming === (action === "start")) {
        return notice("success", action === "start" ? "已開始直播。" : "已停止直播。");
      }
      return notice("warn", "已送出指令，但 OBS 尚未回報狀態變更。", describeStatus(status));
    } catch (error) {
      log.warn({ err: errorMessage(error), action }, "stream command failed");
      return notice(
        "error",
        action === "start" ? "無法開始直播。" : "無法停止直播。",
        errorMessage(error),
      );
    }
  };

  const setScene = async (raw: string): Promise<CommandReply> => {
    if (!link.isConnected()) return offline();
    const name = raw.trim();
    if (name === "") return notice("warn", "請指定場景名稱。");
    try {
      await link.setScene(name);
      return notice("success", `已切換到場景「${name}」。`);
    } catch (error) {
      log.warn({ err: errorMessage(error), name }, "scene switch failed");
      return notice("error", `無法切換到場景「${name}」。`, errorMessage(error));
    }
  };

  const currentStatus = async (): Promise<StageStatus> => {
    try {
      return await link.refreshStatus();
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "status request failed");
      return link.status() ?? defaultStageStatus();
    }
  };

  /** After a button: errors are their own message, success refreshes the card. */
  const afterAction = async (reply: CommandReply): Promise<ComponentResult> => {
    if (reply.tone === "warn" || reply.tone === "error") return ComponentResult.reply(reply);
    return ComponentResult.update(statusCard(link.status() ?? (await currentStatus()), reply.text));
  };

  const routes: AnyComponentRoute[] = [
    {
      route: R.start,
      permission: "stream.start",
      handle: async () => afterAction(await stream("start")),
    },
    {
      route: R.stop,
      permission: "stream.stop",
      handle: async () => afterAction(await stream("stop")),
    },
    {
      route: R.scene,
      permission: "stream.scene",
      handle: async (inv) => afterAction(await setScene(inv.values[0] ?? "")),
    },
    {
      route: R.refresh,
      handle: async () => {
        if (!link.isConnected()) return ComponentResult.reply(offline());
        return ComponentResult.update(statusCard(await currentStatus()));
      },
    },
  ];

  registry.register(
    commandSpec("stream start", "讓直播機的 OBS 開始直播", { permission: "stream.start" }),
    () => stream("start"),
  );
  registry.register(
    commandSpec("stream stop", "讓直播機的 OBS 停止直播", { permission: "stream.stop" }),
    () => stream("stop"),
  );

  const suggestScenes = (_inv: Invocation, value: string): Choice[] => {
    const q = value.trim().toLowerCase();
    return sceneNames(link.status())
      .filter((s) => q === "" || s.toLowerCase().includes(q))
      .map((s) => ({ name: s, value: s }));
  };
  registry.register(
    commandSpec("stream scene", "切換 OBS 場景", {
      args: [argSpec("name", "場景名稱", ArgKind.string)],
      permission: "stream.scene",
      ephemeral: true,
    }),
    (inv) => setScene(inv.str("name") ?? ""),
    { autocomplete: { name: suggestScenes } },
  );

  registry.register(
    commandSpec("stream status", "查看直播機與 OBS 的狀態", {
      permission: "stream.status",
      ephemeral: true,
    }),
    async () => {
      if (!link.isConnected()) return offline();
      return statusCard(await currentStatus());
    },
    { components: routes },
  );
}

export function unregisterStreamCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
