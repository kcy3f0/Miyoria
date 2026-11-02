import type { ModuleStateKind } from "@/api/types";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger";

const DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground/60",
  brand: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

export function Dot({ tone = "neutral", pulse, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", DOT[tone])} />}
      <span className={cn("relative size-2 rounded-full", DOT[tone])} />
    </span>
  );
}

const BADGE: Record<Tone, BadgeVariant> = {
  neutral: "outline",
  brand: "brand",
  success: "success",
  warning: "warning",
  danger: "destructive",
};

/** A badge with a state dot. */
export function StatusBadge({ tone, pulse, children }: { tone: Tone; pulse?: boolean; children: React.ReactNode }) {
  return (
    <Badge variant={BADGE[tone]}>
      <Dot tone={tone} pulse={pulse} className="size-1.5 [&>span]:size-1.5" />
      {children}
    </Badge>
  );
}

export const STATE_LABEL: Record<ModuleStateKind, string> = {
  running: "執行中",
  degraded: "降級",
  starting: "啟動中",
  stopping: "停止中",
  stopped: "已停止",
  failed: "失敗",
  disabled: "已停用",
};

export const STATE_TONE: Record<ModuleStateKind, Tone> = {
  running: "success",
  degraded: "warning",
  starting: "warning",
  stopping: "warning",
  stopped: "neutral",
  failed: "danger",
  disabled: "neutral",
};

export function StateBadge({ state }: { state: ModuleStateKind }) {
  return (
    <StatusBadge tone={STATE_TONE[state] ?? "neutral"} pulse={state === "starting" || state === "stopping"}>
      {STATE_LABEL[state] ?? state}
    </StatusBadge>
  );
}

/** 0..1 bar. */
export function Meter({ value, tone = "neutral", label }: { value: number; tone?: "neutral" | "success" | "brand"; label: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(v.toFixed(2))}
      className="h-1.5 w-full min-w-12 overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn("h-full rounded-full", tone === "success" ? "bg-success" : tone === "brand" ? "bg-brand" : "bg-foreground/70")}
        style={{ width: `${v * 100}%` }}
      />
    </div>
  );
}

/** -100..100 bar from a center line. */
export function Bipolar({ value, label }: { value: number; label: string }) {
  const v = Math.max(-100, Math.min(100, value));
  const half = Math.abs(v) / 2;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      className="relative h-1.5 w-full min-w-16 overflow-hidden rounded-full bg-muted"
    >
      <span className="absolute inset-y-0 left-1/2 w-px bg-foreground/30" />
      <span
        className={cn("absolute inset-y-0", v >= 0 ? "bg-brand" : "bg-destructive")}
        style={v >= 0 ? { left: "50%", width: `${half}%` } : { right: "50%", width: `${half}%` }}
      />
    </div>
  );
}
