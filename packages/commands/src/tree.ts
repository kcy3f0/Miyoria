// The command tree's groups (command → group → subcommand), declared in one place so every
// module that adds a subcommand shares the same descriptions and platform gates.
//
//   /voice    join · leave · mode · consent · golive start|stop|status
//   /stream   start · stop · status · scene
//   /me       profile · call · link · privacy · memory show|export|forget
//   /queue    add · list · upvote · manage ... · vote start|end
//   /game     start · stop · goal · status
//   /channel  mode · activeness
//   /admin    module ... · role ... · perm ... · person ... · persona show · memory wipe ·
//             autonomy pause|resume|status
//   /help

import type { GroupInfo } from "./spec.js";

type GroupInit = Partial<Omit<GroupInfo, "description">> & { description: string };

export const COMMAND_GROUPS: Readonly<Record<string, GroupInit>> = {
  voice: { description: "語音：讓她加入或離開語音頻道、設定語音模式與 Go Live", guild_only: true },
  "voice golive": { description: "Discord Go Live 推流" },
  stream: { description: "直播：透過直播機控制 OBS", guild_only: true },
  me: { description: "你的資料：她怎麼稱呼你、帳號連結與她記得的事" },
  "me memory": { description: "她記得的關於你的事" },
  queue: { description: "請求佇列與投票", guild_only: true },
  "queue manage": { description: "管理佇列（叫號、跳過、清空等）" },
  "queue vote": { description: "投票" },
  game: { description: "遊戲：讓她開始或停止玩遊戲", guild_only: true },
  channel: { description: "頻道設定：她在這個頻道的聊天模式與主動程度", guild_only: true },
  admin: {
    description: "管理：模組、權限、她認識的人與記憶",
    guild_only: true,
    member_permission: "manage_guild",
  },
  "admin module": { description: "管理模組" },
  "admin role": { description: "管理角色與身分組對應" },
  "admin perm": { description: "覆寫角色的權限節點" },
  "admin person": { description: "管理她認識的人" },
  "admin persona": { description: "她的人格設定" },
  "admin memory": { description: "她的記憶資料" },
  "admin autonomy": { description: "她的自主行動：暫停、恢復與狀態" },
};

/** Display order of the top-level commands (e.g. in `/help`). */
export const CATEGORY_ORDER: readonly string[] = [
  "voice",
  "stream",
  "me",
  "queue",
  "game",
  "channel",
  "admin",
  "help",
];

export function groupInfo(init: GroupInit): GroupInfo {
  return {
    description: init.description,
    guild_only: init.guild_only ?? false,
    member_permission: init.member_permission ?? null,
  };
}
