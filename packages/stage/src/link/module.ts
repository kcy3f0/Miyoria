// Module `stage.link`.

import { type CommandRegistry, CommandRegistryKey } from "@miyoria/commands";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { isJsonObject } from "@miyoria/types";
import { type BoundAddress, formatAddress, HttpServer, isLoopback } from "../net.js";
import { registerStreamCommands, unregisterStreamCommands } from "./commands.js";
import { MAX_MESSAGE } from "./conn.js";
import { EMOTION_TOPIC, Forwarder } from "./forward.js";
import { goliveFollow, VOICE_GOLIVE_TOPIC } from "./golive.js";
import {
  DEFAULT_BIND,
  StageLink,
  StageLinkConfigSchema,
  StageLinkError,
  StageLinkKey,
} from "./link.js";

/** How long stop waits for the node to answer the close frame. */
const CLOSE_GRACE_MS = 2_000;

/** How often the Go Live follower retries OBS "Start Streaming" (the source may connect late). */
const GOLIVE_OBS_ATTEMPTS = 3;

interface Running {
  link: StageLink;
  registry: CommandRegistry | null;
}

/**
 * Module `stage.link`: serves the Stage Link WebSocket endpoint (`ws://<bind>/stage-link`),
 * forwards `agent.emotion`, `agent.turn.completed` and `voice.playback` to the Stage node and
 * provides `StageLinkKey`. Registers the `stream` commands when `CommandRegistryKey` is
 * available.
 */
export class StageLinkModule implements Module {
  static readonly ID = "stage.link";
  static readonly DEFAULT_BIND = DEFAULT_BIND;

  readonly manifest = defineManifest(StageLinkModule.ID, "Stage Link", {
    description: "WebSocket link to the Stage node (VTube Studio, OBS, overlay)",
    optional: ["commands"],
    configSchema: StageLinkConfigSchema,
  });

  #localAddr: BoundAddress | null = null;
  #running: Running | null = null;

  /** The address the server is bound to while running (useful with port 0). */
  localAddr(): BoundAddress | null {
    return this.#localAddr;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(StageLinkConfigSchema);
    if (config.token.trim() === "") {
      throw new StageLinkError(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the TOML interpolation syntax
        '`[modules."stage.link"] token` is empty: set the STAGE_LINK_TOKEN environment variable (with `token = "${STAGE_LINK_TOKEN}"`)',
      );
    }
    const link = new StageLink(ctx.id, ctx.bus, config, ctx.signal);
    const server = await HttpServer.listen(config.bind, "stage link", {
      ws: [{ path: "/stage-link", maxPayload: MAX_MESSAGE, onConnection: (ws) => link.serve(ws) }],
    });
    const addr = server.address;
    if (!isLoopback(addr.host)) {
      ctx.log.warn(
        { addr: formatAddress(addr) },
        "stage link is reachable from the network over plain WebSocket",
      );
    }
    this.#localAddr = addr;
    ctx.log.info({ addr: formatAddress(addr) }, "stage link listening");
    ctx.provide(StageLinkKey, link);

    const events = ctx.subscribe([
      EMOTION_TOPIC,
      "agent.turn.completed",
      "voice.playback",
      VOICE_GOLIVE_TOPIC,
    ]);
    const forwarder = new Forwarder(config.subtitle_text_turns);
    ctx.spawn("forward", async (signal) => {
      // Follow the voice node's Go Live with OBS (see golive.ts). Timers are cleared on stop.
      let goliveTimer: ReturnType<typeof setTimeout> | undefined;
      let wantStreaming = false;
      let attempts = 0;

      const clearTimer = (): void => {
        if (goliveTimer !== undefined) clearTimeout(goliveTimer);
        goliveTimer = undefined;
      };

      const stopObs = async (): Promise<void> => {
        if (!link.isConnected()) return;
        try {
          await link.stream("stop");
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "could not stop OBS after Go Live ended");
        }
      };

      const startObs = async (): Promise<void> => {
        goliveTimer = undefined;
        if (!wantStreaming || signal.aborted || !link.isConnected()) return;
        attempts += 1;
        try {
          const status = await link.stream("start");
          if (status.streaming) {
            ctx.log.info("OBS is streaming for Go Live");
            return;
          }
          ctx.log.warn({ attempt: attempts }, "OBS did not start streaming for Go Live");
        } catch (error) {
          ctx.log.warn(
            { err: errorMessage(error), attempt: attempts },
            "could not start OBS for Go Live",
          );
        }
        if (wantStreaming && !signal.aborted && attempts < GOLIVE_OBS_ATTEMPTS) {
          goliveTimer = setTimeout(
            () => void startObs(),
            Math.max(config.golive_start_delay_ms, 1_000),
          );
          goliveTimer.unref?.();
        }
      };

      const followGoLive = (payload: unknown): void => {
        if (!config.golive_obs) return;
        const action = goliveFollow(isJsonObject(payload) ? payload.state : undefined);
        if (action === null) return;
        clearTimer();
        if (action === "stop") {
          wantStreaming = false;
          void stopObs();
          return;
        }
        wantStreaming = true;
        attempts = 0;
        goliveTimer = setTimeout(() => void startObs(), config.golive_start_delay_ms);
        goliveTimer.unref?.();
      };

      try {
        for await (const env of events) {
          if (env.event.type === "custom" && env.event.data.topic === VOICE_GOLIVE_TOPIC) {
            followGoLive(env.event.data.payload);
            continue;
          }
          for (const msg of forwarder.onEvent(env.event)) {
            if (!link.send(msg) && link.isConnected()) {
              ctx.log.debug("stage node queue full, dropping a message");
            }
          }
        }
      } finally {
        wantStreaming = false;
        clearTimer();
      }
    });

    const registry = ctx.services.get(CommandRegistryKey) ?? null;
    try {
      if (registry) registerStreamCommands(registry, link);
    } catch (error) {
      await server.close();
      throw error;
    }
    this.#running = { link, registry };

    ctx.spawn("server", async (signal) => {
      await new Promise<void>((resolve, reject) => {
        server.server.once("error", reject);
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await server.close(CLOSE_GRACE_MS);
    });
  }

  async stop(): Promise<void> {
    this.#localAddr = null;
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    if (running.registry) unregisterStreamCommands(running.registry);
    running.link.closeAll();
  }

  async health(): Promise<Health> {
    const link = this.#running?.link;
    if (link && !link.isConnected())
      return { status: "degraded", reason: "stage node not connected" };
    return HEALTHY;
  }
}
