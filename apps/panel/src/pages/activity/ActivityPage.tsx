import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ACTIVITY_TABS, type ActivityTab } from "@/app/nav";
import { Page, PageHeader } from "@/components/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DecisionsTab } from "./DecisionsTab";
import { EventsTab } from "./EventsTab";
import { TranscriptTab } from "./TranscriptTab";

const route = getRouteApi("/activity");

export function ActivityPage() {
  const { tab = "events" } = route.useSearch();
  const navigate = useNavigate();
  return (
    <Page>
      <PageHeader title="動態" />
      <Tabs value={tab} onValueChange={(t) => void navigate({ to: "/activity", search: { tab: t as ActivityTab }, replace: true })}>
        <TabsList>
          {ACTIVITY_TABS.map((t) => (
            <TabsTrigger key={t.tab} value={t.tab}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="events">
          <EventsTab />
        </TabsContent>
        <TabsContent value="decisions">
          <DecisionsTab />
        </TabsContent>
        <TabsContent value="transcript">
          <TranscriptTab />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
