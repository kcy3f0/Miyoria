import { useMemo, useState } from "react";
import type { MetricRatio, TurnMetrics, TurnMetricsBucket } from "@/api/types";
import { useTurnMetrics, useVoice } from "@/app/queries";
import { BarList, ChartBlock, ChartEmpty, type Part, SegmentBar, TimeChart } from "@/components/charts/charts";
import { EmptyLine, ErrorLine } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Skeleton } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { VoiceLatency } from "@/components/voice-latency";
import { fmtMs } from "@/lib/e2e";
import { contextShort, fmtPct } from "@/lib/format";
import { readStorage, writeStorage } from "@/lib/storage";

export const V4_RANGES = [
  { days: 7, label: "7 天" },
  { days: 14, label: "14 天" },
  { days: 30, label: "30 天" },
] as const;

const RANGE_KEY = "miyoria.panel.v4MetricsDays";

function useDays(): [number, (d: number) => void] {
  const [days, set] = useState<number>(() => {
    const saved = Number(readStorage(RANGE_KEY));
    return V4_RANGES.find((r) => r.days === saved)?.days ?? 7;
  });
  return [
    days,
    (d) => {
      writeStorage(RANGE_KEY, String(d));
      set(d);
    },
  ];
}

interface Spec {
  id: string;
  label: string;
  /** The §13 target as written, shown next to the value. */
  targetLabel: string;
  /** Reference lines drawn in the chart (a band has two). */
  lines: { label: string; value: number }[];
  good: (v: number) => boolean;
  /** This bucket's value and what it was counted over; `null` value: nothing to count. */
  read: (b: TurnMetricsBucket) => { value: number | null; n: number; unit: string };
  format: (v: number) => string;
  /** Headline when the shape is not a single number. */
  headline?: (b: TurnMetricsBucket) => string | null;
  /** `true` when `value` is a rate and the axis is 0..1. */
  rate: boolean;
}

const ratio = (r: MetricRatio, unit = "回合") => ({ value: r.rate, n: r.total, unit });
const pct = (v: number) => fmtPct(v, v > 0 && v < 0.1 ? 1 : 0);

/** The rows of §13 the turn log can answer. Targets are the plan's, not guesses. */
export const SPECS: Spec[] = [
  {
    id: "followup",
    label: "接話率(別人接她的話)",
    targetLabel: "> 60%",
    lines: [{ label: "目標 60%", value: 0.6 }],
    good: (v) => v > 0.6,
    read: (b) => ratio(b.followup),
    format: pct,
    rate: true,
  },
  {
    id: "ambient",
    label: "閒聊參與(沒人叫她時)",
    targetLabel: "5 到 15%",
    lines: [
      { label: "下限 5%", value: 0.05 },
      { label: "上限 15%", value: 0.15 },
    ],
    good: (v) => v >= 0.05 && v <= 0.15,
    read: (b) => ratio(b.ambient),
    format: pct,
    rate: true,
  },
  {
    id: "addressed",
    label: "被叫到有回",
    targetLabel: "> 95%",
    lines: [{ label: "目標 95%", value: 0.95 }],
    good: (v) => v > 0.95,
    read: (b) => ratio(b.addressed),
    format: pct,
    rate: true,
  },
  {
    id: "latency",
    label: "語音延遲 p50(被叫到)",
    targetLabel: "≤ 2.5 s",
    lines: [{ label: "目標 2.5 s", value: 2500 }],
    good: (v) => v <= 2500,
    read: (b) => ({ value: b.voice_latency.p50_ms, n: b.voice_latency.samples, unit: "次" }),
    format: fmtMs,
    headline: (b) => (b.voice_latency.p90_ms === null ? null : `p90 ${fmtMs(b.voice_latency.p90_ms)}`),
    rate: false,
  },
  {
    id: "origin",
    label: "語音自己發起的比例",
    targetLabel: "自己發起 : 回應人 ≤ 1 : 1",
    lines: [{ label: "1 : 1", value: 0.5 }],
    good: (v) => v <= 0.5,
    read: (b) => {
      const { self_started: s, answering: a } = b.voice_origin;
      return { value: s + a === 0 ? null : s / (s + a), n: s + a, unit: "次開口" };
    },
    format: pct,
    headline: (b) => {
      const { self_started: s, answering: a } = b.voice_origin;
      if (s + a === 0) return null;
      return a === 0 ? `${s} : 0` : `${(s / a).toFixed(1)} : 1`;
    },
    rate: true,
  },
];

function dayTime(day: string): number {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

function MetricBlock({ spec, data }: { spec: Spec; data: TurnMetrics }) {
  const whole = spec.read(data.overall);
  const measured = whole.value !== null;
  const times = useMemo(() => data.daily.map((d) => dayTime(d.day)), [data]);
  const values = data.daily.map((d) => spec.read(d).value);
  const head = measured ? (spec.headline?.(data.overall) ?? null) : null;
  const pass = whole.value === null ? null : spec.good(whole.value);
  const hasAny = values.some((v) => v !== null);
  return (
    <ChartBlock
      title={spec.label}
      value={measured ? spec.format(whole.value as number) : "—"}
      aside={
        <>
          目標 {spec.targetLabel}
          {measured ? ` · ${whole.n} ${whole.unit}` : ""}
          {head ? ` · ${head}` : ""}
        </>
      }
      action={pass === null ? undefined : <StatusBadge tone={pass ? "success" : "warning"}>{pass ? "達標" : "未達標"}</StatusBadge>}
    >
      {hasAny ? (
        <TimeChart
          label={`${spec.label}的每日趨勢`}
          times={times}
          fromZero
          domain={spec.rate ? [0, 1] : undefined}
          height={160}
          format={spec.format}
          series={[
            { key: spec.id, label: spec.label, color: "var(--chart-line)", values },
            ...spec.lines.map((l, i) => ({ key: `ref${i}`, label: l.label, color: "var(--chart-quiet)", values: values.map(() => l.value) })),
          ]}
        />
      ) : (
        <ChartEmpty height={160}>這段時間沒有量到</ChartEmpty>
      )}
    </ChartBlock>
  );
}

const OUTCOME_PARTS: { key: keyof TurnMetricsBucket["outcomes"]; label: string; color: string }[] = [
  { key: "sent", label: "有回", color: "var(--chart-1)" },
  { key: "silence", label: "沒開口", color: "var(--chart-3)" },
  { key: "cancelled", label: "取消", color: "var(--chart-2)" },
  { key: "error", label: "出錯", color: "var(--chart-4)" },
];

export const STOP_LABEL: Record<keyof TurnMetricsBucket["followup_stopped"], string> = {
  anti_spam: "發言佔比上限擋下",
  low_score: "分數低於等級的最低分",
  lost_roll: "擲骰沒過",
  floor: "麥克風或場地被拒",
  passed_silent: "交給模型,模型選擇沉默",
  other: "其他(取消、出錯、別的沉默)",
};

function Outcomes({ data }: { data: TurnMetrics }) {
  const parts: Part[] = OUTCOME_PARTS.map((p) => ({ key: p.key, label: p.label, color: p.color, value: data.overall.outcomes[p.key] }));
  return (
    <ChartBlock title="回合怎麼結束" value={String(data.overall.turns)} unit="回合">
      {data.overall.turns === 0 ? <EmptyLine>這段時間沒有回合</EmptyLine> : <SegmentBar label="回合結果占比" parts={parts} />}
    </ChartBlock>
  );
}

function Stopped({ data }: { data: TurnMetrics }) {
  const stopped = data.overall.followup_stopped;
  const items = (Object.keys(STOP_LABEL) as (keyof typeof STOP_LABEL)[])
    .map((k) => ({ key: k, label: STOP_LABEL[k], value: stopped[k] }))
    .sort((a, b) => b.value - a.value);
  const total = items.reduce((n, i) => n + i.value, 0);
  return (
    <ChartBlock title="沒接話的原因" value={String(total)} unit="次沒回">
      {total === 0 ? (
        <EmptyLine>這段時間別人接她的話,她都回了,或沒有人接</EmptyLine>
      ) : (
        <BarList label="沒接話的原因" items={items} />
      )}
    </ChartBlock>
  );
}

/** The six stages come from the monitor's last 15 minutes, not from this window. */
function Stages() {
  const voice = useVoice();
  const sessions = voice.data?.sessions ?? [];
  return (
    <div className="grid min-w-0 gap-3">
      <h3 className="text-[13px] font-medium text-muted-foreground">
        語音延遲各段<span className="ml-2 font-normal text-muted-foreground/80">最近 15 分鐘,她在的語音頻道</span>
      </h3>
      {voice.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : sessions.length === 0 ? (
        <EmptyLine>她現在不在任何語音頻道,沒有量測</EmptyLine>
      ) : (
        sessions.map((s) => (
          <div key={contextShort(s.context)} className="grid gap-1">
            <p className="text-xs text-muted-foreground">{s.label ?? contextShort(s.context)}</p>
            <VoiceLatency e2e={s.latency.e2e} />
          </div>
        ))
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-(--stage-gap) lg:grid-cols-2" aria-busy="true" aria-label="載入中">
      {SPECS.map((s) => (
        <Skeleton key={s.id} className="h-52 w-full" />
      ))}
    </div>
  );
}

export function emptyWindow(data: TurnMetrics): boolean {
  return data.overall.turns === 0;
}

/** §13's participation measures per local day, from the turn log and the gate's decisions. */
export function V4Metrics() {
  const [days, setDays] = useDays();
  const query = useTurnMetrics(days);
  const data = query.data;
  return (
    <section aria-label="參與度指標" className="grid gap-(--stage-gap)">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">參與度(每日)</h2>
        <Segmented label="天數" value={String(days)} onChange={(v) => setDays(Number(v))} options={V4_RANGES.map((r) => ({ value: String(r.days), label: r.label }))} />
      </div>
      {query.isPending ? (
        <Loading />
      ) : !data ? (
        <ErrorLine error={query.error} onRetry={() => void query.refetch()} />
      ) : emptyWindow(data) ? (
        <EmptyLine>這 {data.days} 天沒有回合紀錄,指標要等她開始互動才會出現</EmptyLine>
      ) : (
        <>
          {data.truncated && (
            <p role="status" className="text-xs text-muted-foreground">
              紀錄多到一次讀不完,最早的一天可能不完整
            </p>
          )}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-(--stage-gap) lg:grid-cols-2">
            {SPECS.map((s) => (
              <MetricBlock key={s.id} spec={s} data={data} />
            ))}
            <Outcomes data={data} />
            <Stopped data={data} />
          </div>
        </>
      )}
      <Stages />
    </section>
  );
}
