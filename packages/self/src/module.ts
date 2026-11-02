import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
  SerialQueue,
  withTimeout,
} from "@miyoria/kernel";
import { type SettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type Clock,
  DRIVE_NAMES,
  type Drives,
  type Event,
  isJsonObject,
  MoodSignalsKey,
  type ProfileId,
  type PromptContributors,
  PromptContributorsKey,
  SALIENT_TOPIC,
  SelfStateKey,
  WorldStateKey,
} from "@miyoria/types";
import { type SelfConfig, SelfConfigSchema } from "./config.js";
import { type Circumstances, IDLE, SelfEngine } from "./engine.js";
import { FeelingsBook } from "./feelings.js";
import { SelfPrompt } from "./prompt.js";
import { SelfService } from "./state.js";

/** Settings key of the persisted state (drives, boredom, policy, agenda). */
export const STATE_KEY = "self:state";
/** Bus topic of drive nudges from games and extensions (`{social?, ..., boredom?, reason}`). */
export const NUDGE_TOPIC = "self.nudge";

const STORE_TIMEOUT_MS = 5_000;

export interface SelfModuleOptions {
  /** Replaces the time source (default: the module context's clock). */
  clock?: Clock;
}

/** The satisfaction an event causes (negative deltas), if any. */
export function eventDelta(
  event: Event,
  config: SelfConfig,
  isSelf: (id: string) => boolean,
): { delta: Partial<Drives> & { boredom?: number }; reason: string } | null {
  const s = config.satisfy;
  switch (event.type) {
    case "agent_turn_completed":
      if (event.data.text.trim() === "") return null;
      return {
        delta: { social: -s.turn_social, attention: -s.turn_attention, boredom: -s.turn_boredom },
        reason: "turn",
      };
    case "platform_message_created": {
      const m = event.data;
      if (m.author.is_bot || isSelf(m.author.account.id)) return null;
      const direct = m.mentions_self || m.reply_to_self || m.id.context.kind === "dm";
      return direct
        ? {
            delta: { attention: -s.addressed_attention, boredom: -2 * s.ambient_boredom },
            reason: "addressed",
          }
        : { delta: { boredom: -s.ambient_boredom }, reason: "ambient" };
    }
    case "voice_utterance":
      if (event.data.speaker.is_bot || isSelf(event.data.speaker.account.id)) return null;
      return { delta: { boredom: -s.ambient_boredom }, reason: "voice" };
    case "custom": {
      const { topic, payload } = event.data;
      if (topic === SALIENT_TOPIC) {
        return {
          delta: { boredom: -s.salient_boredom, curiosity: -s.salient_curiosity },
          reason: "salient",
        };
      }
      if (topic === NUDGE_TOPIC && isJsonObject(payload)) {
        const delta: Partial<Drives> & { boredom?: number } = {};
        for (const key of [...DRIVE_NAMES, "boredom"] as const) {
          const v = payload[key];
          // One nudge moves a drive at most 0.5.
          if (typeof v === "number" && Number.isFinite(v)) {
            delta[key] = Math.min(Math.max(v, -0.5), 0.5);
          }
        }
        const reason = typeof payload.reason === "string" ? payload.reason : "nudge";
        return { delta, reason };
      }
      return null;
    }
    default:
      return null;
  }
}

interface Running {
  contributors: PromptContributors | undefined;
  save: () => Promise<void>;
}

/**
 * Module `self`: her drives, boredom, self-set policy, agenda and feelings. Provides
 * `SelfStateKey` and the `self` prompt section. Uses `SettingsStoreKey` to persist,
 * `MoodSignalsKey` (rest follows tiredness; the mood is part of snapshots) and `WorldStateKey`
 * (playing / live) when present.
 */
export class SelfModule implements Module {
  static readonly ID = "self";
  readonly manifest = defineManifest(SelfModule.ID, "Self", {
    description: "Her inner state: drives, boredom, her own policy, agenda and feelings",
    optional: ["mood", "world"],
    configSchema: SelfConfigSchema,
  });
  readonly #profile: ProfileId;
  readonly #options: SelfModuleOptions;
  #running: Running | null = null;

  constructor(profile: ProfileId, options: SelfModuleOptions = {}) {
    this.#profile = profile;
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(SelfConfigSchema);
    const clock = this.#options.clock ?? ctx.clock;
    const profile = this.#profile;
    const engine = new SelfEngine(config, clock.now());
    const store: SettingsStore | null = ctx.services.get(SettingsStoreKey) ?? null;
    const persist = config.persist ? store : null;
    const feelings = new FeelingsBook(store, profile, config.max_feeling_chars);
    if (store) {
      try {
        const loaded = await withTimeout(
          (async () => {
            await feelings.load();
            return persist ? await persist.get(profile, STATE_KEY) : null;
          })(),
          STORE_TIMEOUT_MS,
        );
        if (loaded === undefined) ctx.log.warn("loading her inner state timed out");
        else if (loaded !== null && !engine.restore(loaded, clock.now())) {
          ctx.log.warn("saved inner state is unreadable; starting fresh");
        }
      } catch (error) {
        ctx.log.warn({ err: errorMessage(error) }, "cannot load her inner state");
      }
    }

    const circumstances = (): Circumstances => {
      const mood = ctx.services.get(MoodSignalsKey)?.mood() ?? null;
      const her = ctx.services.get(WorldStateKey)?.snapshot().her ?? null;
      if (!mood && !her) return IDLE;
      return {
        energy: mood?.energy ?? null,
        playing: her?.game !== null && her?.game !== undefined,
        streaming: her ? her.streaming || her.golive === "live" : false,
      };
    };
    const saves = new SerialQueue();
    let dirty = false;
    const save = async () => {
      if (!persist || !dirty) return;
      dirty = false;
      try {
        await persist.set(profile, STATE_KEY, engine.toJson());
      } catch (error) {
        dirty = true;
        ctx.log.warn({ err: errorMessage(error) }, "cannot persist her inner state");
      }
    };
    const service = new SelfService({
      engine,
      feelings,
      clock,
      circumstances,
      mood: () => ctx.services.get(MoodSignalsKey)?.mood() ?? null,
      changed: (reason) => {
        dirty = true;
        ctx.log.debug({ reason }, "inner state changed");
        // Policy and agenda changes are saved right away; drift waits for the tick.
        if (reason !== "event") void saves.run(save).catch(() => undefined);
      },
    });
    ctx.provide(SelfStateKey, service);
    const contributors = ctx.services.get(PromptContributorsKey);
    if (config.prompt) {
      contributors?.register(new SelfPrompt(service, config.utc_offset_minutes));
    }
    this.#running = { contributors, save: () => saves.run(save) };

    const selfIds = new Set<string>();
    const sub = ctx.subscribe([
      "platform.ready",
      "platform.message.created",
      "voice.utterance",
      "agent.turn.completed",
      SALIENT_TOPIC,
      NUDGE_TOPIC,
    ]);
    ctx.spawn("events", async () => {
      for await (const env of sub) {
        const event = env.event;
        if (event.type === "platform_ready") {
          selfIds.add(event.data.self_account.id);
          continue;
        }
        const effect = eventDelta(event, config, (id) => selfIds.has(id));
        if (!effect) continue;
        service.now();
        engine.adjust(effect.delta);
        dirty = true;
      }
    });
    ctx.spawn("tick", async (signal) => {
      for await (const _ of interval(Math.max(config.tick_secs, 1) * 1000, signal)) {
        service.now();
        dirty = true;
        await saves.run(save);
      }
    });
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.contributors?.unregister(SelfPrompt.KEY);
    await running.save();
  }
}
