import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { INNER_TABS, type InnerTab } from "@/app/nav";
import { useSelf, useWorld } from "@/app/queries";
import { Page, PageHeader } from "@/components/page";
import { QueryView, SkeletonRows } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FeelingsTab } from "./FeelingsTab";
import { StateTab } from "./StateTab";
import { ThoughtsTab } from "./ThoughtsTab";
import { WorldTab } from "./WorldTab";

const route = getRouteApi("/inner");
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** What she is doing right now and her local time, from the world snapshot. */
function HerBadges() {
  const world = useWorld();
  const w = world.data;
  if (!w) return null;
  const her = w.her;
  const live = her.streaming || her.golive === "live";
  return (
    <>
      {live && (
        <StatusBadge tone="danger" pulse>
          直播中
        </StatusBadge>
      )}
      {her.game && <StatusBadge tone="brand">玩 {her.game}</StatusBadge>}
      {her.voice && <StatusBadge tone="success">在語音「{her.voice_name ?? her.voice.channel}」</StatusBadge>}
      <span className="text-[13px] text-muted-foreground tabular-nums">
        星期{WEEKDAY[w.time.weekday]} {w.time.part_of_day} {w.time.local.slice(11)}
      </span>
    </>
  );
}

function Loading() {
  return (
    <Card>
      <SkeletonRows count={5} />
    </Card>
  );
}

export function InnerPage() {
  const { tab = "state" } = route.useSearch();
  const navigate = useNavigate();
  const self = useSelf();
  const world = useWorld();
  return (
    <Page>
      <PageHeader title="內心" actions={<HerBadges />} />
      <Tabs value={tab} onValueChange={(t) => void navigate({ to: "/inner", search: { tab: t as InnerTab }, replace: true })}>
        <TabsList>
          {INNER_TABS.map((t) => (
            <TabsTrigger key={t.tab} value={t.tab}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="state">
          <QueryView query={self} skeleton={<Loading />}>
            {(s) => <StateTab self={s} />}
          </QueryView>
        </TabsContent>
        <TabsContent value="feelings">
          <QueryView query={self} skeleton={<Loading />}>
            {(s) => <FeelingsTab self={s} />}
          </QueryView>
        </TabsContent>
        <TabsContent value="thoughts">
          <ThoughtsTab />
        </TabsContent>
        <TabsContent value="world">
          <QueryView query={world} skeleton={<Loading />}>
            {(w) => <WorldTab world={w} />}
          </QueryView>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
