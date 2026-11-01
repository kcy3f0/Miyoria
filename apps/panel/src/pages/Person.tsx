import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Ban, Save, UserRound } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { describeError } from "../api/http";
import type { PersonDetail, RelationshipDelta } from "../api/planned-types";
import { usePerson, useUpdatePerson } from "../app/queries";
import { QueryView } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Bipolar, Button, EmptyState, Field, Meter, PageHeader, Panel, SkeletonRows } from "../components/ui";
import { accountString, fmtDateTime, fmtRelative } from "../lib/format";

/** Affinity over time, -100..100 with a zero line. */
export function AffinityChart({ history }: { history: RelationshipDelta[] }) {
  if (history.length < 2) {
    return <p className="faint" style={{ fontSize: "var(--fs-sm)" }}>變化紀錄不足,還畫不出曲線。</p>;
  }
  const W = 600;
  const H = 140;
  const pad = 8;
  const t0 = new Date(history[0]?.at ?? 0).getTime();
  const t1 = new Date(history[history.length - 1]?.at ?? 0).getTime();
  const span = Math.max(1, t1 - t0);
  const x = (at: string) => pad + ((new Date(at).getTime() - t0) / span) * (W - pad * 2);
  const y = (v: number) => pad + ((100 - Math.max(-100, Math.min(100, v))) / 200) * (H - pad * 2);
  const points = history.map((d) => `${x(d.at).toFixed(1)},${y(d.affinity).toFixed(1)}`).join(" ");
  const last = history[history.length - 1];
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`好感變化:從 ${Math.round(history[0]?.affinity ?? 0)} 到 ${Math.round(last?.affinity ?? 0)}`}>
        <line className="chart__zero" x1={pad} x2={W - pad} y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke" />
        <polyline className="chart__line" points={points} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="faint" style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-xs)", marginTop: "var(--s-1)" }}>
        <span>{fmtDateTime(history[0]?.at ?? "")}</span>
        <span>{fmtDateTime(last?.at ?? "")}</span>
      </figcaption>
    </figure>
  );
}

function RelationshipEditor({ detail }: { detail: PersonDetail }) {
  const update = useUpdatePerson(detail.person.id);
  const toast = useToast();
  const id = useId();
  const r = detail.relationship;
  const [callName, setCallName] = useState(r?.call_name ?? "");
  const [tags, setTags] = useState((r?.tags ?? []).join(", "));
  const [notes, setNotes] = useState(r?.notes ?? "");

  useEffect(() => {
    setCallName(r?.call_name ?? "");
    setTags((r?.tags ?? []).join(", "));
    setNotes(r?.notes ?? "");
  }, [r?.call_name, r?.tags, r?.notes]);

  const save = () =>
    update.mutate(
      {
        call_name: callName.trim() || null,
        tags: tags.split(/[,,]/).map((t) => t.trim()).filter(Boolean),
        notes,
      },
      { onSuccess: () => toast("ok", "已更新"), onError: (e) => toast("danger", describeError(e)) },
    );

  return (
    <Panel title="她怎麼看這個人" titleId="person-edit">
      <form
        className="form-grid"
        style={{ maxWidth: "none" }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="稱呼" htmlFor={`${id}-call`} hint="她怎麼叫這個人;留空就用顯示名稱。">
          <input id={`${id}-call`} className="input" value={callName} onChange={(e) => setCallName(e.target.value)} />
        </Field>
        <Field label="標籤" htmlFor={`${id}-tags`} hint="以逗號分隔,例如:常客, Minecraft">
          <input id={`${id}-tags`} className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="備註" htmlFor={`${id}-notes`}>
          <textarea id={`${id}-notes`} className="textarea" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Button writes type="submit" variant="primary" icon={Save} busy={update.isPending}>
          儲存
        </Button>
      </form>
    </Panel>
  );
}

function PersonBody({ detail }: { detail: PersonDetail }) {
  const r = detail.relationship;
  const update = useUpdatePerson(detail.person.id);
  const toast = useToast();
  return (
    <>
      <PageHeader
        back={
          <Link to="/people" className="backlink">
            <ArrowLeft aria-hidden size={14} />
            人與關係
          </Link>
        }
        title={
          <span style={{ display: "inline-flex", gap: "var(--s-3)", alignItems: "center", flexWrap: "wrap" }}>
            {detail.person.display_name}
            {detail.label && <Badge tone="accent">{detail.label}</Badge>}
            {detail.blocked && <Badge tone="danger">已封鎖</Badge>}
          </span>
        }
        description={`第一次見面:${fmtDateTime(detail.person.created_at)} · ${detail.memory_count} 則相關記憶`}
        actions={
          <Button
            writes
            icon={Ban}
            variant={detail.blocked ? "default" : "danger"}
            busy={update.isPending}
            onClick={() =>
              update.mutate(
                { blocked: !detail.blocked },
                {
                  onSuccess: () => toast("ok", detail.blocked ? "已解除封鎖" : "已封鎖:她會完全忽略這個人"),
                  onError: (e) => toast("danger", describeError(e)),
                },
              )
            }
          >
            {detail.blocked ? "解除封鎖" : "封鎖"}
          </Button>
        }
      />
      <div className="grid-main-side">
        <div className="stack">
          <Panel title="關係" titleId="person-rel">
            {r ? (
              <div style={{ display: "grid", gap: "var(--s-5)" }}>
                <dl className="dl" style={{ gridTemplateColumns: "4rem minmax(0,1fr) 3rem", alignItems: "center" }}>
                  <dt>好感</dt>
                  <dd><Bipolar value={r.affinity} label="好感" /></dd>
                  <dd className="num" style={{ textAlign: "right" }}>{Math.round(r.affinity)}</dd>
                  <dt>信任</dt>
                  <dd><Meter value={r.trust / 100} tone="ok" label="信任" /></dd>
                  <dd className="num" style={{ textAlign: "right" }}>{Math.round(r.trust)}</dd>
                  <dt>熟悉</dt>
                  <dd><Meter value={r.familiarity / 100} label="熟悉" /></dd>
                  <dd className="num" style={{ textAlign: "right" }}>{Math.round(r.familiarity)}</dd>
                </dl>
                <AffinityChart history={detail.history} />
              </div>
            ) : (
              <EmptyState compact title="還沒有建立關係">互動過幾次之後,她才會開始對這個人有感覺。</EmptyState>
            )}
          </Panel>
          <Panel title="最近的變化" titleId="person-deltas" flush>
            {detail.history.length === 0 ? (
              <EmptyState compact title="沒有變化紀錄" />
            ) : (
              <ul className="rows">
                {[...detail.history].reverse().slice(0, 20).map((d, i) => (
                  <li className="row" key={`${d.at}-${i}`}>
                    <div className="row__main">
                      <div className="row__title" style={{ fontWeight: 400 }}>{d.reason}</div>
                      <div className="row__meta num">
                        好感 {Math.round(d.affinity)} · 信任 {Math.round(d.trust)} · 熟悉 {Math.round(d.familiarity)}
                      </div>
                    </div>
                    <time className="faint" style={{ fontSize: "var(--fs-sm)" }} dateTime={d.at}>
                      {fmtRelative(d.at)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="stack">
          <Panel title="帳號" titleId="person-accounts" flush>
            <ul className="rows">
              {detail.person.accounts.map((a) => (
                <li className="row" key={accountString(a.account)}>
                  <div className="row__main">
                    <div className="row__title">
                      {a.display_name}
                      <span className="tag">{a.account.platform}</span>
                    </div>
                    <div className="row__meta mono">{a.account.id}</div>
                  </div>
                  <span className="faint" style={{ fontSize: "var(--fs-sm)" }} title={fmtDateTime(a.last_seen)}>
                    {fmtRelative(a.last_seen)}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
          <RelationshipEditor detail={detail} />
        </div>
      </div>
    </>
  );
}

export function PersonPage() {
  const { personId = "" } = useParams({ strict: false });
  const person = usePerson(personId);
  return (
    <div className="page">
      <QueryView
        query={person}
        route={`GET /api/people/${personId}`}
        feature="人與關係"
        framed
        skeleton={<Panel><SkeletonRows count={4} /></Panel>}
      >
        {(d) => <PersonBody detail={d} />}
      </QueryView>
      {person.isError && (
        <p style={{ marginTop: "var(--s-4)" }}>
          <Link to="/people" className="backlink">
            <ArrowLeft aria-hidden size={14} />
            回到人與關係
          </Link>
        </p>
      )}
      {person.isSuccess && !person.data && <EmptyState icon={UserRound} title="找不到這個人" />}
    </div>
  );
}
