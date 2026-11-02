// `/admin autonomy pause | resume | status`, `/me privacy` and the approval card's buttons.

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  type CommandReply,
  ComponentResult,
  cardReply,
  commandSpec,
  defineRoute,
  notice,
} from "@miyoria/commands";
import type { ActuatorRegistry } from "./registry.js";
import { APPROVE_ROUTE, answeredCard, DENY_ROUTE } from "./review.js";

export const PATHS = [
  "admin autonomy pause",
  "admin autonomy resume",
  "admin autonomy status",
  "me privacy",
] as const;

export const NODE_TOGGLE = "admin.autonomy.toggle";
export const NODE_VIEW = "admin.autonomy.view";
export const NODE_APPROVE = "owner.autonomy.approve";
export const NODE_PRIVACY = "me.privacy";

function statusReply(registry: ActuatorRegistry): CommandReply {
  const cfg = registry.config;
  const pending = registry.escalations.list();
  const lines = [
    `狀態：${registry.paused ? "已暫停（只有指令與面板能讓她行動）" : "運作中"}`,
    `能力：${registry.names().join("、") || "—"}`,
  ];
  if (cfg.forbidden.length > 0) lines.push(`禁止：${cfg.forbidden.join("、")}`);
  if (pending.length > 0) lines.push(`等待確認：${pending.map(([, s]) => s).join("、")}`);
  return cardReply([{ type: "text", text: lines.join("\n") }], {
    title: "自主行動",
    accent: registry.paused ? "warn" : "success",
  });
}

function privacyText(dm: boolean, approach: boolean): string {
  return [
    `私訊你：${dm ? "可以" : "不可以"}`,
    `主動找你（她自己發起的私訊等）：${approach ? "可以" : "不可以"}`,
  ].join("\n");
}

/** Registers the commands; undo with `unregisterCommands`. */
export function registerCommands(
  registry: CommandRegistry,
  actuators: () => ActuatorRegistry,
): void {
  registry.register(
    commandSpec("admin autonomy pause", "緊急暫停她的自主行動（指令與面板仍可使用）", {
      permission: NODE_TOGGLE,
      ephemeral: true,
    }),
    async () => {
      await actuators().setPaused(true);
      return notice("success", "已暫停她的自主行動。", "她仍會回話；指令與面板照常可用。");
    },
  );
  registry.register(
    commandSpec("admin autonomy resume", "恢復她的自主行動", {
      permission: NODE_TOGGLE,
      ephemeral: true,
    }),
    async () => {
      await actuators().setPaused(false);
      return notice("success", "已恢復她的自主行動。");
    },
  );

  const answer = (approved: boolean) =>
    defineRoute<string>({
      route: approved ? APPROVE_ROUTE : DENY_ROUTE,
      permission: NODE_APPROVE,
      parse: (params) => (params.length === 1 && params[0] ? params[0] : null),
      handle: (inv, id) => {
        const known = actuators().escalations.resolve(id, approved, inv.invoker);
        return ComponentResult.update(answeredCard(approved, known));
      },
    });
  registry.register(
    commandSpec("admin autonomy status", "查看她的自主行動狀態與能力", {
      permission: NODE_VIEW,
      ephemeral: true,
    }),
    () => statusReply(actuators()),
    { components: [answer(true), answer(false)] },
  );

  const onOff = (name: string, description: string) =>
    argSpec(name, description, ArgKind.choice(["on", "off"]), { required: false });
  registry.register(
    commandSpec("me privacy", "設定她能不能私訊你、能不能主動找你（省略 = 查看）", {
      args: [
        onOff("dm", "on = 可以私訊你，off = 不要"),
        onOff("approach", "on = 可以主動找你，off = 不要"),
      ],
      permission: NODE_PRIVACY,
      ephemeral: true,
    }),
    async (inv) => {
      const dm = inv.str("dm");
      const approach = inv.str("approach");
      const privacy = actuators().privacy;
      if (dm === null && approach === null) {
        const now = await privacy.get(inv.invoker);
        return notice("info", privacyText(now.dm, now.approach));
      }
      const next = await privacy.set(inv.invoker, {
        ...(dm === null ? {} : { dm: dm === "on" }),
        ...(approach === null ? {} : { approach: approach === "on" }),
      });
      return notice("success", `已更新。\n${privacyText(next.dm, next.approach)}`);
    },
  );
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
