import { useId } from "react";
import type { ChannelLevelInfo, ChannelLevelsView, ChannelLevelView } from "@/api/types";
import { useChannelLevels, useSetChannelLevel } from "@/app/queries";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { contextShort } from "@/lib/format";
import { notify } from "@/lib/notify";

/** Select value meaning "back to the configured level". */
const RESET = "__reset__";

function LevelRow({ c, levels }: { c: ChannelLevelView; levels: ChannelLevelInfo[] }) {
  const set = useSetChannelLevel();
  const canWrite = useCanWrite();
  const id = useId();
  const name = c.label ?? contextShort(c.context);
  const info = levels.find((l) => l.mode === c.mode);
  const fallback = levels.find((l) => l.mode === c.default)?.label ?? c.default;
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-6 gap-y-1.5">
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block text-xs text-muted-foreground">
          {info?.description ?? c.mode}
          {c.custom ? "" : " · 預設"}
        </span>
      </label>
      <Select
        value={c.mode}
        disabled={!canWrite || set.isPending}
        onValueChange={(next) =>
          set.mutate(
            { context: c.context, mode: next === RESET ? null : next },
            {
              onSuccess: (row) =>
                notify.ok(`已將 ${name} 設為「${levels.find((l) => l.mode === row.mode)?.label ?? row.mode}」`),
              onError: (e) => notify.error(e, "設定聊天等級失敗"),
            },
          )
        }
      >
        <SelectTrigger id={id} className="w-36" title={canWrite ? undefined : READ_ONLY_HINT} aria-label={`${name} 的聊天等級`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {levels.map((l) => (
            <SelectItem key={l.mode} value={l.mode}>
              {l.label}
            </SelectItem>
          ))}
          {c.custom && (
            <>
              <SelectSeparator />
              <SelectItem value={RESET}>恢復預設({fallback})</SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

function LevelsBody({ v }: { v: ChannelLevelsView }) {
  return (
    <CardContent className="grid gap-3">
      {v.channels.length === 0 ? (
        <EmptyLine className="py-4">還沒有看過任何文字頻道</EmptyLine>
      ) : (
        v.channels.map((c) => (
          <LevelRow key={`${c.context.platform}:${c.context.scope}:${c.context.channel}`} c={c} levels={v.levels} />
        ))
      )}
      <p className="text-xs text-muted-foreground">
        等級是上限:她在等級之內自己決定要多話,有人請她安靜或多聊時她會自己調整(最多一天),但不會超過這裡的設定。也可以在 Discord 用
        /channel mode 設定。
      </p>
    </CardContent>
  );
}

/** The owner's level of each text channel she has seen (docs/design/autonomy.md §21). */
export function ChannelLevelsCard() {
  const levels = useChannelLevels();
  return (
    <Card>
      <CardHeader>
        <CardTitle>聊天等級</CardTitle>
      </CardHeader>
      <QueryView query={levels} skeleton={<SkeletonRows count={3} />}>
        {(v) => <LevelsBody v={v} />}
      </QueryView>
    </Card>
  );
}
