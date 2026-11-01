import { Loader2, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { ModuleStateKind } from "../api/types";
import type { Tone } from "../lib/events";

type ButtonVariant = "default" | "primary" | "danger" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: LucideIcon;
  /** Icon-only button; `label` becomes the accessible name. */
  iconOnly?: boolean;
  label?: string;
  busy?: boolean;
}

export function Button({
  variant = "default",
  size = "md",
  icon: Icon,
  iconOnly,
  label,
  busy,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = [
    "btn",
    variant !== "default" && `btn--${variant}`,
    size === "sm" && "btn--sm",
    iconOnly && "btn--icon",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const ShownIcon = busy ? Loader2 : Icon;
  return (
    <button
      type={type}
      className={cls}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : rest.title}
      {...rest}
    >
      {ShownIcon && <ShownIcon aria-hidden className={busy ? "spin" : undefined} />}
      {!iconOnly && (children ?? label)}
    </button>
  );
}

export function Badge({ tone = "neutral", dot, pulse, children }: { tone?: Tone; dot?: boolean; pulse?: boolean; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone} data-pulse={pulse || undefined}>
      {dot && <span className="badge__dot" aria-hidden />}
      {children}
    </span>
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

export function stateTone(state: ModuleStateKind): Tone {
  switch (state) {
    case "running":
      return "ok";
    case "degraded":
    case "starting":
    case "stopping":
      return "warn";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export function StateBadge({ state }: { state: ModuleStateKind }) {
  return (
    <Badge tone={stateTone(state)} dot pulse={state === "starting" || state === "stopping"}>
      {STATE_LABEL[state] ?? state}
    </Badge>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {back}
        <h1 className="page-head__title">{title}</h1>
        {description && <p className="page-head__desc">{description}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  actions,
  children,
  flush,
  className,
  titleId,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  titleId?: string;
}) {
  return (
    <section className={["panel", className].filter(Boolean).join(" ")} aria-labelledby={title ? titleId : undefined}>
      {(title || actions) && (
        <div className="panel__head">
          {title && (
            <h2 className="panel__title" id={titleId}>
              {title}
            </h2>
          )}
          {actions}
        </div>
      )}
      <div className={flush ? "panel__body panel__body--flush" : "panel__body"}>{children}</div>
    </section>
  );
}

export function Skeleton({ width = "100%", height }: { width?: string; height?: string }) {
  return <span className="skeleton" style={{ width, height }} aria-hidden />;
}

/** Placeholder rows with the same height as real list rows (no layout shift). */
export function SkeletonRows({ count = 5, label = "載入中" }: { count?: number; label?: string }) {
  return (
    <div role="status" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <Skeleton width={`${38 + ((i * 17) % 30)}%`} />
          <Skeleton width={`${60 + ((i * 13) % 30)}%`} height="0.7rem" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  actions,
  compact,
  tone,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  tone?: Tone;
}) {
  return (
    <div className={compact ? "state state--compact" : "state"} data-tone={tone}>
      {Icon && <Icon className="state__icon" aria-hidden />}
      <p className="state__title">{title}</p>
      {children && <div className="state__text">{children}</div>}
      {actions && <div className="state__actions">{actions}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field__error" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : (
        hint && (
          <p className="field__hint" id={`${htmlFor}-hint`}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  label,
}: {
  name: string;
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label className="seg__item" key={o.value}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>
            {o.label}
            {o.count !== undefined && <span className="seg__count">{o.count}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

export function Meter({ value, tone, label }: { value: number; tone?: Tone; label: string }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div className="meter" data-tone={tone} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} aria-label={label}>
      <div className="meter__fill" style={{ width: `${pct * 100}%` }} />
    </div>
  );
}

/** -100..100 bar centered at zero. */
export function Bipolar({ value, label }: { value: number; label: string }) {
  const v = Math.max(-100, Math.min(100, value));
  const width = `${Math.abs(v) / 2}%`;
  const style = v >= 0 ? { left: "50%", width, background: "var(--c-ok)" } : { right: "50%", width, background: "var(--c-danger)" };
  return (
    <div className="bipolar" role="meter" aria-valuemin={-100} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-label={label}>
      <div className="bipolar__fill" style={style} />
    </div>
  );
}
