import { Brain, Pencil, Search, Trash2 } from "lucide-react";
import { useDeferredValue, useId, useState } from "react";
import { describeError } from "../api/http";
import type { MemoryItem, MemoryKind, MemoryRecordView, MemoryScope } from "../api/planned-types";
import { useDeleteMemory, useMemory, useUpdateMemory } from "../app/queries";
import { ConfirmDialog, Modal } from "../components/dialog";
import { QueryView } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, EmptyState, Field, Meter, PageHeader, Panel, Segmented } from "../components/ui";
import { accountString, contextShort, fmtDateTime, fmtRelative, fmtScore } from "../lib/format";

const KIND_LABEL: Record<MemoryKind, string> = {
  episode: "事件",
  fact: "事實",
  self_note: "她自己",
  followup: "待追問",
};

export function scopeLabel(s: MemoryScope): string {
  switch (s.type) {
    case "global":
      return "全域";
    case "guild":
      return `伺服器 ${s.guild}`;
    case "channel":
      return contextShort(s.context);
    case "dm":
      return `私訊 ${accountString(s.account)}`;
    case "person":
      return "跟著這個人";
  }
}

function EditMemory({ record, onClose }: { record: MemoryRecordView; onClose: () => void }) {
  const update = useUpdateMemory();
  const toast = useToast();
  const id = useId();
  const [content, setContent] = useState(record.content);
  const [importance, setImportance] = useState(record.importance);
  return (
    <Modal
      open
      wide
      title="編輯記憶"
      onClose={() => !update.isPending && onClose()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            取消
          </Button>
          <Button
            writes
            variant="primary"
            busy={update.isPending}
            disabled={!content.trim()}
            onClick={() =>
              update.mutate(
                { id: record.id, req: { content: content.trim(), importance } },
                {
                  onSuccess: () => {
                    toast("ok", "記憶已更新");
                    onClose();
                  },
                  onError: (e) => toast("danger", describeError(e)),
                },
              )
            }
          >
            儲存
          </Button>
        </>
      }
    >
      <Field label="內容" htmlFor={`${id}-c`}>
        <textarea id={`${id}-c`} className="textarea" rows={5} value={content} onChange={(e) => setContent(e.target.value)} />
      </Field>
      <Field label={`重要度 ${importance.toFixed(2)}`} htmlFor={`${id}-i`} hint="越重要越容易被想起,也越不會被清掉。">
        <input id={`${id}-i`} type="range" min={0} max={1} step={0.05} value={importance} onChange={(e) => setImportance(Number(e.target.value))} style={{ accentColor: "var(--c-accent-fill)" }} />
      </Field>
    </Modal>
  );
}

function MemoryRow({ item, onEdit, onDelete }: { item: MemoryItem; onEdit: () => void; onDelete: () => void }) {
  const r = item.record;
  return (
    <li className="row" style={{ alignItems: "flex-start" }}>
      <div className="row__main">
        <p style={{ overflowWrap: "anywhere", color: r.superseded_by ? "var(--c-text-3)" : undefined }}>{r.content}</p>
        <div className="row__meta" style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)", alignItems: "center", marginTop: "var(--s-2)" }}>
          <Badge tone={r.kind === "followup" ? "warn" : r.kind === "self_note" ? "accent" : "neutral"}>{KIND_LABEL[r.kind]}</Badge>
          <span className="tag">{scopeLabel(r.scope)}</span>
          {r.superseded_by && <span className="tag">已被取代</span>}
          {r.kind === "followup" && r.due && <span>{r.done ? "已追問" : `預定 ${fmtRelative(r.due)}`}</span>}
          <span title={fmtDateTime(r.created_at)}>{fmtRelative(r.created_at)}</span>
          <span>想起 {r.access_count} 次</span>
          {item.text_score !== undefined && <span className="mono">文字 {fmtScore(item.text_score)}</span>}
          {item.vector_score != null && <span className="mono">向量 {fmtScore(item.vector_score)}</span>}
        </div>
      </div>
      <div className="row__aside" style={{ flexDirection: "column", alignItems: "flex-end", gap: "var(--s-2)" }}>
        <div style={{ width: "5rem" }} title={`重要度 ${r.importance.toFixed(2)}`}>
          <Meter value={r.importance} label="重要度" />
        </div>
        <div className="inline-actions">
          <Button writes size="sm" variant="ghost" iconOnly icon={Pencil} label="編輯" onClick={onEdit} />
          <Button writes size="sm" variant="ghost" iconOnly icon={Trash2} label="刪除" onClick={onDelete} />
        </div>
      </div>
    </li>
  );
}

export function MemoryPage() {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const [superseded, setSuperseded] = useState(false);
  const [limit, setLimit] = useState(50);
  const deferred = useDeferredValue(q.trim());
  const memory = useMemory({
    q: deferred || undefined,
    kind: kind === "all" ? undefined : kind,
    include_superseded: superseded || undefined,
    limit,
  });
  const del = useDeleteMemory();
  const toast = useToast();
  const [editing, setEditing] = useState<MemoryRecordView | null>(null);
  const [deleting, setDeleting] = useState<MemoryRecordView | null>(null);

  return (
    <div className="page">
      <PageHeader title="記憶" description="她記得的事件、事實、自己的想法與待追問的事。搜尋時顯示文字與向量相似度。" />
      <div className="toolbar">
        <div className="search">
          <Search aria-hidden />
          <input className="input" type="search" placeholder="搜尋記憶內容" aria-label="搜尋記憶" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented<MemoryKind | "all">
          name="memory-kind"
          label="種類"
          value={kind}
          onChange={setKind}
          options={[{ value: "all", label: "全部" }, ...(Object.keys(KIND_LABEL) as MemoryKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))]}
        />
        <label className="check">
          <input type="checkbox" checked={superseded} onChange={(e) => setSuperseded(e.target.checked)} />
          包含已被取代的
        </label>
      </div>
      <Panel flush>
        <QueryView
          query={memory}
          route="GET /api/memory"
          feature="記憶瀏覽器"
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState icon={Brain} title={deferred ? "想不起來" : "還沒有任何記憶"}>
              {deferred ? `沒有跟「${deferred}」有關的記憶。` : "聊過天之後,她會把值得記住的事寫下來。"}
            </EmptyState>
          }
        >
          {(page) => (
            <>
              <ul className="rows">
                {page.items.map((item) => (
                  <MemoryRow key={item.record.id} item={item} onEdit={() => setEditing(item.record)} onDelete={() => setDeleting(item.record)} />
                ))}
              </ul>
              {page.next_cursor && (
                <div style={{ padding: "var(--s-3) var(--s-4)", borderTop: "1px solid var(--c-line)" }}>
                  <Button size="sm" busy={memory.isFetching} onClick={() => setLimit((l) => l + 50)}>
                    載入更多
                  </Button>
                </div>
              )}
            </>
          )}
        </QueryView>
      </Panel>

      {editing && <EditMemory record={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title="刪除這則記憶?"
        confirmLabel="刪除"
        danger
        busy={del.isPending}
        onClose={() => !del.isPending && setDeleting(null)}
        onConfirm={() =>
          deleting &&
          del.mutate(deleting.id, {
            onSuccess: () => {
              toast("ok", "已刪除");
              setDeleting(null);
            },
            onError: (e) => toast("danger", describeError(e)),
          })
        }
      >
        <p>她會永遠忘記這件事,無法復原:</p>
        <p style={{ marginTop: "var(--s-2)", color: "var(--c-text)" }}>「{deleting?.content}」</p>
      </ConfirmDialog>
    </div>
  );
}
