import { Link } from "@tanstack/react-router";
import { Search, Users } from "lucide-react";
import { useDeferredValue, useState } from "react";
import type { PersonSummary } from "../api/planned-types";
import { usePeople } from "../app/queries";
import { QueryView } from "../components/states";
import { Badge, Bipolar, EmptyState, Meter, PageHeader, Panel } from "../components/ui";
import { fmtRelative } from "../lib/format";

function PersonRow({ p }: { p: PersonSummary }) {
  const r = p.relationship;
  const platforms = [...new Set(p.person.accounts.map((a) => a.account.platform))];
  return (
    <tr>
      <td>
        <Link to="/people/$personId" params={{ personId: p.person.id }} style={{ color: "var(--c-text)", fontWeight: 500, textDecoration: "none" }}>
          {p.person.display_name}
        </Link>
        <div className="chips" style={{ marginTop: 4 }}>
          {platforms.map((pl) => (
            <span className="tag" key={pl}>
              {pl}
            </span>
          ))}
          {p.blocked && <Badge tone="danger">已封鎖</Badge>}
        </div>
      </td>
      <td>{p.label ?? <span className="faint">—</span>}</td>
      <td style={{ minWidth: "8rem" }}>
        {r ? (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
            <Bipolar value={r.affinity} label={`好感 ${Math.round(r.affinity)}`} />
            <span className="num" style={{ width: "2.5rem", textAlign: "right" }}>
              {Math.round(r.affinity)}
            </span>
          </div>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td style={{ minWidth: "7rem" }}>{r ? <Meter value={r.trust / 100} tone="ok" label={`信任 ${Math.round(r.trust)}`} /> : <span className="faint">—</span>}</td>
      <td style={{ minWidth: "7rem" }}>{r ? <Meter value={r.familiarity / 100} label={`熟悉 ${Math.round(r.familiarity)}`} /> : <span className="faint">—</span>}</td>
      <td className="r">{r?.interactions ?? 0}</td>
      <td className="faint" style={{ whiteSpace: "nowrap" }}>
        {r?.last_interaction ? fmtRelative(r.last_interaction) : "—"}
      </td>
    </tr>
  );
}

export function PeoplePage() {
  const [q, setQ] = useState("");
  const deferred = useDeferredValue(q.trim());
  const people = usePeople({ q: deferred || undefined, limit: 100 });

  return (
    <div className="page">
      <PageHeader title="人與關係" description="她認識的人、跨平台綁定的帳號,以及她對每個人的好感、信任與熟悉度。" />
      <div className="toolbar">
        <div className="search" style={{ maxWidth: "28rem" }}>
          <Search aria-hidden />
          <input className="input" type="search" placeholder="搜尋名稱或帳號 id" aria-label="搜尋人" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <Panel flush>
        <QueryView
          query={people}
          route="GET /api/people"
          feature="人與關係"
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState icon={Users} title={deferred ? "找不到這個人" : "她還不認識任何人"}>
              {deferred ? "換個名稱或帳號 id 試試。" : "有人跟她說話後就會出現在這裡。哼,她也不是很想認識誰啦。"}
            </EmptyState>
          }
        >
          {(page) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">名稱</th>
                    <th scope="col">關係</th>
                    <th scope="col">好感</th>
                    <th scope="col">信任</th>
                    <th scope="col">熟悉</th>
                    <th scope="col" className="r">互動</th>
                    <th scope="col">最近</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((p) => (
                    <PersonRow key={p.person.id} p={p} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      </Panel>
    </div>
  );
}
