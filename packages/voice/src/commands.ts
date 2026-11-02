// `join`, `leave`, `voice consent` and `golive` commands.

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  CommandReply,
  commandSpec,
  type Invocation,
} from "@miyoria/commands";
import { errorMessage, getLogger } from "@miyoria/kernel";
import type { Consent, ConsentPolicy } from "./consent.js";
import type { GoLiveState } from "./link/conn.js";
import type { VoiceLink } from "./link/link.js";

const log = getLogger("voice.commands");

/** Paths registered by `registerCommands`. */
export const PATHS = [
  "join",
  "leave",
  "voice consent",
  "golive start",
  "golive stop",
  "golive status",
] as const;

const GOLIVE_STATE_TEXT: Record<GoLiveState, string> = {
  starting: "正在連線",
  live: "直播中",
  stopped: "沒在直播",
  failed: "失敗了",
};

/** The announcement she makes after joining a voice channel. */
export function joinAnnouncement(policy: ConsentPolicy): string {
  switch (policy) {
    case "opt-out":
      return (
        "哼,我進來了。先說好,我會聽你們講話喔……" +
        "不想被我聽到的話就用 `/voice consent off`,我、我才不會在意呢!"
      );
    case "opt-in":
      return (
        "哼,我進來了。想讓我聽到你說話的話,要先用 " +
        "`/voice consent on` 喔……不、不是我想聽啦!(`/voice consent off` 可以隨時取消)"
      );
  }
}

function guildOf(inv: Invocation): string | null {
  return inv.context.scope;
}

/** Registers the voice commands. Undo with `unregisterCommands`. */
export function registerCommands(
  registry: CommandRegistry,
  link: VoiceLink,
  consent: Consent,
  goliveSource: string,
): void {
  registry.setGroupDescription("voice", "語音設定");
  registry.setGroupDescription("golive", "Discord Go Live 推流");

  const policy = consent.policy;
  registry.register(
    commandSpec("join", "叫她進你現在所在的語音頻道", { permission: "voice.join" }),
    async (inv) => {
      const guild = guildOf(inv);
      if (guild === null) {
        return CommandReply.ephemeral("要在伺服器裡叫我啦,私訊是要我進哪裡?");
      }
      const self = link.selfAccount();
      const samePlatform = self !== null && self.platform === inv.invoker.platform;
      if (!link.isConnected() || !samePlatform) {
        return CommandReply.ephemeral("我的語音帳號現在不在線上……等一下再叫我啦。");
      }
      try {
        await link.join(guild, null, inv.invoker.id);
        return CommandReply.public(joinAnnouncement(policy));
      } catch (error) {
        const e = errorMessage(error);
        log.warn({ err: e, guild }, "join failed");
        return CommandReply.ephemeral(`進不去欸……你有在語音頻道裡嗎?(${e})`);
      }
    },
  );

  registry.register(
    commandSpec("leave", "叫她離開語音頻道", { permission: "voice.leave" }),
    async (inv) => {
      const guild = guildOf(inv);
      if (guild === null) return CommandReply.ephemeral("要在伺服器裡用啦。");
      if (link.channel(guild) === null) return CommandReply.ephemeral("我本來就不在語音裡啊。");
      await link.leave(guild);
      return CommandReply.public("好啦好啦,我走就是了。");
    },
  );

  registry.register(
    commandSpec("voice consent", "設定她在語音頻道裡能不能聽你說話", {
      args: [argSpec("state", "on = 可以聽,off = 不要聽", ArgKind.choice(["on", "off"]))],
      permission: "voice.consent",
      ephemeral: true,
    }),
    async (inv) => {
      const allowed = inv.str("state") === "on";
      await consent.set(inv.invoker, allowed);
      return CommandReply.ephemeral(
        allowed
          ? "知道了,我會聽你說話的。哼,別講無聊的事喔。"
          : "好,我不會聽你說話了。……也不是說我很想聽啦。",
      );
    },
  );

  registry.register(
    commandSpec("golive start", "把直播畫面送進語音頻道(Discord Go Live)", {
      args: [
        argSpec(
          "source",
          "RTMP / SRT 來源;預設用設定檔的 [modules.voice] golive_source",
          ArgKind.string,
          {
            required: false,
          },
        ),
      ],
      permission: "voice.golive",
    }),
    async (inv) => {
      const guild = guildOf(inv);
      if (guild === null) return CommandReply.ephemeral("要在伺服器裡用啦。");
      const self = link.selfAccount();
      const samePlatform = self !== null && self.platform === inv.invoker.platform;
      if (!link.isConnected() || !samePlatform) {
        return CommandReply.ephemeral("我的語音帳號現在不在線上……等一下再叫我啦。");
      }
      if (link.isStreaming(guild)) return CommandReply.ephemeral("我已經在直播了喔。");
      const source = (inv.str("source") ?? goliveSource).trim();
      if (source === "")
        return CommandReply.ephemeral("沒給來源,設定檔的 `golive_source` 也是空的。");
      // Not in voice yet: join the invoker's channel first, so one command is enough.
      let joined = false;
      if (link.channel(guild) === null) {
        try {
          await link.join(guild, null, inv.invoker.id);
          joined = true;
        } catch (error) {
          const e = errorMessage(error);
          log.warn({ err: e, guild }, "join for go live failed");
          return CommandReply.ephemeral(`進不去語音頻道……你有在語音頻道裡嗎?(${e})`);
        }
      }
      try {
        await link.goliveStart({ guild, source });
        const opening = "好,開台!等 OBS 的畫面連上就開始了。";
        return CommandReply.public(joined ? `${joinAnnouncement(policy)}\n${opening}` : opening);
      } catch (error) {
        const e = errorMessage(error);
        log.warn({ err: e, guild, source }, "go live start failed");
        return CommandReply.ephemeral(`開不了台……(${e})`);
      }
    },
  );

  registry.register(
    commandSpec("golive stop", "結束 Discord Go Live 推流", {
      permission: "voice.golive",
    }),
    async (inv) => {
      const guild = guildOf(inv);
      if (guild === null) return CommandReply.ephemeral("要在伺服器裡用啦。");
      if (!link.isStreaming(guild)) return CommandReply.ephemeral("我本來就沒在直播啊。");
      try {
        await link.goliveStop(guild);
        return CommandReply.public("收台了。今天就到這裡,哼。");
      } catch (error) {
        const e = errorMessage(error);
        log.warn({ err: e, guild }, "go live stop failed");
        return CommandReply.ephemeral(`收不了台……(${e})`);
      }
    },
  );

  registry.register(
    commandSpec("golive status", "看 Go Live 的狀態", {
      permission: "voice.golive",
      ephemeral: true,
    }),
    async (inv) => {
      const guild = guildOf(inv);
      if (guild === null) return CommandReply.ephemeral("要在伺服器裡用啦。");
      const status = link.golive(guild);
      if (status === null) return CommandReply.ephemeral("沒在直播。");
      const detail = status.error ?? status.reason;
      return CommandReply.ephemeral(
        `Go Live:${GOLIVE_STATE_TEXT[status.state]}${detail ? `(${detail})` : ""}`,
      );
    },
  );
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
