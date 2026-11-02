import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
  type ServiceLookup,
  withTimeout,
} from "@miyoria/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import { type Clock, MindKey, type ProfileId, SALIENT_TOPIC } from "@miyoria/types";
import { MindConfigSchema } from "./config.js";
import { Journal } from "./journal.js";
import { MindLoop } from "./mind.js";

const STORE_TIMEOUT_MS = 5_000;

export interface MindModuleOptions {
  /** Her display name. */
  name?: string;
  /** Her persona prompt; looked up on every thought (the agent's live persona when it runs). */
  persona?: (services: ServiceLookup) => string;
  /** Replaces the time source (default: the module context's clock). */
  clock?: Clock;
}

/** Bus topics the mind follows. */
export const MIND_TOPICS = [
  "platform.ready",
  SALIENT_TOPIC,
  "agent.turn.completed",
  "agent.decision",
  "gate.decision",
  "voice.joined",
  "voice.left",
  "voice.participants",
  "voice.utterance",
  "voice.playback",
  "llm.budget",
];

/**
 * Module `mind`: her inner monologue. Wakes on `world.salient`, an adaptive heartbeat, the end
 * of her turns, a voice channel going quiet and suggestions (`MindKey.suggest`, e.g. from
 * initiative); asks the `mind` purpose what she thinks, applies it to her inner state
 * (`SelfStateKey`; affinity only as hints through social's daily caps) and hands her intents to
 * the agent (`IntentSinkKey`), where the gate decides. Keeps her thought journal (settings
 * `mind:thought:<id>`) and publishes `mind.thought`. Paused with autonomy.
 */
export class MindModule implements Module {
  static readonly ID = "mind";
  readonly manifest = defineManifest(MindModule.ID, "Mind", {
    description: "Her inner monologue: thoughts, feelings, policy, agenda and intents",
    requires: ["llm"],
    optional: ["self", "world", "agent", "actions", "social", "memory"],
    configSchema: MindConfigSchema,
  });
  readonly #profile: ProfileId;
  readonly #options: MindModuleOptions;
  #journal: Journal | null = null;

  constructor(profile: ProfileId, options: MindModuleOptions = {}) {
    this.#profile = profile;
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(MindConfigSchema);
    const store = ctx.services.get(SettingsStoreKey) ?? null;
    const journal = new Journal(store, this.#profile, config.journal_keep, (thought) =>
      MindLoop.publish((e) => ctx.publish(e), thought),
    );
    if (store) {
      try {
        const loaded = await withTimeout(
          journal.load().then(() => true),
          STORE_TIMEOUT_MS,
        );
        if (loaded === undefined) ctx.log.warn("loading her thought journal timed out");
      } catch (error) {
        ctx.log.warn({ err: errorMessage(error) }, "cannot load her thought journal");
      }
    }
    this.#journal = journal;
    const persona = this.#options.persona;
    const loop = new MindLoop({
      config,
      profile: this.#profile,
      name: this.#options.name ?? "她",
      persona: () => (persona ? persona(ctx.services) : ""),
      services: ctx.services,
      clock: this.#options.clock ?? ctx.clock,
      publish: (e) => ctx.publish(e),
      log: ctx.log,
      journal,
    });
    ctx.provide(MindKey, loop);
    const sub = ctx.subscribe(MIND_TOPICS);
    ctx.spawn("events", async () => {
      for await (const env of sub) {
        try {
          loop.observe(env);
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "could not handle event");
        }
      }
    });
    ctx.spawn("loop", (signal) => loop.run(signal));
  }

  async stop(): Promise<void> {
    await this.#journal?.flush();
    this.#journal = null;
  }
}
