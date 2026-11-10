import { useMemo } from "react";
import { useFactEvents } from "@/app/queries";
import { ModuleQuery } from "@/components/module-query";
import { EmptyLine } from "@/components/query-state";
import { Dot, StatusBadge } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import { isRunning, PARTY_SOURCES, type PartySession, partySessions } from "@/lib/party";

const RECENT = 6;

/** First line of a note: the one that says what happened. */
const headline = (text: string): string => text.split("\n", 1)[0] ?? text;

function Running({ s, now }: { s: PartySession; now: number }) {
  const last = s.lines[s.lines.length - 1];
  return (
    <li className="grid gap-1 border-b border-line-soft py-(--row-y) last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Dot tone="brand" pulse />
        <span className="font-medium">{s.title}</span>
        <span className="text-muted-foreground">{s.context ? contextShort(s.context) : "—"}</span>
        <time dateTime={s.startedAt} title={fmtDateTime(s.startedAt)} className="ml-auto text-[13px] text-muted-foreground">
          {fmtRelative(s.startedAt, now)}開始
        </time>
      </div>
      {last && <p className="pl-5 text-[13px] break-words text-muted-foreground">{headline(last.summary)}</p>}
    </li>
  );
}

function Finished({ s, now }: { s: PartySession; now: number }) {
  return (
    <li className="grid gap-1 border-b border-line-soft py-(--row-y) last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">{s.title}</span>
        <span className="text-muted-foreground">{s.context ? contextShort(s.context) : "—"}</span>
        <time dateTime={s.lastAt} title={fmtDateTime(s.lastAt)} className="ml-auto text-[13px] text-muted-foreground">
          {fmtRelative(s.lastAt, now)}
        </time>
      </div>
      <p className="text-[13px] break-words whitespace-pre-line text-muted-foreground">{s.result}</p>
    </li>
  );
}

/** The party game running in each voice channel now, and the ones that ended lately. */
export function PartyCard() {
  const q = useFactEvents({ kind: ["observation"], source: PARTY_SOURCES, order: "desc", limit: 300 }, 10_000);
  const now = q.dataUpdatedAt > 0 ? q.dataUpdatedAt : Date.now();
  const sessions = useMemo(() => partySessions(q.data ?? []), [q.data]);
  const running = sessions.filter((s) => isRunning(s, now));
  const done = sessions.filter((s) => s.result !== null).slice(0, RECENT);
  return (
    <Card aria-label="派對遊戲">
      <CardHeader>
        <CardTitle>派對遊戲</CardTitle>
        {running.length > 0 && <StatusBadge tone="brand" pulse>進行中 {running.length}</StatusBadge>}
      </CardHeader>
      <ModuleQuery query={q} module="事件紀錄(facts 模組)" skeleton={<Skeleton className="h-16 w-full" aria-busy="true" aria-label="載入中" />}>
        {() => (
          <div className="grid gap-4">
            {running.length === 0 ? <EmptyLine className="py-1">現在沒有人在玩</EmptyLine> : <ul aria-label="進行中的遊戲">{running.map((s) => <Running key={s.id} s={s} now={now} />)}</ul>}
            {done.length > 0 && (
              <section aria-label="最近的結果" className="grid gap-1">
                <h3 className="text-[13px] font-medium text-muted-foreground">最近的結果</h3>
                <ul>{done.map((s) => <Finished key={s.id} s={s} now={now} />)}</ul>
              </section>
            )}
          </div>
        )}
      </ModuleQuery>
    </Card>
  );
}
