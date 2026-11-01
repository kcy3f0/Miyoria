import { ChevronDown, ChevronRight, Search, Split } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { ContextKey, DecisionRecord } from "../api/types";
import { useDecisions } from "../app/queries";
import { QueryView } from "../components/states";
import { Badge, EmptyState, Meter, PageHeader, Panel, Segmented } from "../components/ui";
import { contextKeyString, contextKindLabel, contextShort, fmtDateTime, fmtRelative, fmtScore } from "../lib/format";

type Outcome = "all" | "respond" | "ignore";

const LIMITS = [50, 200, 1000] as const;

function DecisionRow({ record }: { record: DecisionRecord }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const t = record.trace;
  return (
    <li style={{ borderBottom: "1px solid var(--c-line)" }}>
      <button
        type="button"
        className="row row--button"
        style={{ borderBottom: 0 }}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown aria-hidden size={16} className="faint" /> : <ChevronRight aria-hidden size={16} className="faint" />}
        <div className="row__main">
          <div className="row__title">
            <Badge tone={t.respond ? "accent" : "neutral"}>{t.respond ? "回應" : "略過"}</Badge>
            <span style={{ fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
              {t.reasons[0] ?? <span className="faint">沒有記錄原因</span>}
            </span>
          </div>
          <div className="row__meta">
            {contextShort(t.context)} · {t.context.platform}
            {t.reasons.length > 1 && ` · 另 ${t.reasons.length - 1} 條原因`}
          </div>
        </div>
        <div className="row__aside">
          <div style={{ width: "4.5rem" }}>
            <Meter value={t.score} tone={t.respond ? "accent" : "neutral"} label="分數" />
          </div>
          <span className="num" style={{ width: "2.75rem", textAlign: "right" }}>
            {fmtScore(t.score)}
          </span>
          <time className="faint" dateTime={record.ts} title={fmtDateTime(record.ts)} style={{ fontSize: "var(--fs-sm)", width: "5.5rem", textAlign: "right" }}>
            {fmtRelative(record.ts)}
          </time>
        </div>
      </button>
      {open && (
        <div id={id} style={{ padding: "0 var(--s-4) var(--s-4) calc(var(--s-4) + 1rem + var(--s-3))", display: "grid", gap: "var(--s-4)" }}>
          <div>
            <p className="field__label" style={{ marginBottom: "var(--s-1)" }}>
              原因
            </p>
            {t.reasons.length ? (
              <ol className="reasons">
                {t.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ol>
            ) : (
              <p className="faint">沒有記錄原因。</p>
            )}
          </div>
          <dl className="dl">
            <dt>情境</dt>
            <dd className="mono">{contextKeyString(t.context)}</dd>
            <dt>類型</dt>
            <dd>{contextKindLabel(t.context)}</dd>
            <dt>伺服器</dt>
            <dd className="mono">{t.context.scope ?? "—(私訊)"}</dd>
            <dt>頻道</dt>
            <dd className="mono">{t.context.channel}</dd>
            <dt>回合</dt>
            <dd className="mono">{t.turn}</dd>
            <dt>時間</dt>
            <dd>{fmtDateTime(record.ts)}</dd>
          </dl>
        </div>
      )}
    </li>
  );
}

export function DecisionsPage() {
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [limit, setLimit] = useState<(typeof LIMITS)[number]>(50);
  const [contextKey, setContextKey] = useState("");
  const [q, setQ] = useState("");

  // Contexts seen so far, so the server-side filter can be picked from a list.
  const [knownContexts, setKnownContexts] = useState<Map<string, ContextKey>>(new Map());
  const context = contextKey ? knownContexts.get(contextKey) : undefined;
  const decisions = useDecisions({ limit, context });

  const data = decisions.data;
  useEffect(() => {
    if (!data) return;
    setKnownContexts((prev) => {
      let next: Map<string, ContextKey> | undefined;
      for (const d of data) {
        const k = contextKeyString(d.trace.context);
        if (!prev.has(k) && !next?.has(k)) {
          next ??= new Map(prev);
          next.set(k, d.trace.context);
        }
      }
      return next ?? prev;
    });
  }, [data]);

  const counts = useMemo(() => {
    const list = data ?? [];
    const respond = list.filter((d) => d.trace.respond).length;
    return { all: list.length, respond, ignore: list.length - respond };
  }, [data]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((d) => {
      if (outcome === "respond" && !d.trace.respond) return false;
      if (outcome === "ignore" && d.trace.respond) return false;
      return !needle || d.trace.reasons.some((r) => r.toLowerCase().includes(needle));
    });
  }, [data, outcome, q]);

  return (
    <div className="page">
      <PageHeader title="決策追蹤" description="每個回合她為什麼回應、為什麼沉默:注意力分數與判斷原因。" />

      <div className="toolbar">
        <Segmented<Outcome>
          name="outcome"
          label="結果"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: "all", label: "全部", count: counts.all },
            { value: "respond", label: "回應", count: counts.respond },
            { value: "ignore", label: "略過", count: counts.ignore },
          ]}
        />
        <div className="search">
          <Search aria-hidden />
          <input className="input" type="search" placeholder="搜尋原因" aria-label="搜尋原因" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="select" style={{ width: "auto", maxWidth: "16rem" }} aria-label="情境" value={contextKey} onChange={(e) => setContextKey(e.target.value)}>
          <option value="">所有情境</option>
          {[...knownContexts.entries()].map(([k, c]) => (
            <option key={k} value={k}>
              {contextShort(c)} · {c.platform}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: "auto" }} aria-label="筆數" value={limit} onChange={(e) => setLimit(Number(e.target.value) as (typeof LIMITS)[number])}>
          {LIMITS.map((l) => (
            <option key={l} value={l}>
              最近 {l} 筆
            </option>
          ))}
        </select>
      </div>

      <Panel flush>
        <QueryView
          query={decisions}
          route="GET /api/decisions"
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState icon={Split} title="還沒有任何決策">
              有人在她看得到的頻道說話後,每次「要不要回」的判斷都會記在這裡。
            </EmptyState>
          }
        >
          {() =>
            visible.length === 0 ? (
              <EmptyState compact title="沒有符合的決策">換個篩選條件看看。</EmptyState>
            ) : (
              <ul className="rows">
                {visible.map((d) => (
                  <DecisionRow key={d.id} record={d} />
                ))}
              </ul>
            )
          }
        </QueryView>
      </Panel>
    </div>
  );
}
