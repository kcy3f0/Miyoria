import { useMemo } from "react";
import type { PersonDetail, PersonSummary } from "@/api/types";
import { usePeopleDetails } from "@/app/queries";
import { ChartBlock, ChartEmpty, type LineSeries, TimeChart } from "@/components/charts/charts";
import { Skeleton } from "@/components/ui/misc";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
/** Lines on one chart; more would need small multiples. */
const MAX = 5;

/**
 * Affinity over time of the people she talks with most, on one time axis. Each person's level
 * holds until their next change.
 */
export function AffinityTrends({ people }: { people: PersonSummary[] }) {
  const top = useMemo(
    () =>
      people
        .filter((p) => p.relationship && !p.blocked)
        .sort((a, b) => (b.relationship?.interactions ?? 0) - (a.relationship?.interactions ?? 0))
        .slice(0, MAX),
    [people],
  );
  const details = usePeopleDetails(top.map((p) => p.person.id));
  const loaded = details.map((d) => d.data).filter((d): d is PersonDetail => Boolean(d));
  const pending = details.some((d) => d.isPending);

  const { times, series } = useMemo(() => {
    const all = new Set<number>();
    for (const d of loaded) for (const h of d.history ?? []) all.add(Date.parse(h.at));
    const times = [...all].sort((a, b) => a - b);
    const series: LineSeries[] = loaded.map((d, i) => {
      const hist = (d.history ?? []).map((h) => ({ t: Date.parse(h.at), v: h.affinity }));
      let k = -1;
      const values = times.map((t) => {
        while (k + 1 < hist.length && (hist[k + 1]?.t ?? Number.POSITIVE_INFINITY) <= t) k++;
        return k >= 0 ? (hist[k]?.v ?? null) : null;
      });
      return { key: d.person.id, label: d.person.display_name, color: COLORS[i % COLORS.length] as string, values };
    });
    return { times, series };
  }, [loaded]);

  if (top.length === 0) return null;
  return (
    <ChartBlock title="好感走勢" aside={`互動最多的 ${top.length} 個人`}>
      {pending && loaded.length === 0 ? (
        <Skeleton className="h-[200px] w-full" />
      ) : times.length < 2 ? (
        <ChartEmpty height={200}>還沒有好感變化的紀錄</ChartEmpty>
      ) : (
        <TimeChart label="好感走勢" times={times} series={series} domain={[-100, 100]} zero height={200} format={(v) => String(Math.round(v))} />
      )}
    </ChartBlock>
  );
}
