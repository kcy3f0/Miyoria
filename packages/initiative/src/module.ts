import {
  defineManifest,
  errorMessage,
  getLogger,
  interval,
  type Module,
  type ModuleContext,
  SerialQueue,
  withTimeout,
} from "@miyoria/kernel";
import { type SettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type Clock,
  type Event,
  FollowupSourceKey,
  type JsonValue,
  MoodSignalsKey,
  type ProfileId,
  SocialSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { InitiativeConfigSchema } from "./config.js";
import {
  type Emission,
  Engine,
  emissionEvent,
  type Signals,
  type Snapshot,
  SnapshotSchema,
} from "./engine.js";

const log = getLogger("initiative");

/** Settings key of the persisted state. */
export const STATE_KEY = "initiative:state";
/** Profile under which the state is stored. */
export const STATE_PROFILE = "_global";

const STORE_TIMEOUT_MS = 5_000;

export interface InitiativeModuleOptions {
  /** Replaces the time source (default: the module context's clock). */
  clock?: Clock;
}

/** Module `initiative`; `profile` selects whose followups are polled. */
export class InitiativeModule implements Module {
  static readonly ID = "initiative";
  readonly manifest = defineManifest(InitiativeModule.ID, "Initiative", {
    description: "Decides when she starts a conversation on her own",
    optional: ["memory", "social", "mood"],
    configSchema: InitiativeConfigSchema,
  });
  readonly #profile: ProfileId;
  readonly #clock: Clock | undefined;

  constructor(profile: ProfileId, options: InitiativeModuleOptions = {}) {
    this.#profile = profile;
    this.#clock = options.clock;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(InitiativeConfigSchema);
    const engine = new Engine(config);
    const store = ctx.services.get(SettingsStoreKey);
    if (store) {
      try {
        const loaded = await withTimeout(loadState(store), STORE_TIMEOUT_MS);
        if (loaded === undefined) {
          log.warn("loading initiative state timed out");
        } else if (loaded !== null) {
          log.info("restored initiative counters");
          engine.restore(loaded);
        }
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "could not load initiative state");
      }
    }
    const events = ctx.subscribe([
      "platform.ready",
      "platform.message.created",
      "voice.joined",
      "voice.left",
      "voice.participants",
      "voice.utterance",
      "voice.playback",
    ]);
    const runner = new Runner(ctx, engine, this.#profile, this.#clock ?? ctx.clock, store);
    // Engine access is serialized: events and ticks never interleave.
    ctx.spawn("initiative.events", async () => {
      for await (const env of events) await runner.onEvent(env.event);
      await runner.persist();
    });
    ctx.spawn("initiative.tick", async (signal) => {
      for await (const _ of interval(Math.max(config.tick_secs, 1) * 1000, signal)) {
        await runner.onTick();
      }
    });
  }
}

async function loadState(store: SettingsStore): Promise<Snapshot | null> {
  const value = await store.get(STATE_PROFILE, STATE_KEY);
  if (value === null) return null;
  return SnapshotSchema.parse(value) as Snapshot;
}

class Runner {
  readonly #queue = new SerialQueue();
  /** Followups published whose `markDone` failed; never publish twice. */
  readonly #failedMarks = new Set<string>();

  constructor(
    private readonly ctx: ModuleContext,
    private readonly engine: Engine,
    private readonly profile: ProfileId,
    private readonly clock: Clock,
    private readonly store: SettingsStore | undefined,
  ) {}

  #signals(): Signals {
    return {
      social: this.ctx.services.get(SocialSignalsKey) ?? null,
      mood: this.ctx.services.get(MoodSignalsKey) ?? null,
    };
  }

  #publish(emission: Emission): void {
    this.ctx.publish(emissionEvent(emission));
  }

  onEvent(event: Event): Promise<void> {
    return this.#queue.run(async () => {
      const now = this.clock.now();
      for (const e of this.engine.observe(now, event, this.#signals())) this.#publish(e);
      await this.#persist();
    });
  }

  onTick(): Promise<void> {
    return this.#queue.run(async () => {
      await this.#onTick();
      await this.#persist();
    });
  }

  persist(): Promise<void> {
    return this.#queue.run(() => this.#persist());
  }

  async #onTick(): Promise<void> {
    const now = this.clock.now();
    const sig = this.#signals();
    for (const e of this.engine.tick(now, sig)) this.#publish(e);
    const source = this.ctx.services.get(FollowupSourceKey);
    if (!source) return;
    let due: Awaited<ReturnType<typeof source.due>> | undefined;
    try {
      due = await withTimeout(source.due(this.profile, toTimestamp(now)), STORE_TIMEOUT_MS);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not fetch due followups");
      return;
    }
    if (due === undefined) {
      log.warn("fetching due followups timed out");
      return;
    }
    for (const followup of due) {
      if (this.#failedMarks.has(followup.id)) continue;
      const emission = this.engine.planFollowup(now, followup, sig);
      if (!emission) continue;
      this.#publish(emission);
      try {
        await source.markDone(followup.id);
        log.debug({ id: followup.id }, "followup brought up");
      } catch (error) {
        log.warn({ id: followup.id, error: errorMessage(error) }, "could not mark followup done");
        this.#failedMarks.add(followup.id);
      }
    }
  }

  async #persist(): Promise<void> {
    if (!this.store) return;
    const snapshot = this.engine.takeSnapshot();
    if (!snapshot) return;
    try {
      const write = this.store.set(STATE_PROFILE, STATE_KEY, snapshot as unknown as JsonValue);
      if (
        (await withTimeout(
          write.then(() => true),
          STORE_TIMEOUT_MS,
        )) === undefined
      ) {
        log.warn("saving initiative state timed out");
      }
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not save initiative state");
    }
  }
}
