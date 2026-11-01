import {
  ArgKind,
  argSpec,
  type CommandHandler,
  type CommandRegistry,
  CommandReply,
  type CommandSpec,
  commandName,
  commandSpec,
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

/** `game status` text. */
export function formatStatus(status: GameStatus | null): string {
  if (!status) return "現在沒在玩遊戲。";
  let out = `正在玩 ${status.game_name}(實況送到 ${contextKeyString(status.context)})`;
  const g = status.goal;
  if (g) {
    out += `\n目標:${g.text}${g.note}(已 ${g.age_secs} 秒)`;
    if (g.action !== null) out += `\n動作:${g.action}`;
  } else {
    out += "\n目標:還沒決定";
  }
  if (status.backlog.length > 0) out += `\n排隊中:${status.backlog.join("、")}`;
  if (status.busy !== null) out += status.busy ? "\nbot:忙碌中" : "\nbot:閒置";
  if (status.summary !== "") {
    const short = status.summary
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .slice(0, 4)
      .join(" / ");
    out += `\n狀況:${short}`;
  }
  return out;
}

/** Runs a director call: its text is public, a refusal is ephemeral. */
function ask(call: () => string): CommandReply {
  try {
    return CommandReply.public(call());
  } catch (error) {
    if (error instanceof GameError) return CommandReply.ephemeral(error.message);
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
  registry.setGroupDescription("game", "遊戲直播");
  const paths: string[] = [];
  const add = (spec: CommandSpec, handler: CommandHandler): void => {
    paths.push(commandName(spec));
    registry.register(spec, handler);
  };

  add(
    commandSpec("game start", "開始玩遊戲(慢迴路導演 + 實況)", {
      args: [
        argSpec("game", `遊戲 id,預設 ${defaultGame}`, ArgKind.string, { required: false }),
        argSpec(
          "where",
          "實況送到哪裡:auto(預設,語音頻道 > 直播頻道 > 這裡)、voice、here、stream",
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

  add(commandSpec("game stop", "停止玩遊戲", { permission: perms.stop }), () =>
    ask(() => director.stop()),
  );

  add(
    commandSpec("game goal", "指定她接下來在遊戲裡要做的事", {
      args: [argSpec("text", "目標,例如「去挖鐵礦」", ArgKind.string)],
      permission: perms.goal,
    }),
    (inv) => ask(() => director.goal(inv.str("text") ?? "", inv.invoker_display_name)),
  );

  add(
    commandSpec("game status", "看她現在在玩什麼、目標是什麼", {
      permission: perms.status,
      ephemeral: true,
    }),
    () => CommandReply.ephemeral(formatStatus(view.current)),
  );

  return paths;
}
