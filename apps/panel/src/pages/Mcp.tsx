import { ChevronDown, ChevronRight, Plug, Power, PowerOff, RotateCw } from "lucide-react";
import { useState } from "react";
import { describeError } from "../api/http";
import type { McpServerInfo, McpState } from "../api/planned-types";
import { useMcpAction, useMcpServers } from "../app/queries";
import { ConfirmDialog } from "../components/dialog";
import { QueryView } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, EmptyState, PageHeader, Panel } from "../components/ui";
import type { Tone } from "../lib/events";

type Act = "enable" | "disable" | "restart";
const VERB: Record<Act, string> = { enable: "啟用", disable: "停用", restart: "重新連線" };
const STATE: Record<McpState, { label: string; tone: Tone }> = {
  ready: { label: "已連線", tone: "ok" },
  connecting: { label: "連線中", tone: "warn" },
  failed: { label: "失敗", tone: "danger" },
  disabled: { label: "已停用", tone: "neutral" },
};

function ServerRow({ s, onAct }: { s: McpServerInfo; onAct: (a: Act) => void }) {
  const [open, setOpen] = useState(false);
  const st = STATE[s.state] ?? { label: s.state, tone: "neutral" as Tone };
  return (
    <li style={{ borderBottom: "1px solid var(--c-line)" }}>
      <div className="row" style={{ borderBottom: 0, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="row__main" style={{ flexBasis: "18rem" }}>
          <div className="row__title">
            {s.name}
            <span className="tag">{s.transport}</span>
          </div>
          <div className="row__meta mono">{s.target}</div>
          {s.error && <div className="row__meta" style={{ color: "var(--c-danger)" }}>{s.error}</div>}
          <Button size="sm" variant="ghost" icon={open ? ChevronDown : ChevronRight} aria-expanded={open} onClick={() => setOpen(!open)} style={{ marginTop: "var(--s-1)", marginLeft: "calc(var(--s-2) * -1)" }}>
            {s.tools.length} 個工具
          </Button>
        </div>
        <div className="row__aside">
          <Badge tone={st.tone} dot pulse={s.state === "connecting"}>
            {st.label}
          </Badge>
          <div className="inline-actions">
            {s.enabled ? (
              <>
                <Button size="sm" icon={RotateCw} onClick={() => onAct("restart")}>
                  重新連線
                </Button>
                <Button size="sm" icon={PowerOff} onClick={() => onAct("disable")}>
                  停用
                </Button>
              </>
            ) : (
              <Button size="sm" icon={Power} onClick={() => onAct("enable")}>
                啟用
              </Button>
            )}
          </div>
        </div>
      </div>
      {open && (
        <ul className="rows" style={{ margin: "0 var(--s-4) var(--s-4)", border: "1px solid var(--c-line)", borderRadius: "var(--r-md)" }}>
          {s.tools.length === 0 ? (
            <li className="row faint">這個伺服器沒有提供工具。</li>
          ) : (
            s.tools.map((t) => (
              <li className="row" key={t.name}>
                <div className="row__main">
                  <div className="row__title mono" style={{ fontSize: "var(--fs-sm)" }}>{t.name}</div>
                  {t.description && <div className="row__meta">{t.description}</div>}
                </div>
              </li>
            ))
          )}
        </ul>
      )}
    </li>
  );
}

export function McpPage() {
  const servers = useMcpServers();
  const action = useMcpAction();
  const toast = useToast();
  const [pending, setPending] = useState<{ s: McpServerInfo; act: Act } | null>(null);
  return (
    <div className="page">
      <PageHeader title="MCP 伺服器" description="外部工具來源:連線方式、狀態,以及她能從每台伺服器呼叫的工具。" />
      <Panel flush>
        <QueryView
          query={servers}
          route="GET /api/mcp"
          feature="MCP 管理"
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState icon={Plug} title="沒有設定 MCP 伺服器">
              在 miyoria.toml 的 <code>[mcp.servers]</code> 加一台,她就能用上面的工具。
            </EmptyState>
          }
        >
          {(list) => (
            <ul className="rows">
              {list.map((s) => (
                <ServerRow key={s.name} s={s} onAct={(act) => setPending({ s, act })} />
              ))}
            </ul>
          )}
        </QueryView>
      </Panel>
      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${VERB[pending.act]}「${pending.s.name}」?` : ""}
        confirmLabel={pending ? VERB[pending.act] : ""}
        danger={pending?.act === "disable"}
        busy={action.isPending}
        onClose={() => !action.isPending && setPending(null)}
        onConfirm={() =>
          pending &&
          action.mutate(
            { name: pending.s.name, action: pending.act },
            {
              onSuccess: () => {
                toast("ok", `已${VERB[pending.act]} ${pending.s.name}`);
                setPending(null);
              },
              onError: (e) => {
                toast("danger", describeError(e));
                setPending(null);
              },
            },
          )
        }
      >
        {pending?.act === "disable" ? `她將無法使用這台伺服器的 ${pending.s.tools.length} 個工具。` : "進行中的工具呼叫可能失敗。"}
      </ConfirmDialog>
    </div>
  );
}
