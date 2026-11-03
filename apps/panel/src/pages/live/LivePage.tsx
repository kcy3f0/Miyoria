import { useStage, useWorld } from "@/app/queries";
import { EmergencyStop } from "@/components/live-state";
import { Page, PageHeader } from "@/components/page";
import { StatusBadge } from "@/components/status";
import { ChannelLevelsCard } from "./ChannelLevelsCard";
import { GameCard } from "./GameCard";
import { QueueCard } from "./QueueCard";
import { SayCard } from "./SayCard";
import { SceneRolesCard } from "./SceneRolesCard";
import { SongsCard } from "./SongsCard";
import { StageCard } from "./StageCard";
import { VoiceCard } from "./VoiceCard";

function LiveBadges() {
  const stage = useStage();
  const world = useWorld();
  const live = world.data?.her.golive === "live" || stage.data?.streaming;
  return (
    <>
      {live && (
        <StatusBadge tone="danger" pulse>
          直播中
        </StatusBadge>
      )}
      {stage.data?.speaking && (
        <StatusBadge tone="brand" pulse>
          說話中
        </StatusBadge>
      )}
      <EmergencyStop />
    </>
  );
}

export function LivePage() {
  return (
    <Page>
      <PageHeader title="直播" actions={<LiveBadges />} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-6">
        <div className="grid min-w-0 gap-4 lg:gap-6">
          <StageCard />
          <SongsCard />
          <QueueCard />
          <SceneRolesCard />
        </div>
        <div className="grid min-w-0 gap-4 lg:gap-6">
          <VoiceCard />
          <SayCard />
          <GameCard />
          <ChannelLevelsCard />
        </div>
      </div>
    </Page>
  );
}
