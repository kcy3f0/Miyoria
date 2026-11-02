import { Check, Copy } from "lucide-react";
import { useId, useState } from "react";
import type { StageLink, StageState } from "@/api/types";
import { useStage, useStageMutations } from "@/app/queries";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { ConfirmDialog } from "@/components/confirm";
import { QueryView, SkeletonRows } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { notify } from "@/lib/notify";

function LinkBadge({ name, link }: { name: string; link: StageLink }) {
  const badge = <StatusBadge tone={link.connected ? "success" : "neutral"}>{name}</StatusBadge>;
  if (link.connected || !link.error) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent>{link.error}</TooltipContent>
    </Tooltip>
  );
}

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <Label htmlFor={htmlFor} className="font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function OverlayRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-3">
      <Row label="Overlay">
        <div className="flex min-w-0 items-center gap-1">
          <code className="truncate text-[13px] text-foreground/90">{url}</code>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={copied ? "已複製" : "複製 overlay 網址"}
            onClick={() =>
              void navigator.clipboard?.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      </Row>
      <iframe
        className="aspect-video w-full rounded-md border bg-[repeating-conic-gradient(oklch(0.2_0_0)_0_25%,oklch(0.17_0_0)_0_50%)] bg-[length:16px_16px]"
        src={url}
        title="Overlay 預覽"
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}

function StageBody({ s }: { s: StageState }) {
  const m = useStageMutations();
  const canWrite = useCanWrite();
  const id = useId();
  const [confirmStream, setConfirmStream] = useState<"start" | "stop" | null>(null);

  const sceneDisabled = !canWrite || !s.obs.connected || s.scenes.length === 0 || m.scene.isPending;
  const exprDisabled = !canWrite || !s.vts.connected || s.expressions.length === 0 || m.expression.isPending;
  const known = (list: string[], v: string | null) => (v !== null && list.includes(v) ? v : undefined);

  return (
    <CardContent className="grid gap-4">
      <Row label="場景" htmlFor={`${id}-scene`}>
        <Select
          value={known(s.scenes, s.scene)}
          onValueChange={(name) =>
            m.scene.mutate(name, { onSuccess: () => notify.ok(`已切到「${name}」`), onError: (e) => notify.error(e, "切換場景失敗") })
          }
          disabled={sceneDisabled}
        >
          <SelectTrigger id={`${id}-scene`} className="w-56" title={!canWrite ? READ_ONLY_HINT : undefined}>
            <SelectValue placeholder={!s.obs.connected ? "OBS 未連線" : s.scenes.length === 0 ? "沒有場景" : (s.scene ?? "選擇場景")} />
          </SelectTrigger>
          <SelectContent>
            {s.scenes.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="表情" htmlFor={`${id}-expr`}>
        <Select
          value={known(s.expressions, s.expression)}
          onValueChange={(name) =>
            m.expression.mutate(name, { onError: (e) => notify.error(e, "觸發表情失敗") })
          }
          disabled={exprDisabled}
        >
          <SelectTrigger id={`${id}-expr`} className="w-56" title={!canWrite ? READ_ONLY_HINT : undefined}>
            <SelectValue placeholder={!s.vts.connected ? "VTube Studio 未連線" : s.expressions.length === 0 ? "沒有表情" : "觸發表情"} />
          </SelectTrigger>
          <SelectContent>
            {s.expressions.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="OBS 直播" htmlFor={`${id}-stream`}>
        <Switch
          id={`${id}-stream`}
          checked={s.streaming}
          disabled={!canWrite || !s.obs.connected || m.stream.isPending}
          title={!canWrite ? READ_ONLY_HINT : undefined}
          onCheckedChange={(on) => setConfirmStream(on ? "start" : "stop")}
        />
      </Row>
      {s.overlay_url && <OverlayRow url={s.overlay_url} />}
      <ConfirmDialog
        open={confirmStream !== null}
        title={confirmStream === "start" ? "開始直播?" : "結束直播?"}
        confirmLabel={confirmStream === "start" ? "開始直播" : "結束直播"}
        destructive={confirmStream === "stop"}
        busy={m.stream.isPending}
        onClose={() => setConfirmStream(null)}
        onConfirm={() =>
          confirmStream &&
          m.stream.mutate(confirmStream, {
            onSuccess: (st) => {
              notify.ok(st.streaming ? "直播中" : "已結束直播");
              setConfirmStream(null);
            },
            onError: (e) => notify.error(e),
          })
        }
      >
        {confirmStream === "start" ? "OBS 會開始推流。" : "OBS 會停止推流,觀眾會看到直播結束。"}
      </ConfirmDialog>
    </CardContent>
  );
}

export function StageCard() {
  const stage = useStage();
  const s = stage.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>舞台</CardTitle>
        {s && (
          <CardAction>
            <LinkBadge name="VTube Studio" link={s.vts} />
            <LinkBadge name="OBS" link={s.obs} />
          </CardAction>
        )}
      </CardHeader>
      <QueryView query={stage} skeleton={<SkeletonRows count={3} />}>
        {(data) => <StageBody s={data} />}
      </QueryView>
    </Card>
  );
}
