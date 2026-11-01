// `stream start | stop | scene <name> | status` commands.

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  CommandReply,
  commandSpec,
  type Invocation,
} from "@miyoria/commands";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { defaultStageStatus, type StageStatus, type StreamAction } from "../protocol.js";
import type { StageLink } from "./link.js";

const log = getLogger("stage.link");

/** Paths registered by `registerStreamCommands`. */
export const PATHS = ["stream start", "stream stop", "stream scene", "stream status"] as const;

const OFFLINE = "直播機那邊沒連上……先把 `miyoria stage` 打開啦。";

/** One-line summary of a status. */
export function describeStatus(status: StageStatus): string {
  const on = (b: boolean) => (b ? "已連線" : "未連線");
  return `VTube Studio:${on(status.vts)}|OBS:${on(status.obs)}|場景:${status.scene ?? "—"}|直播:${
    status.streaming ? "直播中" : "沒在直播"
  }`;
}

/** Registers the stream commands. Undo with `unregisterStreamCommands`. */
export function registerStreamCommands(registry: CommandRegistry, link: StageLink): void {
  registry.setGroupDescription("stream", "直播控制(OBS)");

  const streamCommands: [StreamAction, string, string][] = [
    ["start", "stream start", "開始直播"],
    ["stop", "stream stop", "停止直播"],
  ];
  for (const [action, path, description] of streamCommands) {
    const permission = `stream.${path.replace(/^stream /, "")}`;
    registry.register(commandSpec(path, description, { permission }), async () => {
      if (!link.isConnected()) return CommandReply.ephemeral(OFFLINE);
      try {
        const status = await link.stream(action);
        if (status.streaming === (action === "start")) {
          return CommandReply.public(
            action === "start"
              ? "開台了!……才、才不是因為想見大家呢。"
              : "收台了。今天就到這裡,哼。",
          );
        }
        return CommandReply.ephemeral(
          `指令送出去了,不過 OBS 好像還沒反應過來。(${describeStatus(status)})`,
        );
      } catch (error) {
        log.warn({ err: errorMessage(error), action }, "stream command failed");
        return CommandReply.ephemeral(`OBS 不聽話……(${errorMessage(error)})`);
      }
    });
  }

  registry.register(
    commandSpec("stream scene", "切換 OBS 場景", {
      args: [argSpec("name", "場景名稱", ArgKind.string)],
      permission: "stream.scene",
    }),
    async (inv: Invocation) => {
      if (!link.isConnected()) return CommandReply.ephemeral(OFFLINE);
      const name = (inv.str("name") ?? "").trim();
      if (name === "") return CommandReply.ephemeral("要切到哪個場景啦?");
      try {
        await link.setScene(name);
        return CommandReply.public(`切到「${name}」了。`);
      } catch (error) {
        log.warn({ err: errorMessage(error), name }, "scene switch failed");
        return CommandReply.ephemeral(`切不過去欸……(${errorMessage(error)})`);
      }
    },
  );

  registry.register(
    commandSpec("stream status", "看直播機的狀態", {
      permission: "stream.status",
      ephemeral: true,
    }),
    async () => {
      if (!link.isConnected()) return CommandReply.ephemeral(OFFLINE);
      let status: StageStatus;
      try {
        status = await link.refreshStatus();
      } catch (error) {
        log.warn({ err: errorMessage(error) }, "status request failed");
        status = link.status() ?? defaultStageStatus();
      }
      return CommandReply.ephemeral(describeStatus(status));
    },
  );
}

export function unregisterStreamCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
