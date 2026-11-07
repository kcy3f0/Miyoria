// What she is doing right now, in one strip, and the emergency stop. Shared by 總覽 and 直播.

import { Link } from "@tanstack/react-router";
import { OctagonPause, Play } from "lucide-react";
import type { ReactNode } from "react";
import type { MindView } from "@/api/types";
import { useMind, useMindMutations, useQueue, useSongs, useStage, useVoice, useWorld } from "@/app/queries";
import { Dot, type Tone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { notify } from "@/lib/notify";

export const HER_NAME = "DeepSeek-chan";

export function mindState(m: MindView): { tone: Tone; label: string } {
  if (m.paused) return { tone: "warning", label: "已暫停" };
  if (!m.running) return { tone: "neutral", label: "心智迴圈未啟動" };
  if (m.stats?.idle_reason === "budget exhausted") return { tone: "danger", label: "額度用完" };
  if (!m.accepting) return { tone: "neutral", label: "休息中" };
  return { tone: "success", label: "運作中" };
}

/** What she is doing right now, in a word or two: the sidebar and 總覽's opening line. */
export function useHerNow(): { tone: Tone; label: string; detail?: string } {
  const mind = useMind();
  const world = useWorld();
  const stage = useStage();
  const her = world.data?.her;
  const state = mind.data ? mindState(mind.data) : null;
  if (mind.data?.paused) return state ?? { tone: "warning", label: "已暫停" };
  if (her?.singing) return { tone: "brand", label: "唱歌中", detail: her.singing };
  if (her?.game) return { tone: "brand", label: "遊戲中", detail: her.game };
  if (stage.data?.speaking) return { tone: "brand", label: "說話中" };
  if (her?.voice) return { tone: "success", label: "在語音", detail: her.voice_name ?? undefined };
  return state ?? { tone: "neutral", label: "—" };
}

/**
 * Stops everything she does on her own (the gate's pause: only commands and the panel act), or
 * lets her go again. One click either way; the Core needs `owner.autonomy.approve`.
 */
export function EmergencyStop({ className }: { className?: string }) {
  const mind = useMind();
  const { pause } = useMindMutations();
  const paused = mind.data?.paused ?? false;
  const toggle = () =>
    pause.mutate(!paused, {
      onSuccess: (v) => notify.ok(v.paused ? "已緊急停止:她不會再自己行動" : "已恢復她的自主行動"),
      onError: (e) => notify.error(e, paused ? "恢復失敗" : "緊急停止失敗"),
    });
  if (mind.isError) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          writes
          variant={paused ? "default" : "stop"}
          busy={pause.isPending}
          disabled={mind.isPending}
          onClick={toggle}
          className={className}
        >
          {paused ? <Play /> : <OctagonPause />}
          {paused ? "恢復自主" : "緊急停止"}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{paused ? "讓她重新自己決定要做什麼" : "暫停她所有自主行動;指令和面板仍可操作"}</TooltipContent>
    </Tooltip>
  );
}

function Cell({ label, tone, pulse, children }: { label: string; tone?: Tone; pulse?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <dt className="shrink-0 text-foreground/80">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 font-medium">
        {tone && <Dot tone={tone} pulse={pulse} className="size-1.5 [&>span]:size-1.5" />}
        <span className="min-w-0 truncate">{children}</span>
      </dd>
    </div>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => <span className="font-normal text-foreground/80">{children}</span>;

/** Her live state on the picture: mind, voice, stream, scene, song, game, queue. */
export function NowStrip() {
  const mind = useMind();
  const world = useWorld();
  const stage = useStage();
  const voice = useVoice();
  const songs = useSongs();
  const queue = useQueue();

  const w = world.data;
  const s = stage.data;
  const session = voice.data?.sessions[0];
  const playing = songs.data?.songs.find((x) => x.no === songs.data?.playing) ?? null;
  const preparing = songs.data?.songs.filter((x) => x.state === "preparing").length ?? 0;
  const waiting = queue.data?.items.filter((i) => i.state === "pending").length ?? 0;
  const goLive = w?.her.golive === "live";
  const pending = mind.isPending || world.isPending;
  const ms = mind.data ? mindState(mind.data) : null;
  const approvals = mind.data?.pending_approvals ?? 0;
  // The opening line above already says it when she is doing nothing else.
  const said = useHerNow().label === ms?.label && approvals === 0;

  if (pending) {
    return (
      <div className="flex flex-wrap gap-x-5 gap-y-1" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-24" />
        ))}
      </div>
    );
  }

  return (
    <dl aria-label="她現在" className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
      {!said && (
        <Cell label="她" tone={ms?.tone ?? "neutral"}>
          {ms?.label ?? <Quiet>—</Quiet>}
          {approvals > 0 && (
            <Link to="/inner" search={{ tab: "thoughts" }} className="ml-2 font-normal text-primary underline-offset-4 hover:underline">
              {approvals} 件待批准
            </Link>
          )}
        </Cell>
      )}
      <Cell label="語音" tone={session ? "brand" : "neutral"}>
        {session ? (
          <>
            {w?.her.voice_name ?? session.label ?? "語音頻道"} <Quiet>· {session.participants.length} 人</Quiet>
          </>
        ) : (
          <Quiet>不在語音</Quiet>
        )}
      </Cell>
      <Cell label="直播" tone={goLive || s?.streaming ? "brand" : "neutral"} pulse={goLive || s?.streaming}>
        {goLive && s?.streaming ? "Go Live + OBS" : goLive ? "Go Live" : s?.streaming ? "OBS 推流中" : <Quiet>沒有開台</Quiet>}
      </Cell>
      <Cell label="場景" tone={s?.obs.connected ? undefined : "neutral"}>
        {s?.obs.connected ? (s.scene ?? <Quiet>—</Quiet>) : <Quiet>OBS 未連線</Quiet>}
      </Cell>
      <Cell label="唱歌" tone={playing ? "brand" : undefined} pulse={Boolean(playing)}>
        {playing ? (
          (playing.title ?? playing.query)
        ) : songs.isError ? (
          <Quiet>—</Quiet>
        ) : (
          <Quiet>{preparing > 0 ? `準備中 ${preparing} 首` : "沒有在唱"}</Quiet>
        )}
      </Cell>
      <Cell label="遊戲" tone={w?.her.game ? "brand" : undefined}>
        {w?.her.game ?? <Quiet>沒有在玩</Quiet>}
      </Cell>
      <Cell label="佇列" tone={queue.data?.paused ? "warning" : undefined}>
        {queue.data ? (
          <>
            {waiting} <Quiet>則等待{queue.data.paused ? " · 已暫停" : ""}</Quiet>
          </>
        ) : (
          <Quiet>—</Quiet>
        )}
      </Cell>
    </dl>
  );
}
