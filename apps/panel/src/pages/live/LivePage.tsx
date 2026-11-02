import { useStage, useVoice } from "@/app/queries";
import { Page, PageHeader } from "@/components/page";
import { StatusBadge } from "@/components/status";
import { QueueCard } from "./QueueCard";
import { SayCard } from "./SayCard";
import { SceneRolesCard } from "./SceneRolesCard";
import { StageCard } from "./StageCard";
import { VoiceCard } from "./VoiceCard";

function LiveBadges() {
  const stage = useStage();
  const voice = useVoice();
  const s = stage.data;
  const inVoice = (voice.data?.sessions.length ?? 0) > 0;
  return (
    <>
      {s?.streaming && (
        <StatusBadge tone="danger" pulse>
          直播中
        </StatusBadge>
      )}
      {s?.speaking && (
        <StatusBadge tone="brand" pulse>
          說話中
        </StatusBadge>
      )}
      {voice.isSuccess && <StatusBadge tone={inVoice ? "success" : "neutral"}>{inVoice ? "在語音" : "不在語音"}</StatusBadge>}
    </>
  );
}

export function LivePage() {
  return (
    <Page>
      <PageHeader title="直播" actions={<LiveBadges />} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 gap-6">
          <StageCard />
          <SceneRolesCard />
          <QueueCard />
        </div>
        <div className="grid min-w-0 gap-6">
          <SayCard />
          <VoiceCard />
        </div>
      </div>
    </Page>
  );
}
