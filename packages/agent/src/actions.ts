// Capabilities the agent owns:
//
// * `channel.activeness`: she sets how lively she is in the current channel for a while (e.g.
//   when asked to join in more). With the `self` module it becomes her talkativeness for that
//   context (which attention follows, in text and voice); without it a temporary activeness.
//   Either way it reverts on its own.
// * `chat.start` / `chat.dm`: she starts talking on her own (an intent of her mind loop): in
//   the context of the request (a text channel or the voice channel she is in), or in a DM.
//   Medium risk, so her own rate limits apply; consent (`/me privacy approach` / `dm`) applies
//   to the person it is about.

import { type Capability, CapabilityError, defineCapability, recipient } from "@miyoria/actions";
import {
  CHAT_DM,
  CHAT_START,
  type Clock,
  contextKeyString,
  newId,
  PlatformSinksKey,
  type SelfState,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import type { AgentHandle } from "./handle.js";
import type { AgentIntents } from "./intents.js";
import type { Agent, IntentTurn } from "./runtime.js";

export const ACTIVENESS_CAPABILITY = "channel.activeness";

/** Longest she may set it for. */
export const MAX_ACTIVENESS_MINUTES = 240;

const Args = z.object({
  level: z.enum(["low", "medium", "high"]),
  minutes: z.number().int().min(5).max(MAX_ACTIVENESS_MINUTES).nullish(),
});
type Args = z.output<typeof Args>;

const LEVEL_TEXT = { low: "安靜", medium: "普通", high: "活躍" } as const;

/** Talkativeness of each activeness level. */
export const LEVEL_TALKATIVENESS = { low: 0.2, medium: 0.5, high: 0.85 } as const;

export function activenessCapability(
  handle: AgentHandle,
  clock: Clock,
  self: () => SelfState | undefined = () => undefined,
): Capability {
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
      const state = self();
      if (state) {
        state.setTalkativeness(contextKeyString(context), {
          level: LEVEL_TALKATIVENESS[args.level],
          forMs: minutes * 60_000,
          why: ctx.request.why ?? `活躍度 ${LEVEL_TEXT[args.level]}`,
        });
      } else {
        handle.setTemporaryActiveness(context, args.level, clock.now() + minutes * 60_000);
      }
      return {
        text: `activeness ${args.level} (${LEVEL_TEXT[args.level]}) for ${minutes} min here`,
        data: { level: args.level, minutes },
      };
    },
  }) as Capability;
}

/** How long an intent turn may wait when `chat.*` is invoked without one (e.g. by the panel). */
const ADHOC_TTL_MS = 120_000;

/** The intent turn behind a `chat.*` run: the one `submit` prepared, or one made up from args. */
function intentTurn(
  intents: AgentIntents,
  clock: Clock,
  capability: string,
  turn: string | null,
  why: string | null,
): IntentTurn {
  const prepared = intents.take(turn);
  if (prepared) return prepared;
  const now = clock.now();
  return {
    intent: {
      id: newId(),
      capability,
      args: {},
      why: why ?? "",
      opening: null,
      context: null,
      about: null,
      created_at: toTimestamp(now),
      expires_at: toTimestamp(now + ADHOC_TTL_MS),
    },
    turn: turn ?? newId(),
    done: null,
    summary: null,
  };
}

const NoArgs = z.object({});
const DmArgs = z.object({ to: z.string().trim().min(1).max(64) });

/** `chat.start` and `chat.dm`, bound to the running agent. */
export function chatCapabilities(agent: Agent, intents: AgentIntents): Capability[] {
  const clock = agent.ctx.clock;
  const start = defineCapability<z.output<typeof NoArgs>>({
    name: CHAT_START,
    summary: "主動開口說話(在頻道或她所在的語音頻道)",
    risk: "medium",
    args: NoArgs,
    permission: null,
    limits: { per_day: 24, per_person_per_day: 4, cooldown_ms: 60_000 },
    scope: (_args, principal) => principal.context?.scope ?? null,
    check: (_args, principal) => {
      const context = principal.context;
      if (context === null) return "no context to talk in";
      if (context.kind === "dm") return "use chat.dm for DMs";
      if (context.kind === "voice" && !agent.inVoice(context)) {
        return "she is not in that voice channel";
      }
      return null;
    },
    async execute(_args, ctx) {
      const context = ctx.principal.context;
      if (context === null) throw new CapabilityError("no context to talk in");
      const input = intentTurn(intents, clock, CHAT_START, ctx.request.turn, ctx.request.why);
      const why = agent.deliverIntent(context, input);
      if (why !== null) throw new CapabilityError(why);
      return { text: "her turn is queued", data: { turn: input.turn } };
    },
  });
  const dm = defineCapability<z.output<typeof DmArgs>>({
    name: CHAT_DM,
    summary: "主動私訊某個人聊天",
    risk: "medium",
    args: DmArgs,
    permission: "chat.dm",
    consent: "dm",
    limits: { per_day: 6, per_person_per_day: 2, cooldown_ms: 600_000 },
    target: (args, principal) => recipient(args.to, principal),
    check: (args, principal) =>
      recipient(args.to, principal) === null ? "`to` must be a mention or an id" : null,
    async execute(args, ctx) {
      const to = recipient(args.to, ctx.principal);
      if (to === null) throw new CapabilityError("no recipient");
      const sink = ctx.services.get(PlatformSinksKey)?.get(to.platform);
      if (!sink?.openDm) throw new CapabilityError(`cannot send DMs on ${to.platform}`);
      const context = await sink.openDm(to, ctx.signal);
      const input = intentTurn(intents, clock, CHAT_DM, ctx.request.turn, ctx.request.why);
      const why = agent.deliverIntent(context, input);
      if (why !== null) throw new CapabilityError(why);
      return { text: "her DM turn is queued", data: { turn: input.turn } };
    },
  });
  return [start as Capability, dm as Capability];
}
