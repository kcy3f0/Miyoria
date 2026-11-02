// `/game start | stop | goal | status`.

import {
  ArgKind,
  argSpec,
  type CardBlock,
  type CardButton,
  type CommandHandler,
  type CommandRegistry,
  type CommandReply,
  type CommandSpec,
  ComponentResult,
  cardReply,
  commandName,
  commandSpec,
  componentId,
  notice,
  type RegisterOptions,
} from "@miyoria/commands";
import { contextKeyString } from "@miyoria/types";
import type { GamePermissions } from "./config.js";
import {
  type Director,
  GameError,
  type GameStatus,
  type Placement,
  type View,
} from "./director.js";

const R = { stop: "game:stop", refresh: "game:refresh" } as const;

/** `game status` text. */
export function formatStatus(status: GameStatus | null): string {
  if (!status) return "她目前沒有在玩遊戲。";
  let out = `正在玩：${status.game_name}（實況送到 ${contextKeyString(status.context)}）`;
  const g = status.goal;
  if (g) {
    out += `\n目標：${g.text}${g.note}（已進行 ${g.age_secs} 秒）`;
    if (g.action !== null) out += `\n動作：${g.action}`;
  } else {
    out += "\n目標：尚未決定";
  }
  if (status.backlog.length > 0) out += `\n排隊中：${status.backlog.join("、")}`;
  if (status.busy !== null) out += status.busy ? "\n遊戲 bot：忙碌中" : "\n遊戲 bot：閒置";
  if (status.summary !== "") {
    const short = status.summary
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .slice(0, 4)
      .join("／");
    out += `\n狀況：${short}`;
  }
  return out;
}

function statusCard(status: GameStatus | null, note: string | null = null): CommandReply {
  const blocks: CardBlock[] = [{ type: "text", text: formatStatus(status) }];
  if (note) blocks.push({ type: "muted", text: note });
  const buttons: CardButton[] = [
    { id: componentId(R.refresh), label: "重新整理", style: "secondary" },
  ];
  if (status) buttons.unshift({ id: componentId(R.stop), label: "停止", style: "danger" });
  blocks.push({ type: "buttons", buttons });
  return cardReply(blocks, {
    title: "遊戲狀態",
    accent: status ? "success" : "neutral",
    session: {},
  });
}

/** Runs a director call: its text is a success notice, a refusal a warning. */
function ask(call: () => string): CommandReply {
  try {
    return notice("success", call());
  } catch (error) {
    if (error instanceof GameError) return notice("warn", error.message);
    throw error;
  }
}

/** Registers `game start | stop | goal | status`; returns the paths (for unregistering). */
export function registerCommands(
  registry: CommandRegistry,
  perms: GamePermissions,
  defaultGame: string,
  director: Director,
  view: View,
): string[] {
  const paths: string[] = [];
  const add = (spec: CommandSpec, handler: CommandHandler, options: RegisterOptions = {}) => {
    paths.push(commandName(spec));
    registry.register(spec, handler, options);
  };

  add(
    commandSpec("game start", "讓她開始玩遊戲（導演迴路與實況）", {
      args: [
        argSpec("game", `遊戲 id，預設為 ${defaultGame}`, ArgKind.string, { required: false }),
        argSpec(
          "where",
          "實況送到哪裡：auto（預設，語音頻道 > 直播頻道 > 這裡）、voice、here、stream",
          ArgKind.choice(["auto", "voice", "here", "stream"]),
          { required: false },
        ),
      ],
      permission: perms.start,
    }),
    (inv) => {
      const raw = inv.str("game")?.trim().toLowerCase();
      const game = raw ? raw : defaultGame;
      const where = inv.str("where");
      const placement: Placement =
        where === "voice" || where === "here" || where === "stream" ? where : "auto";
      return ask(() => director.start(game, placement, inv.context, inv.invoker));
    },
  );

  add(commandSpec("game stop", "讓她停止玩遊戲", { permission: perms.stop }), () =>
    ask(() => director.stop()),
  );

  add(
    commandSpec("game goal", "指定她接下來在遊戲裡要做的事", {
      args: [argSpec("text", "目標，例如「去挖鐵礦」", ArgKind.string)],
      permission: perms.goal,
    }),
    (inv) => ask(() => director.goal(inv.str("text") ?? "", inv.invoker_display_name)),
  );

  add(
    commandSpec("game status", "查看她正在玩什麼、目前的目標", {
      permission: perms.status,
      ephemeral: true,
    }),
    () => statusCard(view.current),
    {
      components: [
        { route: R.refresh, handle: () => ComponentResult.update(statusCard(view.current)) },
        {
          route: R.stop,
          permission: perms.stop,
          handle: () => {
            const result = ask(() => director.stop());
            if (result.tone === "warn") return ComponentResult.reply(result);
            return ComponentResult.update(statusCard(view.current, result.text));
          },
        },
      ],
    },
  );

  return paths;
}
