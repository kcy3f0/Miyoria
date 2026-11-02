// The voice capabilities as her tools: each calls the voice link through the gate.

import { ActuatorRegistry } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { type ToolContext, ToolRegistry } from "@miyoria/tools";
import {
  type AccountRef,
  AuthorizerKey,
  BaseAuthorizer,
  type ContextKey,
  type Event,
  Principals,
  type StreamCurtain,
  StreamCurtainKey,
  type Subject,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { joinTarget, voiceCapabilities } from "../src/actions.js";
import type { VoiceLink } from "../src/index.js";

const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OWEN: AccountRef = { platform: "discord", id: "7" };

class Grants extends BaseAuthorizer {
  constructor(readonly nodes: Set<string>) {
    super();
  }

  allowsSubject(_subject: Subject, node: string): boolean {
    return this.nodes.has(node);
  }
}

class FakeLink {
  readonly calls: string[] = [];
  connected = true;
  inVoice: string | null = null;
  streaming = false;

  isConnected() {
    return this.connected;
  }

  channel() {
    return this.inVoice;
  }

  isStreaming() {
    return this.streaming;
  }

  async join(guild: string, channel: string | null, user: string | null) {
    this.calls.push(`join ${guild} ${channel} ${user}`);
    this.inVoice = channel ?? "vc-of-user";
    return this.inVoice;
  }

  async leave(guild: string) {
    this.calls.push(`leave ${guild}`);
    this.inVoice = null;
  }

  async goliveStart(req: { guild: string; source: string }) {
    this.calls.push(`golive ${req.guild} ${req.source}`);
    this.streaming = true;
  }

  async goliveStop(guild: string) {
    this.calls.push(`golive_stop ${guild}`);
    this.streaming = false;
  }
}

function setup(nodes: string[]) {
  const link = new FakeLink();
  const services = new ServiceRegistry();
  services.provide("test", AuthorizerKey, new Grants(new Set(nodes)));
  const tools = new ToolRegistry();
  const events: Event[] = [];
  const registry = new ActuatorRegistry({
    services,
    tools,
    builtins: false,
    publish: (e) => events.push(e),
  });
  for (const c of voiceCapabilities(link as unknown as VoiceLink, () => "rtmp://obs/live")) {
    registry.register(c);
  }
  const ctx: ToolContext = {
    turn: "01JC0000000000000000000000",
    context: CTX,
    account: OWEN,
    principal: Principals.user(OWEN, CTX),
    message: { context: CTX, id: "m" },
    priority: "direct",
    signal: new AbortController().signal,
  };
  return { link, tools, registry, ctx, events, services };
}

describe("voice capabilities", () => {
  it("voice_join follows the requester; leave, go live and stop go through the gate", async () => {
    const s = setup(["voice.join", "voice.leave", "voice.golive"]);
    expect(s.tools.names()).toEqual(["stream_start", "stream_stop", "voice_join", "voice_leave"]);
    expect(await s.tools.get("voice_join")?.call(s.ctx, { why: "Owen 叫我" })).toContain(
      "joined voice channel",
    );
    expect(await s.tools.get("stream_start")?.call(s.ctx, {})).toBe("Go Live started");
    expect(await s.tools.get("stream_stop")?.call(s.ctx, {})).toBe("Go Live stopped");
    expect(await s.tools.get("voice_leave")?.call(s.ctx, {})).toBe("left the voice channel");
    expect(s.link.calls).toEqual([
      "join g1 null 7",
      "golive g1 rtmp://obs/live",
      "golive_stop g1",
      "leave g1",
    ]);
    const decisions = s.events.flatMap((e) =>
      e.type === "custom" && e.data.topic === "gate.decision"
        ? [e.data.payload as Record<string, unknown>]
        : [],
    );
    expect(decisions.map((d) => d.capability)).toEqual([
      "voice.join",
      "stream.start",
      "stream.stop",
      "voice.leave",
    ]);
    expect(decisions[0]).toMatchObject({ why: "Owen 叫我", principal: { kind: "user" } });
  });

  it("a request she may not take is refused before the link is touched", async () => {
    const s = setup([]);
    await expect(s.tools.get("stream_start")?.call(s.ctx, {})).rejects.toThrow(/not allowed/);
    expect(s.link.calls).toEqual([]);
    // Going live joins the requester first when she is not in voice yet.
    expect(await s.tools.get("stream_start")?.call(s.ctx, { on_own: true })).toBe(
      "Go Live started",
    );
    expect(s.link.calls).toEqual(["join g1 null 7", "golive g1 rtmp://obs/live"]);
  });

  it("stream_stop lets the stage show the ending scene first", async () => {
    const s = setup(["voice.golive"]);
    s.link.streaming = true;
    s.link.inVoice = "vc1";
    const curtain: StreamCurtain = {
      close: async () => {
        s.link.calls.push("curtain");
      },
    };
    s.services.provide("stage.link", StreamCurtainKey, curtain);
    expect(await s.tools.get("stream_stop")?.call(s.ctx, {})).toBe("Go Live stopped");
    expect(s.link.calls).toEqual(["curtain", "golive_stop g1"]);
  });

  it("another server is off limits for her and chat requests", async () => {
    const s = setup(["voice.join"]);
    await expect(s.tools.get("voice_join")?.call(s.ctx, { guild: "g2" })).rejects.toThrow(
      /not across servers/,
    );
    expect(s.link.calls).toEqual([]);
  });
});

describe("joinTarget", () => {
  const requester = { platform: "discord", id: "u1" };
  const principal = { kind: "user", requester, context: null } as never;
  const worldWith = (voice: { guild: string; channel: string } | null) =>
    ({
      person: () =>
        voice === null
          ? null
          : { voice: { platform: "discord", guild: voice.guild, channel: voice.channel } },
    }) as never;

  it("uses the requester's channel from the bot's world view", () => {
    expect(joinTarget("g1", principal, worldWith({ guild: "g1", channel: "vc9" }))).toEqual({
      channel: "vc9",
      follow: null,
    });
  });

  it("falls back to asking the voice node when the world doesn't know", () => {
    expect(joinTarget("g1", principal, undefined)).toEqual({ channel: null, follow: "u1" });
    expect(joinTarget("g1", principal, worldWith(null))).toEqual({ channel: null, follow: "u1" });
    // In voice, but on another server.
    expect(joinTarget("g1", principal, worldWith({ guild: "g2", channel: "vc9" }))).toEqual({
      channel: null,
      follow: "u1",
    });
  });

  it("on her own idea joins the busiest voice channel of the server", () => {
    const self = { kind: "self", requester: null } as never;
    expect(joinTarget("g1", self, undefined)).toEqual({ channel: null, follow: null });
    const member = (self: boolean) => ({ is_self: self });
    const world = {
      snapshot: () => ({
        voice_channels: [
          { guild: "g1", channel: "quiet", members: [member(true)] },
          { guild: "g1", channel: "two", members: [member(false), member(false)] },
          { guild: "g1", channel: "one", members: [member(false)] },
          {
            guild: "g2",
            channel: "elsewhere",
            members: [member(false), member(false), member(false)],
          },
        ],
      }),
    } as never;
    expect(joinTarget("g1", self, world)).toEqual({ channel: "two", follow: null });
  });
});
