import { Power, PowerOff, Puzzle, RotateCw } from "lucide-react";
import { useState } from "react";
import { describeError } from "../api/http";
import type { ExtensionInfo } from "../api/planned-types";
import { useExtensionAction, useExtensions } from "../app/queries";
import { ConfirmDialog } from "../components/dialog";
import { QueryView } from "../components/states";
import { useToast } from "../components/toast";
import { Button, EmptyState, PageHeader, Panel, StateBadge } from "../components/ui";

type Act = "enable" | "disable" | "restart";
const VERB: Record<Act, string> = { enable: "啟用", disable: "停用", restart: "重新啟動" };

export function ExtensionsPage() {
  const extensions = useExtensions();
  const action = useExtensionAction();
  const toast = useToast();
  const [pending, setPending] = useState<{ ext: ExtensionInfo; act: Act } | null>(null);

  return (
    <div className="page">
      <PageHeader title="擴充套件" description="第三方與內建擴充:版本、來源、要求的權限與執行狀態。" />
      <Panel flush>
        <QueryView
          query={extensions}
          route="GET /api/extensions"
          feature="擴充套件管理"
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState icon={Puzzle} title="沒有安裝任何擴充套件">
              用 <code>miyoria ext install</code> 安裝,或 <code>miyoria ext new</code> 自己寫一個。
            </EmptyState>
          }
        >
          {(list) => (
            <ul className="rows">
              {list.map((x) => (
                <li className="row" key={x.id} style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div className="row__main" style={{ flexBasis: "18rem" }}>
                    <div className="row__title">
                      {x.name}
                      <span className="faint mono" style={{ fontSize: "var(--fs-xs)" }}>
                        {x.id}@{x.version}
                      </span>
                    </div>
                    {x.description && <div className="row__meta">{x.description}</div>}
                    <div className="row__meta">來源:{x.source}</div>
                    {x.reason && <div className="row__meta" style={{ color: "var(--c-danger)" }}>原因:{x.reason}</div>}
                    {x.permissions.length > 0 && (
                      <div className="chips" style={{ marginTop: "var(--s-2)" }} aria-label="要求的權限">
                        {x.permissions.map((p) => (
                          <span className="tag tag--mono" key={p}>
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="row__aside">
                    <StateBadge state={x.state} />
                    <div className="inline-actions">
                      {x.enabled ? (
                        <>
                          <Button size="sm" icon={RotateCw} onClick={() => setPending({ ext: x, act: "restart" })}>
                            重新啟動
                          </Button>
                          <Button size="sm" icon={PowerOff} onClick={() => setPending({ ext: x, act: "disable" })}>
                            停用
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" icon={Power} onClick={() => setPending({ ext: x, act: "enable" })}>
                          啟用
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </Panel>
      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${VERB[pending.act]}「${pending.ext.name}」?` : ""}
        confirmLabel={pending ? VERB[pending.act] : ""}
        danger={pending?.act === "disable"}
        busy={action.isPending}
        onClose={() => !action.isPending && setPending(null)}
        onConfirm={() =>
          pending &&
          action.mutate(
            { id: pending.ext.id, action: pending.act },
            {
              onSuccess: () => {
                toast("ok", `已${VERB[pending.act]} ${pending.ext.name}`);
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
        {pending?.act === "enable" && pending.ext.permissions.length > 0
          ? `它會取得這些權限:${pending.ext.permissions.join("、")}。`
          : pending?.act === "disable"
            ? "它提供的指令與工具會立刻消失。"
            : "進行中的工作可能中斷。"}
      </ConfirmDialog>
    </div>
  );
}
