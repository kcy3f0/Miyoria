import type { BusEvent, Envelope } from "../api/types";
import { accountString, contextShort } from "./format";

/** Mirrors `Event::topic()` in `crates/miyoria-types/src/event.rs`. */
const TOPICS: Record<Exclude<BusEvent["type"], "custom">, string> = {
  platform_ready: "platform.ready",
  platform_message_created: "platform.message.created",
  platform_typing: "platform.typing",
  agent_turn_started: "agent.turn.started",
  agent_decision: "agent.decision",
  agent_turn_completed: "agent.turn.completed",
  action_completed: "action.completed",
  voice_joined: "voice.joined",
  voice_left: "voice.left",
  voice_participants: "voice.participants",
  voice_speaking: "voice.speaking",
  voice_utterance: "voice.utterance",
  voice_playback: "voice.playback",
  agent_initiative: "agent.initiative",
  module_state_changed: "system.module.state",
};

export function topicOf(event: BusEvent): string {
  if (event.type === "custom") return event.data.topic;
  return TOPICS[event.type] ?? event.type;
}

/**
 * Same semantics as the kernel's `TopicFilter`: `*` matches everything,
 * `agent.*` matches anything below `agent` (not `agent` itself), otherwise exact.
 */
export function topicMatches(pattern: string, topic: string): boolean {
  const p = pattern.trim();
  if (!p || p === "*") return true;
  if (p.endsWith(".*")) {
    const prefix = p.slice(0, -2);
    return topic.startsWith(`${prefix}.`);
  }
  return p === topic;
}

export function matchesAny(patterns: string[], topic: string): boolean {
  const ps = patterns.map((p) => p.trim()).filter(Boolean);
  return ps.length === 0 || ps.some((p) => topicMatches(p, topic));
}

/** Parses a comma / whitespace separated topic filter. */
export const parseTopics = (raw: string): string[] => raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

/** First segment of the topic, used to color the ticker. */
export function topicGroup(topic: string): string {
  return topic.split(".")[0] ?? topic;
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface EventSummary {
  text: string;
  tone: Tone;
}

/** One-line, human description of an envelope for tickers and lists. */
export function summarize(env: Envelope): EventSummary {
  const e = env.event;
  switch (e.type) {
    case "platform_ready":
      return { text: `${e.data.platform} 已連線(${accountString(e.data.self_account)})`, tone: "ok" };
    case "platform_message_created":
      return { text: `${e.data.author.display_name}:${clip(e.data.text)}`, tone: "neutral" };
    case "platform_typing":
      return { text: `${accountString(e.data.account)} 正在輸入…`, tone: "neutral" };
    case "agent_turn_started":
      return { text: `回合開始 · ${contextShort(e.data.context)}`, tone: "accent" };
    case "agent_decision":
      return {
        text: `${e.data.respond ? "回應" : "略過"} · 分數 ${e.data.score.toFixed(2)}${e.data.reasons[0] ? ` · ${clip(e.data.reasons[0], 60)}` : ""}`,
        tone: e.data.respond ? "accent" : "neutral",
      };
    case "agent_turn_completed":
      return { text: `她說:${clip(e.data.text)}`, tone: "accent" };
    case "action_completed":
      return e.data.ok
        ? { text: "動作完成", tone: "ok" }
        : { text: `動作失敗:${clip(e.data.error ?? "未知錯誤")}`, tone: "danger" };
    case "voice_joined":
      return { text: `加入語音 · ${e.data.participants.length} 人`, tone: "ok" };
    case "voice_left":
      return { text: `離開語音${e.data.reason ? `(${e.data.reason})` : ""}`, tone: "neutral" };
    case "voice_participants":
      return { text: `語音成員變動 · ${e.data.participants.length} 人`, tone: "neutral" };
    case "voice_speaking":
      return { text: `${accountString(e.data.account)} ${e.data.speaking ? "開始說話" : "停止說話"}`, tone: "neutral" };
    case "voice_utterance":
      return { text: `${e.data.speaker.display_name}(語音):${clip(e.data.text)}`, tone: "neutral" };
    case "voice_playback": {
      const label = { started: "開始播放", finished: "播放結束", interrupted: "被打斷", failed: "播放失敗" }[e.data.state];
      return { text: `${label} · ${clip(e.data.text, 60)}`, tone: e.data.state === "failed" ? "danger" : e.data.state === "interrupted" ? "warn" : "accent" };
    }
    case "agent_initiative":
      return { text: `主動發言:${e.data.reason}${e.data.hint ? ` · ${clip(e.data.hint, 60)}` : ""}`, tone: "accent" };
    case "module_state_changed": {
      const s = e.data.state;
      return {
        text: `${e.data.module} → ${s}${e.data.reason ? `(${clip(e.data.reason, 60)})` : ""}`,
        tone: s === "failed" ? "danger" : s === "degraded" ? "warn" : s === "running" ? "ok" : "neutral",
      };
    }
    case "custom": {
      const payload = e.data.payload;
      const text = payload === null || payload === undefined ? "" : clip(JSON.stringify(payload), 100);
      return { text, tone: e.data.topic === "llm.budget" ? "warn" : "neutral" };
    }
    default:
      return { text: "", tone: "neutral" };
  }
}
