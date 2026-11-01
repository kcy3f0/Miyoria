import { AudioLines, MicOff, Volume2, VolumeX } from "lucide-react";
import { useMemo } from "react";
import type { LatencyStats, VoiceSession } from "../api/planned-types";
import type { Envelope, VoiceUtterance } from "../api/types";
import { useEvents } from "../app/events-store";
import { useVoice } from "../app/queries";
import { QueryView } from "../components/states";
import { Badge, EmptyState, PageHeader, Panel, SkeletonRows } from "../components/ui";
import { accountString, contextShort, fmtTime } from "../lib/format";

interface LatencySample {
  stage: "asr" | "tts" | string;
  ms: number;
}

/** `Custom { topic: "voice.latency" }` from miyoria-voice: `asr_ms` or `first_audio_ms`. */
export function latencyOf(env: Envelope): LatencySample | undefined {
  const e = env.event;
  if (e.type !== "custom" || e.data.topic !== "voice.latency") return undefined;
  const p = e.data.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return undefined;
  const stage = typeof p.stage === "string" ? p.stage : "?";
  const ms = typeof p.asr_ms === "number" ? p.asr_ms : typeof p.first_audio_ms === "number" ? p.first_audio_ms : undefined;
  return ms === undefined ? undefined : { stage, ms };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function Stat({ label, stats }: { label: string; stats: LatencyStats | { p50_ms: number | null; samples: number } }) {
  return (
    <div className="strip__item">
      <span className="strip__label">{label}</span>
      <span className="strip__value">
        {stats.p50_ms === null ? <span className="faint">—</span> : `${Math.round(stats.p50_ms)} ms`}
        <span className="strip__sub">{stats.samples} 次</span>
      </span>
    </div>
  );
}

function Session({ s }: { s: VoiceSession }) {
  const speaking = new Set(s.speaking.map(accountString));
  return (
    <Panel title={s.label ?? contextShort(s.context)} titleId={`vs-${s.context.channel}`} flush actions={<span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{s.participants.length} 人</span>}>
      <div className="strip strip--3" style={{ border: 0, borderBottom: "1px solid var(--c-line)", borderRadius: 0, margin: 0 }}>
        <Stat label="ASR p50" stats={s.latency.asr} />
        <Stat label="LLM 首字 p50" stats={s.latency.llm_first_token} />
        <Stat label="TTS 首音 p50" stats={s.latency.tts_first_audio} />
      </div>
      <ul className="rows">
        {s.participants.map((p) => {
          const talking = speaking.has(accountString(p.account));
          return (
            <li className="row" key={accountString(p.account)}>
              <span className={`dot${talking ? " speaking" : ""}`} data-tone={talking ? "ok" : undefined} aria-hidden />
              <div className="row__main">
                <div className="row__title" style={{ fontWeight: talking ? 600 : 500 }}>
                  {p.display_name}
                  {p.is_self && <Badge tone="accent">她</Badge>}
                  {talking && <span className="visually-hidden">正在說話</span>}
                </div>
              </div>
              <div className="row__aside faint">
                {p.muted && <MicOff aria-label="靜音" size={16} />}
                {p.deafened && <VolumeX aria-label="拒聽" size={16} />}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function VoicePage() {
  const voice = useVoice();
  const { events } = useEvents();

  const live = useMemo(() => {
    const transcript: { env: Envelope; u?: VoiceUtterance; self?: string }[] = [];
    const asr: number[] = [];
    const tts: number[] = [];
    for (const env of events) {
      const e = env.event;
      if (e.type === "voice_utterance") transcript.push({ env, u: e.data });
      else if (e.type === "voice_playback" && e.data.state === "started") transcript.push({ env, self: e.data.text });
      const l = latencyOf(env);
      if (l?.stage === "asr") asr.push(l.ms);
      if (l?.stage === "tts") tts.push(l.ms);
    }
    return { transcript: transcript.slice(0, 60), asr, tts };
  }, [events]);

  return (
    <div className="page">
      <PageHeader title="語音監控" description="誰在語音頻道、誰正在說話、即時轉錄,以及每個階段的延遲。" />
      <div className="grid-main-side">
        <div className="stack">
          <QueryView
            query={voice}
            route="GET /api/voice"
            feature="語音頻道狀態"
            framed
            skeleton={<Panel><SkeletonRows count={3} /></Panel>}
            isEmpty={(d) => d.sessions.length === 0}
            empty={
              <Panel>
                <EmptyState icon={AudioLines} compact title="她不在任何語音頻道">
                  在 Discord 用 /join 讓她進來。
                </EmptyState>
              </Panel>
            }
          >
            {(d) => (
              <>
                {d.sessions.map((s) => (
                  <Session key={`${s.context.scope}:${s.context.channel}`} s={s} />
                ))}
              </>
            )}
          </QueryView>
          <Panel title="延遲(本頁開啟後)" titleId="voice-latency" flush>
            <div className="strip strip--2" style={{ border: 0, borderRadius: 0, margin: 0 }}>
              <Stat label="ASR 中位數" stats={{ p50_ms: median(live.asr), samples: live.asr.length }} />
              <Stat label="TTS 首音中位數" stats={{ p50_ms: median(live.tts), samples: live.tts.length }} />
            </div>
          </Panel>
        </div>
        <Panel title={<><Volume2 aria-hidden size={16} />即時轉錄</>} titleId="voice-transcript" flush>
          <div style={{ height: "32rem", overflowY: "auto" }} aria-live="polite" aria-relevant="additions">
            {live.transcript.length === 0 ? (
              <EmptyState icon={AudioLines} compact title="還沒有人說話">
                有人在語音頻道開口,轉錄就會出現在這裡。
              </EmptyState>
            ) : (
              <ul className="rows">
                {live.transcript.map(({ env, u, self }) => (
                  <li className="row" key={env.id} style={{ alignItems: "flex-start" }}>
                    <time className="feed__time" dateTime={env.ts} style={{ paddingTop: 2 }}>
                      {fmtTime(env.ts)}
                    </time>
                    <div className="row__main">
                      <div className="row__title" style={{ fontSize: "var(--fs-sm)" }}>
                        {u ? u.speaker.display_name : <span style={{ color: "var(--c-accent)" }}>她</span>}
                        {u?.emotion && <span className="tag">{u.emotion}</span>}
                        {u && <span className="faint num" style={{ fontWeight: 400, fontSize: "var(--fs-xs)" }}>ASR {u.asr_ms} ms</span>}
                      </div>
                      <p style={{ overflowWrap: "anywhere" }}>{u ? u.text : self}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
