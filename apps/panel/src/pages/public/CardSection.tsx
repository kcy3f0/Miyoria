import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Share2, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import type { IssuedCard } from "@/api/types";
import { useApi } from "@/app/connection";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { notify } from "@/lib/notify";
import { CardFace, cardColors, cardFileName, cardPng, poseUrl, useInlined, verifyUrl } from "./card";

const CARDS = ["member", "cards"] as const;

/** The card with its pictures inlined, so the same `<svg>` can become a PNG. */
export function InlinedCard({ card, svgRef }: { card: IssuedCard; svgRef?: React.Ref<SVGSVGElement> }) {
  const art = useInlined(poseUrl(card.pose));
  const avatar = useInlined(card.avatar_url);
  const [colors] = useState(cardColors);
  return (
    <CardFace
      ref={svgRef}
      card={card}
      art={art.data ?? null}
      avatar={avatar.data ?? null}
      colors={colors}
      className="h-auto w-full rounded-[13px] shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
    />
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Share sheet with the picture where the browser has one; otherwise the link to the check page. */
async function share(card: IssuedCard, blob: Blob) {
  const file = new File([blob], cardFileName(card), { type: "image/png" });
  const url = verifyUrl(card.serial);
  const data = { files: [file], title: "她給我的卡", url };
  if (navigator.canShare?.(data)) {
    try {
      await navigator.share(data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      throw e;
    }
    return;
  }
  await navigator.clipboard.writeText(url);
  notify.ok("已複製這張卡的驗證連結");
}

/** Their newest card, a new one on request (a few a day), and the ways to take it with them. */
export function CardSection() {
  const api = useApi();
  const client = useQueryClient();
  const svg = useRef<SVGSVGElement>(null);
  const cards = useQuery({ queryKey: CARDS, queryFn: ({ signal }) => api.memberCards({ signal }) });
  const issue = useMutation({
    mutationFn: () => api.memberIssueCard(),
    onSuccess: (card) => {
      client.setQueryData(CARDS, (old: typeof cards.data) =>
        old ? { ...old, latest: card, today: old.today + 1 } : old,
      );
      void client.invalidateQueries({ queryKey: CARDS });
    },
    onError: (e) => notify.error(e),
  });
  const [busy, setBusy] = useState<"download" | "share" | null>(null);
  const run = async (what: "download" | "share", card: IssuedCard) => {
    if (!svg.current) return;
    setBusy(what);
    try {
      const blob = await cardPng(svg.current);
      if (what === "download") download(blob, cardFileName(card));
      else await share(card, blob);
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card aria-label="她給你的卡">
      <CardHeader>
        <CardTitle>她給你的卡</CardTitle>
      </CardHeader>
      <QueryView query={cards} skeleton={<SkeletonRows count={3} />}>
        {(c) => {
          const left = Math.max(0, c.per_day - c.today);
          return (
            <div className="grid gap-3">
              {c.latest ? (
                <InlinedCard card={c.latest} svgRef={svg} />
              ) : (
                <EmptyLine>還沒有卡,抽一張看看她怎麼看你</EmptyLine>
              )}
              <Button busy={issue.isPending} disabled={left === 0} onClick={() => issue.mutate()}>
                <Sparkles aria-hidden />
                {left === 0 ? "今天的卡抽完了" : `抽一張新卡(今天還有 ${left} 張)`}
              </Button>
              {c.latest && (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    busy={busy === "download"}
                    onClick={() => c.latest && void run("download", c.latest)}
                  >
                    <Download aria-hidden />
                    下載
                  </Button>
                  <Button
                    variant="outline"
                    busy={busy === "share"}
                    onClick={() => c.latest && void run("share", c.latest)}
                  >
                    <Share2 aria-hidden />
                    分享
                  </Button>
                </div>
              )}
            </div>
          );
        }}
      </QueryView>
    </Card>
  );
}
