// Capability `channel.activeness`: she sets how lively she is in the current channel for a
// while (e.g. when asked to join in more); it reverts on its own.

import { type Capability, CapabilityError, defineCapability } from "@miyoria/actions";
import type { Clock } from "@miyoria/types";
import { z } from "zod";
import type { AgentHandle } from "./handle.js";

export const ACTIVENESS_CAPABILITY = "channel.activeness";

/** Longest she may set it for. */
export const MAX_ACTIVENESS_MINUTES = 240;

const Args = z.object({
  level: z.enum(["low", "medium", "high"]),
  minutes: z.number().int().min(5).max(MAX_ACTIVENESS_MINUTES).nullish(),
});
type Args = z.output<typeof Args>;

const LEVEL_TEXT = { low: "安靜", medium: "普通", high: "活躍" } as const;

export function activenessCapability(handle: AgentHandle, clock: Clock): Capability {
  return defineCapability<Args>({
    name: ACTIVENESS_CAPABILITY,
    summary: "暫時調整她在這個頻道的活躍程度",
    risk: "low",
    args: Args,
    permission: "admin.channel.activeness",
    tool: {
      name: "channel_activeness",
      description:
        "暫時調整你在這個頻道(或語音頻道)有多愛插話:low 安靜、medium 普通、high 活躍。" +
        "時間到會自己恢復。例如大家希望你熱鬧一點,或你想安靜一陣子時用。",
      properties: {
        level: { type: "string", enum: ["low", "medium", "high"] },
        minutes: {
          type: "integer",
          minimum: 5,
          maximum: MAX_ACTIVENESS_MINUTES,
          description: "維持幾分鐘(預設 30)",
        },
      },
      required: ["level"],
    },
    scope: (_args, principal) => principal.context?.scope ?? null,
    async execute(args, ctx) {
      const context = ctx.principal.context;
      if (context === null) throw new CapabilityError("no channel to set");
      const minutes = args.minutes ?? 30;
      handle.setTemporaryActiveness(context, args.level, clock.now() + minutes * 60_000);
      return {
        text: `activeness ${args.level} (${LEVEL_TEXT[args.level]}) for ${minutes} min here`,
        data: { level: args.level, minutes },
      };
    },
  }) as Capability;
}
