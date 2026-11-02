import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { CostReport, UsageMap } from "@/api/types";
import { useCost, useExtensions, useMcpServers, useModules, useQueue, useUsage } from "@/app/queries";
import { Page, PageHeader } from "@/components/page";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Dot, STATE_LABEL, type Tone } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtCompact, fmtInt, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

function Stat({ label, children, pending }: { label: string; children: ReactNode; pending?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 bg-card px-5 py-4">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="flex min-h-7 items-baseline gap-1.5 text-xl font-semibold tracking-tight tabular-nums">
        {pending ? <Skeleton className="h-5 w-20" /> : children}
      </dd>
    </div>
  );
}

const Of = ({ children }: { children: ReactNode }) => (
  <span className="text-sm font-normal text-muted-foreground">{children}</span>
);

function StatRow() {
  const modules = useModules();
  const usage = useUsage();
  const cost = useCost();
  const queue = useQueue();

  const list = modules.data ?? [];
  const enabled = list.filter((m) => m.enabled);
  const running = enabled.filter((m) => m.state === "running").length;
  const calls = usage.data ? Object.values(usage.data).reduce((n, u) => n + u.calls, 0) : null;
  const pending = queue.data?.items.filter((i) => i.state === "pending" || i.state === "active").length;

  return (
    <dl aria-label="狀態" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-4">
      <Stat label="子系統" pending={modules.isPending}>
        {modules.isError ? "—" : (
          <>
            {running}
            <Of>/ {enabled.length}</Of>
          </>
        )}
      </Stat>
      <Stat label="今日花費" pending={cost.isPending}>
        {cost.isSuccess ? (
          <>
            {fmtUsd(cost.data.today.total_usd)}
            {cost.data.daily_usd !== null && <Of>/ {fmtUsd(cost.data.daily_usd)}</Of>}
          </>
        ) : (
          "—"
        )}
      </Stat>
      <Stat label="LLM 呼叫" pending={usage.isPending}>
        {calls === null ? "—" : fmtInt(calls)}
      </Stat>
      <Stat label="佇列" pending={queue.isPending}>
        {pending === undefined ? "—" : (
          <>
            {pending}
            {queue.data?.paused && <Of>已暫停</Of>}
          </>
        )}
      </Stat>
    </dl>
  );
}

interface Issue {
  key: string;
  tone: Tone;
  title: string;
  detail?: string | null;
  to: ReactNode;
}

function budgetIssue(cost: CostReport): Issue | null {
  if (cost.state === "ok") return null;
  const limit = cost.daily_usd !== null ? ` / ${fmtUsd(cost.daily_usd)}` : "";
  return {
    key: "budget",
    tone: cost.state === "exhausted" ? "danger" : "warning",
    title: cost.state === "exhausted" ? "LLM 預算用盡" : "LLM 預算已降級",
    detail: `${fmtUsd(cost.today.total_usd)}${limit}`,
    to: null,
  };
}

function AttentionCard() {
  const modules = useModules();
  const cost = useCost();
  const mcp = useMcpServers();
  const extensions = useExtensions();

  const issues: Issue[] = [];
  for (const m of modules.data ?? []) {
    const bad = m.state === "failed" || m.state === "degraded" || (m.enabled && m.state === "stopped");
    if (!bad) continue;
    issues.push({
      key: `m:${m.id}`,
      tone: m.state === "failed" ? "danger" : "warning",
      title: `${m.name} ${STATE_LABEL[m.state]}`,
      detail: m.reason,
      to: (
        <Link to="/system" search={{ tab: "modules", q: m.id }} aria-label={`查看 ${m.name}`}>
          <ChevronRight className="size-4" />
        </Link>
      ),
    });
  }
  for (const s of mcp.data ?? []) {
    if (s.state !== "failed") continue;
    issues.push({
      key: `mcp:${s.name}`,
      tone: "danger",
      title: `MCP ${s.name} 連線失敗`,
      detail: s.error,
      to: (
        <Link to="/system" search={{ tab: "mcp", q: s.name }} aria-label={`查看 ${s.name}`}>
          <ChevronRight className="size-4" />
        </Link>
      ),
    });
  }
  for (const x of extensions.data ?? []) {
    if (x.state !== "failed" && x.state !== "degraded") continue;
    issues.push({
      key: `ext:${x.id}`,
      tone: x.state === "failed" ? "danger" : "warning",
      title: `${x.name} ${STATE_LABEL[x.state]}`,
      detail: x.reason,
      to: (
        <Link to="/system" search={{ tab: "extensions", q: x.id }} aria-label={`查看 ${x.name}`}>
          <ChevronRight className="size-4" />
        </Link>
      ),
    });
  }
  if (cost.data) {
    const b = budgetIssue(cost.data);
    if (b) issues.unshift(b);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>需要注意</CardTitle>
        {issues.length > 0 && <span className="text-sm text-muted-foreground tabular-nums">{issues.length}</span>}
      </CardHeader>
      {modules.isPending ? (
        <SkeletonRows count={2} />
      ) : issues.length === 0 ? (
        <EmptyLine className="py-8">一切正常</EmptyLine>
      ) : (
        <ul className="divide-y">
          {issues.map((i) => (
            <li key={i.key} className="flex items-center gap-3 px-4 py-3">
              <Dot tone={i.tone} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{i.title}</p>
                {i.detail && <p className="truncate text-[13px] text-muted-foreground" title={i.detail}>{i.detail}</p>}
              </div>
              {i.to && (
                <span className="text-muted-foreground [&_a]:flex [&_a]:size-8 [&_a]:items-center [&_a]:justify-center [&_a]:rounded-md hover:[&_a]:bg-accent hover:[&_a]:text-foreground">
                  {i.to}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
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
  const r = "text-right";
  return (
    <Table aria-label="LLM 用量">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>模型</TableHead>
          <TableHead className={r}>呼叫</TableHead>
          <TableHead className={r}>輸入</TableHead>
          <TableHead className={r}>快取命中</TableHead>
          <TableHead className={r}>輸出</TableHead>
          <TableHead className={r}>今日</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([model, u]) => {
          const today = cost?.today.models[model];
          const hit = u.prompt_tokens > 0 ? u.cached_prompt_tokens / u.prompt_tokens : 0;
          return (
            <TableRow key={model}>
              <TableCell className="max-w-64 break-all font-mono text-[13px]">{model}</TableCell>
              <TableCell className={r}>{fmtInt(u.calls)}</TableCell>
              <TableCell className={r}>{fmtCompact(u.prompt_tokens)}</TableCell>
              <TableCell className={r}>
                {fmtCompact(u.cached_prompt_tokens)}
                <span className="ml-1.5 text-muted-foreground">{Math.round(hit * 100)}%</span>
              </TableCell>
              <TableCell className={r}>{fmtCompact(u.completion_tokens)}</TableCell>
              <TableCell className={cn(r, !today && "text-muted-foreground")}>{today ? fmtUsd(today.cost_usd) : "—"}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
      {rows.length > 1 && (
        <TableFooter>
          <TableRow className="hover:bg-transparent">
            <TableCell>合計</TableCell>
            <TableCell className={r}>{fmtInt(total.calls)}</TableCell>
            <TableCell className={r}>{fmtCompact(total.prompt)}</TableCell>
            <TableCell className={r}>{fmtCompact(total.cached)}</TableCell>
            <TableCell className={r}>{fmtCompact(total.completion)}</TableCell>
            <TableCell className={r}>{cost ? fmtUsd(cost.today.total_usd) : "—"}</TableCell>
          </TableRow>
        </TableFooter>
      )}
    </Table>
  );
}

function UsageCard() {
  const usage = useUsage();
  const cost = useCost();
  return (
    <Card>
      <CardHeader>
        <CardTitle>LLM 用量</CardTitle>
      </CardHeader>
      <QueryView query={usage} isEmpty={(d) => Object.keys(d).length === 0} empty="還沒有 LLM 呼叫" skeleton={<SkeletonRows count={3} />}>
        {(data) => <UsageTable usage={data} cost={cost.data} />}
      </QueryView>
    </Card>
  );
}

export function OverviewPage() {
  return (
    <Page>
      <PageHeader title="總覽" />
      <StatRow />
      <AttentionCard />
      <UsageCard />
    </Page>
  );
}
