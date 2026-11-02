import { MicOff, VolumeX } from "lucide-react";
import type { LatencyStats, VoiceSession } from "@/api/types";
import { useVoice } from "@/app/queries";
import { QueryView, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { accountString, contextShort } from "@/lib/format";
import { cn } from "@/lib/utils";

const ms = (s: LatencyStats) => (s.p50_ms === null ? "—" : `${Math.round(s.p50_ms)}`);

function Session({ s }: { s: VoiceSession }) {
  const speaking = new Set(s.speaking.map(accountString));
  const people = [...s.participants].sort((a, b) => Number(b.is_self) - Number(a.is_self));
  return (
    <div className="grid">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={s.label ?? undefined}>
          {s.label ?? contextShort(s.context)}
        </span>
        <span className="text-[13px] text-muted-foreground tabular-nums">{s.participants.length} 人</span>
      </div>
      <dl className="grid grid-cols-3 gap-px border-b bg-border" aria-label="延遲 p50(毫秒)">
        {(
          [
            ["ASR", s.latency.asr],
            ["LLM 首字", s.latency.llm_first_token],
            ["TTS 首音", s.latency.tts_first_audio],
          ] as const
        ).map(([label, stats]) => (
          <div key={label} className="bg-card px-4 py-2.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-mono text-sm tabular-nums">
              {ms(stats)}
              {stats.p50_ms !== null && <span className="ml-0.5 text-xs text-muted-foreground">ms</span>}
            </dd>
          </div>
        ))}
      </dl>
      <ul className="divide-y" aria-label="語音成員">
        {people.map((p) => {
          const talking = speaking.has(accountString(p.account));
          return (
            <li key={accountString(p.account)} className="flex items-center gap-2.5 px-4 py-2">
              <Dot tone={talking ? "success" : "neutral"} pulse={talking} className={cn(!talking && "opacity-40")} />
              <span className={cn("min-w-0 flex-1 truncate text-sm", talking && "font-medium")}>
                {p.display_name}
                {talking && <span className="sr-only">(正在說話)</span>}
              </span>
              {p.is_self && <Badge variant="brand">她</Badge>}
              {p.muted && <MicOff aria-label="靜音" className="size-3.5 text-muted-foreground" />}
              {p.deafened && <VolumeX aria-label="拒聽" className="size-3.5 text-muted-foreground" />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function VoiceCard() {
  const voice = useVoice();
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>語音</CardTitle>
      </CardHeader>
      <QueryView
        query={voice}
        isEmpty={(d) => d.sessions.length === 0}
        empty="不在任何語音頻道"
        skeleton={<SkeletonRows count={3} />}
      >
        {(d) => (
          <div className="divide-y">
            {d.sessions.map((s) => (
              <Session key={`${s.context.scope}:${s.context.channel}`} s={s} />
            ))}
          </div>
        )}
      </QueryView>
    </Card>
  );
}
