import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ListOrdered, Pause, Play, SkipForward } from "lucide-react";
import { describeError } from "../api/http";
import type { QueueItemKind, QueueState } from "../api/planned-types";
import { useApi } from "../app/connection";
import { queryKeys, useQueue } from "../app/queries";
import { QueryView } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, EmptyState, PageHeader, Panel } from "../components/ui";
import { contextShort, fmtRelative } from "../lib/format";

const KIND: Record<QueueItemKind, string> = { message: "訊息", voice: "語音", initiative: "主動", request: "點播" };

function useQueueMutation<A>(fn: (a: A) => Promise<QueueState>) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (state) => qc.setQueryData(queryKeys.queue, state),
    onError: (e) => toast("danger", describeError(e)),
  });
}

export function QueuePage() {
  const api = useApi();
  const queue = useQueue();
  const skip = useQueueMutation((id: string) => api.queueSkip(id));
  const move = useQueueMutation(({ id, position }: { id: string; position: number }) => api.queueMove(id, position));
  const pause = useQueueMutation((paused: boolean) => api.queuePause(paused));
  const paused = queue.data?.paused ?? false;

  return (
    <div className="page">
      <PageHeader
        title="請求佇列"
        description="等著她處理的訊息、語音與點播。可以調整順序或跳過。"
        actions={
          queue.isSuccess && (
            <Button icon={paused ? Play : Pause} variant={paused ? "primary" : "default"} busy={pause.isPending} onClick={() => pause.mutate(!paused)}>
              {paused ? "恢復處理" : "暫停處理"}
            </Button>
          )
        }
      />
      {paused && (
        <div className="notice" data-tone="warn" style={{ marginBottom: "var(--s-3)" }} role="status">
          <Pause aria-hidden />
          佇列已暫停:新的請求會排隊,但她不會處理。
        </div>
      )}
      <Panel flush>
        <QueryView
          query={queue}
          route="GET /api/queue"
          feature="請求佇列"
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState icon={ListOrdered} title="佇列是空的">
              沒有人在等她。難得清閒……才不是寂寞喔。
            </EmptyState>
          }
        >
          {(state) => (
            <ol className="rows">
              {state.items.map((item, i) => (
                <li className="row" key={item.id}>
                  <span className="num faint" style={{ width: "1.5rem", textAlign: "right" }} aria-label={`第 ${i + 1} 位`}>
                    {i + 1}
                  </span>
                  <div className="row__main">
                    <div className="row__title">
                      <Badge tone={item.kind === "request" ? "accent" : "neutral"}>{KIND[item.kind] ?? item.kind}</Badge>
                      <span style={{ fontWeight: 400, minWidth: 0, overflowWrap: "anywhere" }}>{item.text}</span>
                    </div>
                    <div className="row__meta">
                      {item.author?.display_name ?? "系統"} · {contextShort(item.context)} · {fmtRelative(item.enqueued_at)}
                      {item.priority !== 0 && ` · 優先 ${item.priority}`}
                    </div>
                  </div>
                  <div className="inline-actions">
                    <Button size="sm" variant="ghost" iconOnly icon={ArrowUp} label="往前移" disabled={i === 0 || move.isPending} onClick={() => move.mutate({ id: item.id, position: i - 1 })} />
                    <Button size="sm" variant="ghost" iconOnly icon={ArrowDown} label="往後移" disabled={i === state.items.length - 1 || move.isPending} onClick={() => move.mutate({ id: item.id, position: i + 1 })} />
                    <Button size="sm" icon={SkipForward} busy={skip.isPending && skip.variables === item.id} onClick={() => skip.mutate(item.id)}>
                      跳過
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </QueryView>
      </Panel>
    </div>
  );
}
