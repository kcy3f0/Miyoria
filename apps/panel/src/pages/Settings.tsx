import { LogOut, ScanSearch } from "lucide-react";
import { useState } from "react";
import { isApiError } from "../api/http";
import { useConnection } from "../app/connection";
import { useHealth } from "../app/queries";
import { useToast } from "../components/toast";
import { Badge, Button, PageHeader, Panel } from "../components/ui";
import { TokenForm } from "./TokenGate";

/** Read-only routes the panel uses; probed to show what this Core supports. */
export const PROBES: { route: string; label: string; live: boolean }[] = [
  { route: "/api/modules", label: "子系統", live: true },
  { route: "/api/decisions?limit=1", label: "決策追蹤", live: true },
  { route: "/api/llm/usage", label: "LLM 用量", live: true },
  { route: "/api/persona", label: "Persona", live: true },
  { route: "/api/llm/cost", label: "LLM 花費", live: false },
  { route: "/api/people?limit=1", label: "人與關係", live: false },
  { route: "/api/memory?limit=1", label: "記憶", live: false },
  { route: "/api/auth/roles", label: "權限 · 角色", live: false },
  { route: "/api/auth/assignments", label: "權限 · 指派", live: false },
  { route: "/api/extensions", label: "擴充套件", live: false },
  { route: "/api/mcp", label: "MCP 伺服器", live: false },
  { route: "/api/queue", label: "請求佇列", live: false },
  { route: "/api/stage", label: "直播控制", live: false },
  { route: "/api/voice", label: "語音監控", live: false },
];

type ProbeResult = "ok" | "missing" | "error";

function ApiSupport() {
  const { client } = useConnection();
  const [results, setResults] = useState<Record<string, { r: ProbeResult; note?: string }>>({});
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    const entries = await Promise.all(
      PROBES.map(async (p) => {
        try {
          await client.get<unknown>(p.route);
          return [p.route, { r: "ok" as const }] as const;
        } catch (e) {
          if (isApiError(e) && e.kind === "not_provided") return [p.route, { r: "missing" as const }] as const;
          return [p.route, { r: "error" as const, note: e instanceof Error ? e.message : String(e) }] as const;
        }
      }),
    );
    setResults(Object.fromEntries(entries));
    setBusy(false);
  };

  return (
    <Panel
      title="API 支援度"
      titleId="settings-probe"
      flush
      actions={
        <Button size="sm" icon={ScanSearch} busy={busy} onClick={() => void run()}>
          檢查
        </Button>
      }
    >
      <ul className="rows">
        {PROBES.map((p) => {
          const res = results[p.route];
          return (
            <li className="row" key={p.route}>
              <div className="row__main">
                <div className="row__title" style={{ fontWeight: 400 }}>
                  {p.label}
                  {!p.live && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>規劃中</span>}
                </div>
                <div className="row__meta mono">GET {p.route.split("?")[0]}</div>
              </div>
              {res === undefined ? (
                <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>未檢查</span>
              ) : res.r === "ok" ? (
                <Badge tone="ok" dot>可用</Badge>
              ) : res.r === "missing" ? (
                <Badge dot>尚未提供</Badge>
              ) : (
                <span title={res.note}>
                  <Badge tone="danger" dot>錯誤</Badge>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function SettingsPage() {
  const { config, signOut } = useConnection();
  const health = useHealth();
  const toast = useToast();
  return (
    <div className="page page--narrow">
      <PageHeader
        title="設定"
        description="面板連到哪個 Core、用哪個 token。設定只存在這個瀏覽器。"
        actions={
          <Button icon={LogOut} onClick={signOut}>
            登出
          </Button>
        }
      />
      <div className="stack">
        <Panel title="連線" titleId="settings-conn">
          <div style={{ display: "grid", gap: "var(--s-4)" }}>
            <dl className="dl">
              <dt>目前位址</dt>
              <dd className="mono">{config.baseUrl || "同源(" + window.location.origin + ")"}</dd>
              <dt>Core 版本</dt>
              <dd className="mono">{health.data?.version ?? (health.isError ? "無回應" : "…")}</dd>
            </dl>
            <TokenForm
              initial={config}
              submitLabel="驗證並儲存"
              className="form-grid"
              onSaved={(v) => toast("ok", `已連線到 Core ${v}`)}
            />
          </div>
        </Panel>
        <ApiSupport />
      </div>
    </div>
  );
}
