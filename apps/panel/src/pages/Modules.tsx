import { Boxes, Power, PowerOff, RotateCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { describeError } from "../api/http";
import type { ModuleAction, ModuleInfo } from "../api/types";
import { useModuleAction, useModules } from "../app/queries";
import { ConfirmDialog } from "../components/dialog";
import { QueryView } from "../components/states";
import { useToast } from "../components/toast";
import { Button, EmptyState, PageHeader, Panel, Segmented, StateBadge } from "../components/ui";

/** The API module refuses to stop itself (409), so the panel doesn't offer it. */
const SELF_ID = "api";

type Filter = "all" | "attention" | "disabled";

const ACTION_COPY: Record<ModuleAction, { verb: string; danger: boolean; text: (m: ModuleInfo) => string }> = {
  enable: { verb: "啟用", danger: false, text: (m) => `${m.name} 會立刻啟動。` },
  disable: {
    verb: "停用",
    danger: true,
    text: (m) => `${m.name} 會停止,依賴它的功能也會跟著失效,直到再次啟用。`,
  },
  restart: { verb: "重新啟動", danger: false, text: (m) => `${m.name} 會先停止再啟動,進行中的工作可能中斷。` },
};

export function ModulesPage() {
  const modules = useModules();
  const action = useModuleAction();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [pending, setPending] = useState<{ module: ModuleInfo; action: ModuleAction } | null>(null);

  const list = modules.data ?? [];
  const counts = useMemo(
    () => ({
      all: list.length,
      attention: list.filter((m) => m.state === "failed" || m.state === "degraded" || (m.enabled && m.state === "stopped")).length,
      disabled: list.filter((m) => !m.enabled).length,
    }),
    [list],
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list
      .filter((m) => {
        if (filter === "attention" && !(m.state === "failed" || m.state === "degraded" || (m.enabled && m.state === "stopped"))) return false;
        if (filter === "disabled" && m.enabled) return false;
        if (!needle) return true;
        return [m.id, m.name, m.description].some((s) => s.toLowerCase().includes(needle));
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [list, q, filter]);

  const confirm = () => {
    if (!pending) return;
    const { module, action: act } = pending;
    action.mutate(
      { id: module.id, action: act },
      {
        onSuccess: (m) => {
          toast("ok", `已${ACTION_COPY[act].verb} ${m.name}(目前:${m.state})`);
          setPending(null);
        },
        onError: (e) => {
          toast("danger", `${ACTION_COPY[act].verb}失敗:${describeError(e)}`);
          setPending(null);
        },
      },
    );
  };

  return (
    <div className="page">
      <PageHeader title="子系統" description="每個模組都能獨立啟用、停用或重新啟動;狀態會隨事件串流即時更新。" />

      <div className="toolbar">
        <div className="search">
          <Search aria-hidden />
          <input className="input" type="search" placeholder="搜尋名稱、id 或說明" aria-label="搜尋子系統" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented<Filter>
          name="module-filter"
          label="篩選"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "全部", count: counts.all },
            { value: "attention", label: "需要注意", count: counts.attention },
            { value: "disabled", label: "已停用", count: counts.disabled },
          ]}
        />
      </div>

      <Panel flush>
        <QueryView
          query={modules}
          route="GET /api/modules"
          isEmpty={(d) => d.length === 0}
          empty={<EmptyState icon={Boxes} title="沒有任何子系統">Core 沒有註冊模組。</EmptyState>}
        >
          {() =>
            visible.length === 0 ? (
              <EmptyState compact title="沒有符合的子系統">換個關鍵字或篩選條件。</EmptyState>
            ) : (
              <ul className="rows">
                {visible.map((m) => {
                  const self = m.id === SELF_ID;
                  const busy = action.isPending && action.variables?.id === m.id;
                  return (
                    <li className="row" key={m.id} style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div className="row__main" style={{ flexBasis: "18rem" }}>
                        <div className="row__title">
                          {m.name}
                          <code className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                            {m.id}
                          </code>
                        </div>
                        {m.description && <div className="row__meta">{m.description}</div>}
                        {m.reason && (
                          <div className="row__meta" style={{ color: m.state === "failed" ? "var(--c-danger)" : "var(--c-text-2)" }}>
                            原因:{m.reason}
                          </div>
                        )}
                      </div>
                      <div className="row__aside" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {m.recent_restarts > 0 && (
                          <span className="faint num" style={{ fontSize: "var(--fs-xs)" }} title="最近自動重啟次數">
                            重啟 {m.recent_restarts} 次
                          </span>
                        )}
                        <StateBadge state={m.state} />
                        <div className="inline-actions">
                          {m.enabled ? (
                            <>
                              <Button
                                size="sm"
                                icon={RotateCw}
                                disabled={self}
                                busy={busy && action.variables?.action === "restart"}
                                title={self ? "無法透過 API 重新啟動 API 自己" : undefined}
                                onClick={() => setPending({ module: m, action: "restart" })}
                              >
                                重新啟動
                              </Button>
                              <Button
                                size="sm"
                                icon={PowerOff}
                                disabled={self}
                                busy={busy && action.variables?.action === "disable"}
                                title={self ? "停用 API 會讓面板斷線" : undefined}
                                onClick={() => setPending({ module: m, action: "disable" })}
                              >
                                停用
                              </Button>
                            </>
                          ) : (
                            <Button size="sm" icon={Power} busy={busy} onClick={() => setPending({ module: m, action: "enable" })}>
                              啟用
                            </Button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )
          }
        </QueryView>
      </Panel>

      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${ACTION_COPY[pending.action].verb}「${pending.module.name}」?` : ""}
        confirmLabel={pending ? ACTION_COPY[pending.action].verb : ""}
        danger={pending ? ACTION_COPY[pending.action].danger : false}
        busy={action.isPending}
        onConfirm={confirm}
        onClose={() => !action.isPending && setPending(null)}
      >
        {pending && ACTION_COPY[pending.action].text(pending.module)}
      </ConfirmDialog>
    </div>
  );
}
