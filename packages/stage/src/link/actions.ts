// Capabilities of the Stage node: `stage.scene` (switch the OBS scene; she may do it herself)
// and `stage.stream` (OBS start / stop streaming; commands and the panel only, her own tool is
// `stream.start`, the Go Live that OBS follows).

import { type Capability, CapabilityError, defineCapability } from "@miyoria/actions";
import { actLane } from "@miyoria/types";
import { z } from "zod";
import { sceneNames } from "./commands.js";
import type { StageLink } from "./link.js";

const SceneArgs = z.object({ name: z.string().trim().min(1) });
const StreamArgs = z.object({ action: z.enum(["start", "stop"]) });
type SceneArgs = z.output<typeof SceneArgs>;
type StreamArgs = z.output<typeof StreamArgs>;

const STAGE_LANE = actLane("stage");

function requireNode(link: StageLink): void {
  if (!link.isConnected()) throw new CapabilityError("the stage node is not connected");
}

export function stageCapabilities(link: StageLink): Capability[] {
  const scene = defineCapability<SceneArgs>({
    name: "stage.scene",
    summary: "切換 OBS 場景",
    risk: "low",
    args: SceneArgs,
    permission: "stream.scene",
    tool: {
      name: "stage_scene",
      description: "切換直播畫面(OBS)的場景,例如聊天、遊戲、暫離。只能用直播機回報的場景名稱。",
      properties: { name: { type: "string", description: "場景名稱" } },
      required: ["name"],
    },
    lane: () => STAGE_LANE,
    // Only scenes the node reported (when it reports a list at all).
    check(args) {
      const status = link.status();
      const listed = Array.isArray(status?.scenes) ? status.scenes : [];
      const known = listed.length > 0 ? sceneNames(status) : [];
      if (known.length > 0 && !known.includes(args.name)) {
        return `unknown scene \`${args.name}\` (scenes: ${known.join(", ")})`;
      }
      return null;
    },
    async execute(args) {
      requireNode(link);
      const status = await link.setScene(args.name);
      return { text: `switched to scene ${args.name}`, data: { scene: status.scene } };
    },
  });

  const stream = defineCapability<StreamArgs>({
    name: "stage.stream",
    summary: "讓 OBS 開始或停止直播",
    risk: "medium",
    args: StreamArgs,
    permission: "stream.start",
    lane: () => STAGE_LANE,
    async execute(args) {
      requireNode(link);
      const status = await link.stream(args.action);
      return {
        text: `OBS stream ${args.action}`,
        data: { streaming: status.streaming, scene: status.scene },
      };
    },
  });

  return [scene, stream] as Capability[];
}
