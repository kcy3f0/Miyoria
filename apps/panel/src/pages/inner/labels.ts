import type { AgendaStatus, DriveName, PresenceActivity, PresenceStatus } from "@/api/types";
import type { Tone } from "@/components/status";

export const DRIVE_LABEL: Record<DriveName, string> = {
  social: "想聊天",
  play: "想玩",
  attention: "想被注意",
  rest: "想休息",
  curiosity: "好奇",
};

export const DRIVE_ORDER: DriveName[] = ["social", "play", "attention", "rest", "curiosity"];

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  online: "在線",
  idle: "閒置",
  dnd: "請勿打擾",
  offline: "離線",
};

export const PRESENCE_TONE: Record<PresenceStatus, Tone> = {
  online: "success",
  idle: "warning",
  dnd: "danger",
  offline: "neutral",
};

export const AGENDA_LABEL: Record<AgendaStatus, string> = {
  open: "進行中",
  done: "完成",
  expired: "過期",
  dropped: "放棄",
};

export const AGENDA_TONE: Record<AgendaStatus, Tone> = {
  open: "brand",
  done: "success",
  expired: "neutral",
  dropped: "neutral",
};

/** `*` / `voice` / `text` / `discord:<guild>` / a context string, in words. */
export function scopeLabel(scope: string): string {
  if (scope === "*") return "所有地方";
  if (scope === "voice") return "所有語音頻道";
  if (scope === "text") return "所有文字頻道";
  const parts = scope.split(":");
  if (parts.length === 2) return `伺服器 ${parts[1]}`;
  if (parts.length === 4 && parts[2] === "voice") return `語音 ${parts[3]}`;
  if (parts.length === 3) return parts[1] === "dm" ? `私訊 ${parts[2]}` : `#${parts[2]}`;
  return scope;
}

/** What someone is doing, in one short phrase. */
export function activityText(a: PresenceActivity): string | null {
  switch (a.type) {
    case "playing":
      return a.name ? `玩 ${a.name}` : null;
    case "listening":
      if (a.details) return `聽 ${a.details}${a.state ? ` — ${a.state}` : ""}`;
      return a.name ? `聽 ${a.name}` : null;
    case "streaming":
      return a.details ? `直播 ${a.details}` : "直播中";
    case "watching":
      return a.name ? `看 ${a.name}` : null;
    case "competing":
      return a.name ? `比賽 ${a.name}` : null;
    case "custom": {
      const text = [a.details, a.name].filter(Boolean).join(" ");
      return text ? `「${text}」` : null;
    }
  }
}
