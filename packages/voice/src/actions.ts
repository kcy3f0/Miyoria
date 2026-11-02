// Capabilities of the voice node: `voice.join`, `voice.leave`, `stream.start` and `stream.stop`
// (Discord Go Live; OBS follows `voice.golive` on the Stage side). Registered in the actuator
// registry by the voice module; `/voice ...` and her tools both call them through the gate.

import { type Capability, CapabilityError, defineCapability } from "@miyoria/actions";
import { errorMessage } from "@miyoria/kernel";
import { actLane, type Principal, StreamCurtainKey, type WorldState } from "@miyoria/types";
import { z } from "zod";
import type { VoiceLink } from "./link/link.js";

/** Joining her voice channel failed while starting Go Live. */
export class GoLiveJoinError extends CapabilityError {
  override readonly name = "GoLiveJoinError";
}

const Id = z.string().trim().min(1).max(64);

const GuildArgs = z.object({ guild: Id.nullish() });
const JoinArgs = GuildArgs.extend({ channel: Id.nullish() });
const GoLiveArgs = GuildArgs.extend({ source: z.string().trim().min(1).nullish() });
type GuildArgs = z.output<typeof GuildArgs>;
type JoinArgs = z.output<typeof JoinArgs>;
type GoLiveArgs = z.output<typeof GoLiveArgs>;

/** The guild of the request: the argument, else the principal's context. */
function guildOf(args: GuildArgs, principal: Principal): string | null {
  return args.guild ?? principal.context?.scope ?? null;
}

function requireGuild(args: GuildArgs, principal: Principal): string {
  const guild = guildOf(args, principal);
  if (guild === null) throw new CapabilityError("not in a server");
  return guild;
}

function lane(args: GuildArgs, principal: Principal): string | null {
  const guild = guildOf(args, principal);
  const platform = principal.context?.platform ?? "discord";
  return guild === null ? null : actLane(`voice:${platform}:${guild}`);
}

function requireNode(link: VoiceLink): void {
  if (!link.isConnected()) throw new CapabilityError("her voice account is not online");
}

const GUILD_PROPERTY = { type: "string", description: "伺服器 id(省略 = 這個伺服器)" };

/**
 * Where to join for `principal`'s request in `guild`: the requester's current voice channel as the
 * bot sees it (`world`), else ask the voice node to look the requester up (`follow`).
 */
export function joinTarget(
  guild: string,
  principal: Principal,
  world: WorldState | undefined,
): { channel: string | null; follow: string | null } {
  const requester = principal.requester ?? null;
  if (requester === null) {
    // Nobody asked (her own idea): the voice channel of this server with the most people in it.
    const busiest = (world?.snapshot().voice_channels ?? [])
      .filter((c) => c.guild === guild)
      .map((c) => ({ channel: c.channel, people: c.members.filter((m) => !m.is_self).length }))
      .filter((c) => c.people > 0)
      .sort((a, b) => b.people - a.people)[0];
    return { channel: busiest?.channel ?? null, follow: null };
  }
  const spot = world?.person(requester)?.voice ?? null;
  if (spot !== null && spot.guild === guild && spot.platform === requester.platform) {
    return { channel: spot.channel, follow: null };
  }
  return { channel: null, follow: requester.id };
}

/** The four capabilities, bound to `link` (and the default Go Live source). */
export function voiceCapabilities(
  link: VoiceLink,
  goliveSource: () => string,
  world: () => WorldState | undefined = () => undefined,
): Capability[] {
  const join = defineCapability<JoinArgs>({
    name: "voice.join",
    summary: "加入語音頻道",
    risk: "medium",
    args: JoinArgs,
    permission: "voice.join",
    tool: {
      name: "voice_join",
      description:
        "進語音頻道一起聊天。channel 省略 = 跟你說話的人現在所在的語音頻道(對方要在語音裡)。",
      properties: {
        channel: { type: "string", description: "語音頻道 id(通常省略)" },
        guild: GUILD_PROPERTY,
      },
    },
    scope: guildOf,
    lane,
    async execute(args, ctx) {
      const guild = requireGuild(args, ctx.principal);
      requireNode(link);
      const target =
        args.channel != null
          ? { channel: args.channel, follow: null }
          : joinTarget(guild, ctx.principal, world());
      if (target.channel === null && target.follow === null) {
        throw new CapabilityError("no channel given and nobody to follow");
      }
      const joined = await link.join(guild, target.channel, target.follow);
      return { text: `joined voice channel ${joined}`, data: { channel: joined } };
    },
  });

  const leave = defineCapability<GuildArgs>({
    name: "voice.leave",
    summary: "離開語音頻道",
    risk: "medium",
    args: GuildArgs,
    permission: "voice.leave",
    tool: {
      name: "voice_leave",
      description: "離開你現在所在的語音頻道。",
      properties: { guild: GUILD_PROPERTY },
    },
    scope: guildOf,
    lane,
    async execute(args, ctx) {
      const guild = requireGuild(args, ctx.principal);
      if (link.channel(guild) === null) {
        return { text: "she is not in a voice channel", data: { left: false } };
      }
      await link.leave(guild);
      return { text: "left the voice channel", data: { left: true } };
    },
  });

  const start = defineCapability<GoLiveArgs>({
    name: "stream.start",
    summary: "開始 Go Live 直播",
    risk: "medium",
    args: GoLiveArgs,
    permission: "voice.golive",
    tool: {
      name: "stream_start",
      description:
        "開直播 / 開台:在 Discord 語音頻道 Go Live(直播機的 OBS 會跟著開播),跟玩遊戲無關。還不在語音時會先進對方所在的語音頻道。",
      properties: { guild: GUILD_PROPERTY },
    },
    scope: guildOf,
    lane,
    async execute(args, ctx) {
      const guild = requireGuild(args, ctx.principal);
      requireNode(link);
      if (link.isStreaming(guild)) {
        return { text: "already live", data: { already: true, joined: false } };
      }
      const source = (args.source ?? goliveSource()).trim();
      if (source === "") throw new CapabilityError("no Go Live source configured");
      let joined = false;
      if (link.channel(guild) === null) {
        const target = joinTarget(guild, ctx.principal, world());
        if (target.channel === null && target.follow === null) {
          throw new GoLiveJoinError("not in voice and nobody to follow");
        }
        try {
          await link.join(guild, target.channel, target.follow);
          joined = true;
        } catch (error) {
          throw new GoLiveJoinError(errorMessage(error), { cause: error });
        }
      }
      await link.goliveStart({ guild, source });
      return { text: "Go Live started", data: { already: false, joined } };
    },
  });

  const stop = defineCapability<GuildArgs>({
    name: "stream.stop",
    summary: "結束 Go Live 直播",
    risk: "medium",
    args: GuildArgs,
    permission: "voice.golive",
    tool: {
      name: "stream_stop",
      description: "結束 Discord Go Live 直播(OBS 也會停止直播)。",
      properties: { guild: GUILD_PROPERTY },
    },
    scope: guildOf,
    lane,
    async execute(args, ctx) {
      const guild = requireGuild(args, ctx.principal);
      if (!link.isStreaming(guild)) return { text: "not live", data: { stopped: false } };
      // The stage shows the ending scene for a moment first (when it has one).
      await ctx.services.get(StreamCurtainKey)?.close(ctx.signal);
      await link.goliveStop(guild);
      return { text: "Go Live stopped", data: { stopped: true } };
    },
  });

  return [join, leave, start, stop] as Capability[];
}
