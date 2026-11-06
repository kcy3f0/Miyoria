import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ACTIVITY_TABS, type ActivityTab } from "@/app/nav";
import { Page, PageHeader } from "@/components/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BodyTab } from "./BodyTab";
import { DecisionsTab } from "./DecisionsTab";
import { EventsTab } from "./EventsTab";
import { LedgerTab } from "./LedgerTab";
import { PromptsTab } from "./PromptsTab";
import { TranscriptTab } from "./TranscriptTab";

const route = getRouteApi("/activity");

export function ActivityPage() {
  const search = route.useSearch();
  // A turn link (`?turn=`) opens the prompt viewer.
  const tab = search.tab ?? (search.turn ? "prompts" : "events");
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
        <TabsContent value="body">
          <BodyTab />
        </TabsContent>
        <TabsContent value="ledger">
          <LedgerTab />
        </TabsContent>
        <TabsContent value="prompts">
          <PromptsTab />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
