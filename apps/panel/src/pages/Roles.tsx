import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, UserPlus, X } from "lucide-react";
import { useId, useState } from "react";
import { describeError } from "../api/http";
import type { AssignRoleRequest, AuthScope, RoleAssignment } from "../api/planned-types";
import { useApi } from "../app/connection";
import { queryKeys, useAssignments, useRoles } from "../app/queries";
import { ConfirmDialog, Modal } from "../components/dialog";
import { QueryView } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, EmptyState, Field, PageHeader, Panel } from "../components/ui";
import { accountString, contextShort, fmtRelative } from "../lib/format";

export function authScopeLabel(s: AuthScope): string {
  if (s.type === "global") return "全域";
  if (s.type === "guild") return `${s.platform} 伺服器 ${s.guild}`;
  return contextShort(s.context);
}

function useAssignMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: queryKeys.assignments });
  return {
    assign: useMutation({ mutationFn: (r: AssignRoleRequest) => api.assignRole(r), onSuccess: done }),
    revoke: useMutation({ mutationFn: (r: AssignRoleRequest) => api.revokeRole(r), onSuccess: done }),
  };
}

function AssignDialog({ roles, onClose }: { roles: string[]; onClose: () => void }) {
  const { assign } = useAssignMutations();
  const toast = useToast();
  const id = useId();
  const [platform, setPlatform] = useState("discord");
  const [account, setAccount] = useState("");
  const [role, setRole] = useState(roles[0] ?? "");
  const [guild, setGuild] = useState("");
  const scope: AuthScope = guild.trim() ? { type: "guild", platform, guild: guild.trim() } : { type: "global" };
  return (
    <Modal
      open
      title="指派角色"
      onClose={() => !assign.isPending && onClose()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            writes
            variant="primary"
            busy={assign.isPending}
            disabled={!account.trim() || !role}
            onClick={() =>
              assign.mutate(
                { account: { platform, id: account.trim() }, role, scope },
                {
                  onSuccess: () => {
                    toast("ok", `已指派 ${role}`);
                    onClose();
                  },
                  onError: (e) => toast("danger", describeError(e)),
                },
              )
            }
          >
            指派
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="平台" htmlFor={`${id}-p`}>
          <input id={`${id}-p`} className="input" value={platform} onChange={(e) => setPlatform(e.target.value)} />
        </Field>
        <Field label="帳號 id" htmlFor={`${id}-a`}>
          <input id={`${id}-a`} className="input mono" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="123456789012345678" />
        </Field>
      </div>
      <Field label="角色" htmlFor={`${id}-r`}>
        <select id={`${id}-r`} className="select" value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Field>
      <Field label="限定伺服器(選填)" htmlFor={`${id}-g`} hint="留空代表全域生效。">
        <input id={`${id}-g`} className="input mono" value={guild} onChange={(e) => setGuild(e.target.value)} />
      </Field>
    </Modal>
  );
}

export function RolesPage() {
  const roles = useRoles();
  const assignments = useAssignments();
  const { revoke } = useAssignMutations();
  const toast = useToast();
  const [assigning, setAssigning] = useState(false);
  const [revoking, setRevoking] = useState<RoleAssignment | null>(null);

  return (
    <div className="page">
      <PageHeader
        title="權限"
        description="角色決定誰能用哪些指令、工具與 API。權限節點以點分隔,例如 persona.edit。"
        actions={
          <Button writes icon={UserPlus} variant="primary" disabled={!roles.isSuccess} onClick={() => setAssigning(true)}>
            指派角色
          </Button>
        }
      />
      <div className="stack">
        <Panel title="角色" titleId="roles-list" flush>
          <QueryView
            query={roles}
            route="GET /api/auth/roles"
            feature="權限管理"
            isEmpty={(d) => d.length === 0}
            empty={<EmptyState icon={ShieldCheck} compact title="沒有任何角色" />}
          >
            {(list) => (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">角色</th>
                      <th scope="col" className="r">等級</th>
                      <th scope="col">允許</th>
                      <th scope="col">拒絕</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...list].sort((a, b) => b.rank - a.rank).map((r) => (
                      <tr key={r.name}>
                        <td>
                          <span style={{ fontWeight: 500 }}>{r.name}</span> {r.builtin && <Badge>內建</Badge>}
                        </td>
                        <td className="r">{r.rank}</td>
                        <td>
                          <div className="chips">
                            {r.grants.length ? r.grants.map((g) => <span className="tag tag--mono" key={g}>{g}</span>) : <span className="faint">—</span>}
                          </div>
                        </td>
                        <td>
                          <div className="chips">
                            {r.denies.length ? r.denies.map((g) => <span className="tag tag--mono" key={g}>{g}</span>) : <span className="faint">—</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </QueryView>
        </Panel>

        <Panel title="指派" titleId="roles-assign" flush>
          <QueryView
            query={assignments}
            route="GET /api/auth/assignments"
            feature="權限管理"
            isEmpty={(d) => d.length === 0}
            empty={<EmptyState compact title="還沒有指派任何角色">沒有指派的人只有預設權限。</EmptyState>}
          >
            {(list) => (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">帳號</th>
                      <th scope="col">角色</th>
                      <th scope="col">範圍</th>
                      <th scope="col">指派者</th>
                      <th scope="col">時間</th>
                      <th scope="col">
                        <span className="visually-hidden">動作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((a) => (
                      <tr key={`${accountString(a.account)}-${a.role}-${JSON.stringify(a.scope)}`}>
                        <td className="mono" style={{ fontSize: "var(--fs-sm)" }}>{accountString(a.account)}</td>
                        <td>{a.role}</td>
                        <td>{authScopeLabel(a.scope)}</td>
                        <td className="faint">{a.granted_by}</td>
                        <td className="faint">{fmtRelative(a.at)}</td>
                        <td className="r">
                          <Button writes size="sm" variant="ghost" icon={X} onClick={() => setRevoking(a)}>
                            撤銷
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </QueryView>
        </Panel>
      </div>

      {assigning && roles.data && <AssignDialog roles={roles.data.map((r) => r.name)} onClose={() => setAssigning(false)} />}
      <ConfirmDialog
        open={revoking !== null}
        title="撤銷這個角色?"
        confirmLabel="撤銷"
        danger
        busy={revoke.isPending}
        onClose={() => !revoke.isPending && setRevoking(null)}
        onConfirm={() =>
          revoking &&
          revoke.mutate(
            { account: revoking.account, role: revoking.role, scope: revoking.scope },
            {
              onSuccess: () => {
                toast("ok", "已撤銷");
                setRevoking(null);
              },
              onError: (e) => toast("danger", describeError(e)),
            },
          )
        }
      >
        {revoking && `${accountString(revoking.account)} 會失去「${revoking.role}」(${authScopeLabel(revoking.scope)})。`}
      </ConfirmDialog>
    </div>
  );
}
