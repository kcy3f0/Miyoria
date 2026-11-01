import { Link } from "@tanstack/react-router";
import { ArrowRight, Boxes, Radio } from "lucide-react";
import { isNotProvided } from "../api/http";
import type { CostReport } from "../api/planned-types";
import type { ModuleInfo, UsageMap } from "../api/types";
import { useEvents } from "../app/events-store";
import { useCost, useHealth, useModules, useUsage } from "../app/queries";
import { EventFeed, useFreshIds } from "../components/EventFeed";
import { ErrorState, QueryView } from "../components/states";
import { Badge, EmptyState, PageHeader, Panel, Skeleton, SkeletonRows, StateBadge } from "../components/ui";
import { fmtCompact, fmtInt, fmtUsd } from "../lib/format";

const ORDER: Record<string, number> = { failed: 0, degraded: 1, starting: 2, stopping: 3, stopped: 4, running: 5, disabled: 6 };

function StatusStrip() {
  const health = useHealth();
  const modules = useModules();
  const usage = useUsage();
  const cost = useCost();

  const list = modules.data ?? [];
  const enabled = list.filter((m) => m.enabled);
  const running = enabled.filter((m) => m.state === "running").length;
  const failing = list.filter((m) => m.state === "failed" || m.state === "degraded").length;
  const calls = usage.data ? Object.values(usage.data).reduce((n, u) => n + u.calls, 0) : undefined;

  const pending = <Skeleton width="5rem" height="1.1rem" />;

  return (
    <dl className="strip" aria-label="系統狀態">
      <div className="strip__item">
        <dt className="strip__label">Core</dt>
        <dd className="strip__value">
          {health.isPending ? pending : health.isError ? <Badge tone="danger" dot>無回應</Badge> : <span className="mono">{health.data.version}</span>}
        </dd>
      </div>
      <div className="strip__item">
        <dt className="strip__label">子系統</dt>
        <dd className="strip__value">
          {modules.isPending ? (
            pending
          ) : modules.isError ? (
            "—"
          ) : (
            <>
              {running}
              <span className="strip__sub">/ {enabled.length} 執行中</span>
              {failing > 0 && <Badge tone="danger">{failing} 異常</Badge>}
            </>
          )}
        </dd>
      </div>
      <div className="strip__item">
        <dt className="strip__label">今日花費</dt>
        <dd className="strip__value">
          {cost.isPending ? pending : cost.isSuccess ? <CostValue cost={cost.data} /> : <span className="strip__sub">{isNotProvided(cost.error) ? "需要較新的 Core" : "無法取得"}</span>}
        </dd>
      </div>
      <div className="strip__item">
        <dt className="strip__label">LLM 呼叫(自啟動)</dt>
        <dd className="strip__value">
          {usage.isPending ? pending : calls === undefined ? "—" : fmtInt(calls)}
        </dd>
      </div>
    </dl>
  );
}

function CostValue({ cost }: { cost: CostReport }) {
  const tone = cost.state === "ok" ? undefined : cost.state === "degraded" ? "warn" : "danger";
  return (
    <>
      {fmtUsd(cost.today.total_usd)}
      {cost.daily_usd !== null && <span className="strip__sub">/ {fmtUsd(cost.daily_usd)}</span>}
      {tone && <Badge tone={tone}>{cost.state === "degraded" ? "已降級" : "預算用盡"}</Badge>}
    </>
  );
}

function ModulesSummary() {
  const modules = useModules();
  return (
    <Panel
      title="子系統"
      titleId="ov-modules"
      flush
      actions={
        <Link to="/modules" className="btn btn--ghost btn--sm">
          管理
          <ArrowRight aria-hidden />
        </Link>
      }
    >
      <QueryView
        query={modules}
        route="GET /api/modules"
        skeleton={<SkeletonRows count={4} />}
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState icon={Boxes} compact title="沒有任何子系統">Core 沒有註冊模組。檢查 miyoria.toml 的 [modules]。</EmptyState>}
      >
        {(list) => <ModuleRows list={list} />}
      </QueryView>
    </Panel>
  );
}

function ModuleRows({ list }: { list: ModuleInfo[] }) {
  const sorted = [...list].sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || a.id.localeCompare(b.id));
  const shown = sorted.slice(0, 8);
  return (
    <>
      <ul className="rows">
        {shown.map((m) => (
          <li className="row" key={m.id}>
            <div className="row__main">
              <div className="row__title">
                {m.name}
                <span className="faint mono" style={{ fontSize: "var(--fs-xs)" }}>
                  {m.id}
                </span>
              </div>
              {m.reason && <div className="row__meta">{m.reason}</div>}
            </div>
            <StateBadge state={m.state} />
          </li>
        ))}
      </ul>
      {sorted.length > shown.length && (
        <p className="faint" style={{ padding: "var(--s-2) var(--s-4) var(--s-3)", fontSize: "var(--fs-sm)" }}>
          另有 {sorted.length - shown.length} 個子系統,到「子系統」頁查看全部
        </p>
      )}
    </>
  );
}

export function UsageTable({ usage, cost }: { usage: UsageMap; cost?: CostReport }) {
  const rows = Object.entries(usage).sort(([, a], [, b]) => b.calls - a.calls);
  const total = rows.reduce(
    (t, [, u]) => ({
      calls: t.calls + u.calls,
      prompt: t.prompt + u.prompt_tokens,
      cached: t.cached + u.cached_prompt_tokens,
      completion: t.completion + u.completion_tokens,
    }),
    { calls: 0, prompt: 0, cached: 0, completion: 0 },
  );
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">模型</th>
            <th scope="col" className="r">呼叫</th>
            <th scope="col" className="r">輸入 tokens</th>
            <th scope="col" className="r">快取命中</th>
            <th scope="col" className="r">輸出 tokens</th>
            <th scope="col" className="r">今日花費</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([model, u]) => {
            const today = cost?.today.models[model];
            const hit = u.prompt_tokens > 0 ? u.cached_prompt_tokens / u.prompt_tokens : 0;
            return (
              <tr key={model}>
                <td className="mono" style={{ fontSize: "var(--fs-sm)", overflowWrap: "anywhere" }}>
                  {model}
                </td>
                <td className="r">{fmtInt(u.calls)}</td>
                <td className="r">{fmtCompact(u.prompt_tokens)}</td>
                <td className="r">
                  {fmtCompact(u.cached_prompt_tokens)}
                  <span className="faint"> · {Math.round(hit * 100)}%</span>
                </td>
                <td className="r">{fmtCompact(u.completion_tokens)}</td>
                <td className="r">{today ? fmtUsd(today.cost_usd) : <span className="faint">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
        {rows.length > 1 && (
          <tfoot>
            <tr>
              <td>合計</td>
              <td className="r">{fmtInt(total.calls)}</td>
              <td className="r">{fmtCompact(total.prompt)}</td>
              <td className="r">{fmtCompact(total.cached)}</td>
              <td className="r">{fmtCompact(total.completion)}</td>
              <td className="r">{cost ? fmtUsd(cost.today.total_usd) : <span className="faint">—</span>}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function UsagePanel() {
  const usage = useUsage();
  const cost = useCost();
  return (
    <Panel title="LLM 用量" titleId="ov-usage" flush actions={<span className="faint" style={{ fontSize: "var(--fs-xs)" }}>tokens 自 Core 啟動起累計</span>}>
      <QueryView
        query={usage}
        route="GET /api/llm/usage"
        skeleton={<SkeletonRows count={3} />}
        isEmpty={(d) => Object.keys(d).length === 0}
        empty={
          <EmptyState compact title="還沒有任何 LLM 呼叫">
            DeepSeek-chan 還沒開口……才、才不是在等你跟她說話。
          </EmptyState>
        }
      >
        {(data) => <UsageTable usage={data} cost={cost.data} />}
      </QueryView>
    </Panel>
  );
}

function LiveTicker() {
  const { events, status } = useEvents();
  const shown = events.slice(0, 40);
  const fresh = useFreshIds(shown);
  return (
    <Panel
      title={
        <>
          <Radio aria-hidden style={{ width: "1rem", height: "1rem", color: "var(--c-accent)" }} />
          即時事件
        </>
      }
      titleId="ov-live"
      flush
      actions={
        <Link to="/events" className="btn btn--ghost btn--sm">
          全部
          <ArrowRight aria-hidden />
        </Link>
      }
    >
      <div style={{ height: "32rem", overflowY: "auto" }}>
        {status.state === "closed" && status.error ? (
          <ErrorState error={new Error(status.error)} compact />
        ) : shown.length === 0 ? (
          <EmptyState icon={Radio} compact title={status.state === "open" ? "等待事件中" : "連線中…"}>
            有人在 Discord 說話、模組狀態改變,都會即時出現在這裡。
          </EmptyState>
        ) : (
          <EventFeed events={shown} compact freshIds={fresh} label="最新事件" />
        )}
      </div>
    </Panel>
  );
}

export function OverviewPage() {
  return (
    <div className="page">
      <PageHeader title="總覽" description="Core 健康度、子系統狀態、LLM 用量與即時事件。" />
      <StatusStrip />
      <div className="grid-main-side">
        <div className="stack">
          <ModulesSummary />
          <UsagePanel />
        </div>
        <LiveTicker />
      </div>
    </div>
  );
}
