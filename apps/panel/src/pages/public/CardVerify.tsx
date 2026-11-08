import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, CircleX } from "lucide-react";
import { isApiError } from "@/api/http";
import { useApi } from "@/app/connection";
import { Logo } from "@/components/logo";
import { SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { InlinedCard } from "./CardSection";

/** `#/card/<serial>`: the serial on the address, or `null`. */
export function cardSerialIn(hash: string): string | null {
  const m = /^#\/card\/([^/?#]+)/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

const longDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

/**
 * Where a card's code leads, open to anyone: the card as it was issued and whether it is real.
 * Revoked and made-up serials look the same.
 */
export function CardVerify({ serial }: { serial: string }) {
  const api = useApi();
  const card = useQuery({
    queryKey: ["public", "card", serial],
    queryFn: ({ signal }) => api.publicCard(serial, { signal }),
    retry: (n, e) => !(isApiError(e) && (e.status === 404 || e.status === 429)) && n < 2,
  });
  const missing = isApiError(card.error) && card.error.status === 404;
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 px-4 py-10">
      <a href="/" className="flex items-center gap-2.5">
        <Logo className="size-5 text-primary" />
        <span className="text-[15px] font-semibold">Miyoria</span>
      </a>
      <main className="glass-float grid w-full max-w-sm gap-5 rounded-lg p-5">
        {card.isPending ? (
          <SkeletonRows count={6} />
        ) : card.data ? (
          <>
            <InlinedCard card={card.data} />
            <div role="status" className="flex gap-2.5">
              <BadgeCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
              <div className="grid gap-0.5">
                <p className="text-sm font-semibold">這張卡是真的</p>
                <p className="text-[13px] text-muted-foreground">
                  她在 {longDate(card.data.issued_at)}發給 {card.data.name} 的第 {card.data.number} 張卡
                </p>
              </div>
            </div>
          </>
        ) : (
          <div role="alert" className="flex gap-2.5">
            <CircleX aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="grid gap-0.5">
              <p className="text-sm font-semibold">{missing ? "這張卡不存在或已經作廢" : "現在沒辦法確認這張卡"}</p>
              <p className="font-mono text-[13px] break-all text-muted-foreground">{serial}</p>
            </div>
          </div>
        )}
        <Button asChild variant="outline">
          <a href="/">登入看她怎麼看你</a>
        </Button>
      </main>
    </div>
  );
}
