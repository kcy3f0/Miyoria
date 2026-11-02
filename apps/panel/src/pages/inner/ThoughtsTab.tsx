import { Check, X } from "lucide-react";
import { type ReactNode, useId } from "react";
import type { MindView, PendingApproval, Thought, ThoughtIntent } from "@/api/types";
import { useApprovals, useMind, useMindMutations, useThoughts } from "@/app/queries";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { StatusBadge, type Tone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { INTENT_LABEL, INTENT_TONE, STAGE_LABEL, TRIGGER_LABEL } from "./labels";

function When({ at }: { at: string | null }) {
  if (!at) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={at} title={fmtDateTime(at)} className="whitespace-nowrap">
      {fmtRelative(at)}
    </time>
  );
}

function stateOf(m: MindView): { tone: Tone; label: string } {
  if (m.paused) return { tone: "warning", label: "已暫停" };
  if (!m.running) return { tone: "neutral", label: "心智迴圈未啟動" };
  if (m.stats?.idle_reason === "budget exhausted") return { tone: "danger", label: "額度用完" };
  if (!m.accepting) return { tone: "neutral", label: "休息中" };
  return { tone: "success", label: "運作中" };
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-card px-4 py-3">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate tabular-nums">{children}</dd>
    </div>
  );
}

function AutonomyCard() {
  const mind = useMind();
  const { pause } = useMindMutations();
  const canWrite = useCanWrite();
  const id = useId();
  const m = mind.data;
  const state = m ? stateOf(m) : null;
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>自主行動</CardTitle>
        {state && <StatusBadge tone={state.tone}>{state.label}</StatusBadge>}
        {m && (
          <CardAction>
            <Label htmlFor={`${id}-pause`} className="font-normal text-muted-foreground">
              暫停
            </Label>
            <Switch
              id={`${id}-pause`}
              checked={m.paused}
              disabled={!canWrite || pause.isPending}
              title={!canWrite ? READ_ONLY_HINT : undefined}
              onCheckedChange={(p) =>
                pause.mutate(p, {
                  onSuccess: () => notify.ok(p ? "已暫停她的自主行動" : "已恢復她的自主行動"),
                  onError: (e) => notify.error(e),
                })
              }
            />
          </CardAction>
        )}
      </CardHeader>
      <QueryView query={mind} skeleton={<SkeletonRows count={1} />}>
        {(v) => (
          <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4" aria-label="心智迴圈">
            <Fact label="這小時">
              {v.stats ? `${v.stats.calls_last_hour} / ${v.stats.max_calls_per_hour}` : "—"}
            </Fact>
            <Fact label="token">{v.stats ? v.stats.tokens_total.toLocaleString("zh-TW") : "—"}</Fact>
            <Fact label="上次想">
              <When at={v.stats?.last_at ?? null} />
            </Fact>
            <Fact label="下次心跳">
              <When at={v.stats?.next_heartbeat_at ?? null} />
            </Fact>
          </dl>
        )}
      </QueryView>
    </Card>
  );
}

function ApprovalRow({ a }: { a: PendingApproval }) {
  const { answer } = useMindMutations();
  const send = (approved: boolean) =>
    answer.mutate(
      { id: a.id, approved },
      {
        onSuccess: () => notify.ok(approved ? "已允許，她會去做" : "已拒絕"),
        onError: (e) => notify.error(e, approved ? "允許失敗" : "拒絕失敗"),
      },
    );
  const busy = answer.isPending && answer.variables?.id === a.id;
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="font-medium">{a.summary}</div>
        <div className="font-mono text-xs text-muted-foreground">{a.capability}</div>
      </TableCell>
      <TableCell className="hidden align-top font-mono text-xs md:table-cell">{a.principal}</TableCell>
      <TableCell className="max-w-[40ch] align-top">{a.why ?? "—"}</TableCell>
      <TableCell className="hidden max-w-[40ch] align-top text-muted-foreground lg:table-cell">
        {a.review || "—"}
      </TableCell>
      <TableCell className="align-top text-muted-foreground">
        <When at={a.expires_at} />
      </TableCell>
      <TableCell className="align-top">
        <div className="flex justify-end gap-2">
          <Button size="sm" writes busy={busy && answer.variables?.approved === true} onClick={() => send(true)}>
            <Check />
            允許
          </Button>
          <Button size="sm" variant="outline" writes disabled={busy} onClick={() => send(false)}>
            <X />
            拒絕
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function ApprovalsCard() {
  const approvals = useApprovals();
  const n = approvals.data?.length ?? 0;
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>
          等待確認
          {n > 0 && <span className="font-normal text-warning tabular-nums">{n}</span>}
        </CardTitle>
      </CardHeader>
      <QueryView query={approvals} skeleton={<SkeletonRows count={1} />}>
        {(list) =>
          list.length === 0 ? (
            <EmptyLine className="py-6">沒有等待確認的動作</EmptyLine>
          ) : (
            <Table aria-label="等待確認">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>動作</TableHead>
                  <TableHead className="hidden md:table-cell">發起</TableHead>
                  <TableHead>她的理由</TableHead>
                  <TableHead className="hidden lg:table-cell">審核意見</TableHead>
                  <TableHead className="w-24">期限</TableHead>
                  <TableHead className="w-44">
                    <span className="sr-only">決定</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((a) => (
                  <ApprovalRow key={a.id} a={a} />
                ))}
              </TableBody>
            </Table>
          )
        }
      </QueryView>
    </Card>
  );
}

function IntentLine({ intent }: { intent: ThoughtIntent }) {
  return (
    <li className="grid gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge tone={INTENT_TONE[intent.status]}>{INTENT_LABEL[intent.status]}</StatusBadge>
        <code className="font-mono text-xs">{intent.capability}</code>
        {intent.context && <span className="text-xs text-muted-foreground">{contextShort(intent.context)}</span>}
        {intent.why && <span className="min-w-0 text-[13px]">{intent.why}</span>}
      </div>
      {intent.detail && intent.status !== "started" && (
        <div className="font-mono text-xs text-muted-foreground">{intent.detail}</div>
      )}
      {intent.decisions.length > 0 && (
        <ul className="grid gap-0.5" aria-label="閘門決定">
          {intent.decisions.map((d) => (
            <li key={`${d.at}-${d.capability}`} className="font-mono text-xs text-muted-foreground">
              <span className={d.allowed ? "text-success" : "text-destructive"}>{d.allowed ? "放行" : "擋下"}</span>{" "}
              {d.capability} · {STAGE_LABEL[d.stage] ?? d.stage} · {d.reason}
            </li>
          ))}
        </ul>
      )}
      {intent.said && (
        <p className="text-[13px] leading-relaxed">
          <span className="mr-1.5 font-medium text-brand">她</span>
          {intent.said}
        </p>
      )}
    </li>
  );
}

function ThoughtItem({ t }: { t: Thought }) {
  const kinds = [...new Set(t.triggers.map((x) => x.kind))];
  const detail = t.triggers.find((x) => x.detail.trim() !== "")?.detail;
  return (
    <li className="grid gap-x-6 gap-y-2 px-4 py-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-muted-foreground sm:flex-col sm:gap-1">
        <When at={t.at} />
        <span>{kinds.map((k) => TRIGGER_LABEL[k] ?? k).join("、")}</span>
      </div>
      <div className="grid min-w-0 gap-2.5">
        {detail && <p className="text-[13px] text-muted-foreground">{detail}</p>}
        {t.error ? (
          <p className="font-mono text-xs text-destructive">{t.error}</p>
        ) : (
          <p className="max-w-[70ch] leading-relaxed">{t.thought || "—"}</p>
        )}
        {t.changes.length > 0 && <p className="text-[13px] text-muted-foreground">{t.changes.join(" · ")}</p>}
        {t.intents.length > 0 && (
          <ul className="grid gap-3 border-t pt-2.5" aria-label="意圖">
            {t.intents.map((i) => (
              <IntentLine key={i.id} intent={i} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function TimelineCard() {
  const thoughts = useThoughts();
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>
          想法
          {thoughts.data && thoughts.data.length > 0 && (
            <span className="font-normal text-muted-foreground tabular-nums">{thoughts.data.length}</span>
          )}
        </CardTitle>
      </CardHeader>
      <QueryView query={thoughts} skeleton={<SkeletonRows count={4} />}>
        {(list) =>
          list.length === 0 ? (
            <EmptyLine className="py-8">還沒有想法</EmptyLine>
          ) : (
            <ol className="divide-y" aria-label="想法時間軸">
              {list.map((t) => (
                <ThoughtItem key={t.id} t={t} />
              ))}
            </ol>
          )
        }
      </QueryView>
    </Card>
  );
}

export function ThoughtsTab() {
  return (
    <div className="grid gap-6">
      <AutonomyCard />
      <ApprovalsCard />
      <TimelineCard />
    </div>
  );
}
