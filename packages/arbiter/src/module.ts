import { ActuatorRegistryKey } from "@miyoria/actions";
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
import { LlmRouterKey } from "@miyoria/llm";
import { type SettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  ARBITER_IMPULSE_TOPIC,
  ArbiterKey,
  type Clock,
  type Envelope,
  FollowupSourceKey,
  type Impulse,
  ImpulseHostKey,
  type ImpulseRun,
  isJsonObject,
  type JsonValue,
  Principals,
  type ProfileId,
  SocialSignalsKey,
  TURN_FOCUS_TOPIC,
  TURN_OUTCOME_TOPIC,
  toTimestamp,
  v2Payload,
} from "@miyoria/types";
import { z } from "zod";
import { ArbiterCore } from "./arbiter.js";
import { type ArbiterConfig, ArbiterConfigSchema, INITIATIVE_KEYS } from "./config.js";
import { LedgerSnapshotSchema } from "./ledger.js";
import { ProducerSnapshotSchema, Producers } from "./producers.js";

const log = getLogger("arbiter");

/** Settings key of the persisted state (counters, backoff, topics, greetings). */
export const STATE_KEY = "arbiter:state";
/** Profile under which the state is stored. */
export const STATE_PROFILE = "_global";

const STORE_TIMEOUT_MS = 5_000;
/** The queue is looked at least this often. */
const PUMP_MS = 1_000;

const StateSchema = z.object({
  ledger: LedgerSnapshotSchema.prefault({}),
  producers: ProducerSnapshotSchema.prefault({}),
});

export interface ArbiterModuleOptions {
  /** Replaces the time source (default: the module context's clock). */
  clock?: Clock;
  /**
   * The old `[modules.initiative]` section, if the config file still has one: its keys that
   * moved are used (unless `[modules.arbiter]` sets them) with a deprecation warning.
   */
  legacyInitiative?: JsonValue | null;
}

/**
 * Module `arbiter`: the one gate for everything that wants her to speak or act without being
 * asked (docs/design/v2-architecture.md §3.3). Provides `ArbiterKey`; publishes
 * `arbiter.decision`, `arbiter.ledger` and `affect.event` `topic_ignored`; takes impulses from
 * `ArbiterKey.submit` and the `arbiter.impulse` topic. Accepted speak impulses are opened by the
 * agent (`ImpulseHostKey`). Greets friends and brings up due followups (`FollowupSourceKey`).
 */
export class ArbiterModule implements Module {
  static readonly ID = "arbiter";
  readonly manifest = defineManifest(ArbiterModule.ID, "Arbiter", {
    description: "Decides whether she speaks or acts now; keeps her ledger",
    optional: ["agent", "actions", "llm", "social", "memory"],
    configSchema: ArbiterConfigSchema,
  });
  readonly #profile: ProfileId;
  readonly #clock: Clock | undefined;
  readonly #legacy: JsonValue | null;

  constructor(profile: ProfileId, options: ArbiterModuleOptions = {}) {
    this.#profile = profile;
    this.#clock = options.clock;
    this.#legacy = options.legacyInitiative ?? null;
  }

  #config(ctx: ModuleContext): ArbiterConfig {
    const own = isJsonObject(ctx.rawConfig) ? ctx.rawConfig : {};
    const legacy = isJsonObject(this.#legacy) ? this.#legacy : {};
    const carried: Record<string, JsonValue> = {};
    const moved: string[] = [];
    for (const [key, value] of Object.entries(legacy)) {
      if (key === "enabled" || value === undefined) continue;
      moved.push(key);
      const to = INITIATIVE_KEYS[key];
      if (to && !(to in own)) carried[to] = value;
    }
    if (moved.length > 0) {
      log.warn(
        { keys: moved },
        "[modules.initiative] is deprecated: the arbiter replaced it; move these keys to [modules.arbiter]",
      );
    }
    if (Object.keys(carried).length === 0) return ctx.config(ArbiterConfigSchema);
    return ArbiterConfigSchema.parse({ ...carried, ...own });
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = this.#config(ctx);
    const clock = this.#clock ?? ctx.clock;
    const services = ctx.services;
    const core = new ArbiterCore(config, {
      now: () => clock.now(),
      publish: (event) => ctx.publish(event),
      paused: () => services.get(ActuatorRegistryKey)?.paused ?? false,
      budget: () => services.get(LlmRouterKey)?.budgetState() ?? "ok",
      blocked: (account) => services.get(SocialSignalsKey)?.attitude(account)?.blocked ?? false,
      host: () => services.get(ImpulseHostKey) ?? null,
      act: (impulse, signal) => actThroughGate(ctx, impulse, signal),
    });
    const producers = new Producers(config);
    const store = services.get(SettingsStoreKey);
    if (store) await restore(store, core, producers, clock.now());
    ctx.provide(ArbiterKey, core);

    const runner = new Runner(ctx, core, producers, this.#profile, clock, store);
    const events = ctx.subscribe([
      "platform.ready",
      "platform.message.created",
      "voice.joined",
      "voice.left",
      "voice.participants",
      "voice.utterance",
      "agent.turn.completed",
      TURN_OUTCOME_TOPIC,
      TURN_FOCUS_TOPIC,
      ARBITER_IMPULSE_TOPIC,
    ]);
    ctx.spawn("arbiter.events", async () => {
      for await (const env of events) runner.onEvent(env);
      await runner.persist();
    });
    ctx.spawn("arbiter.tick", async (signal) => {
      for await (const _ of interval(config.tick_secs * 1000, signal)) await runner.onTick();
    });
    ctx.spawn("arbiter.queue", async (signal) => {
      for await (const _ of interval(Math.min(config.retry_ms, PUMP_MS), signal)) {
        const next = core.nextRetry();
        if (next !== null && next <= clock.now()) await core.pump();
      }
    });
  }
}

async function restore(
  store: SettingsStore,
  core: ArbiterCore,
  producers: Producers,
  now: number,
): Promise<void> {
  try {
    const value = await withTimeout(store.get(STATE_PROFILE, STATE_KEY), STORE_TIMEOUT_MS);
    if (value === undefined) {
      log.warn("loading arbiter state timed out");
      return;
    }
    if (value === null) return;
    const state = StateSchema.parse(value);
    core.book.restore(state.ledger, now);
    producers.restore(state.producers);
    log.info("restored arbiter ledger");
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "could not load arbiter state");
  }
}

/** An `act` impulse that is not one of hers: through the gate (the director for game ones). */
async function actThroughGate(
  ctx: ModuleContext,
  impulse: Impulse,
  signal: AbortSignal | undefined,
): Promise<ImpulseRun> {
  const registry = ctx.services.get(ActuatorRegistryKey);
  if (!registry || impulse.capability === null) {
    return { status: "refused", reason: "denied", detail: "沒有可以執行的能力" };
  }
  const context = impulse.target.context;
  const outcome = await registry.invoke(
    {
      principal:
        impulse.source === "game" ? Principals.director(context) : Principals.self(context, null),
      capability: impulse.capability,
      args: impulse.args,
      why: impulse.why === "" ? null : impulse.why,
      turn: null,
      about: impulse.target.account,
    },
    signal ? { signal, priority: impulse.priority } : { priority: impulse.priority },
  );
  switch (outcome.status) {
    case "done":
      return { status: "started", turn: null, task: null, detail: outcome.result.text };
    case "denied":
      return { status: "refused", reason: "denied", detail: outcome.decision.reason };
    case "failed":
      return { status: "refused", reason: "denied", detail: outcome.error };
  }
}

class Runner {
  readonly #queue = new SerialQueue();
  /** Followups submitted whose `markDone` failed; never brought up twice. */
  readonly #failedMarks = new Set<string>();

  constructor(
    private readonly ctx: ModuleContext,
    private readonly core: ArbiterCore,
    private readonly producers: Producers,
    private readonly profile: ProfileId,
    private readonly clock: Clock,
    private readonly store: SettingsStore | undefined,
  ) {}

  #submit(impulse: Impulse): void {
    void this.core.submit(impulse).catch((error: unknown) => {
      log.warn({ impulse: impulse.id, error: errorMessage(error) }, "impulse failed");
    });
  }

  onEvent(env: Envelope): void {
    const event = env.event;
    const now = this.clock.now();
    const social = this.ctx.services.get(SocialSignalsKey) ?? null;
    for (const impulse of this.producers.observe(now, event, social)) this.#submit(impulse);
    switch (event.type) {
      case "platform_message_created": {
        const m = event.data;
        if (m.author.is_bot || this.producers.isSelf(m.author.account)) break;
        const dm = m.id.context.kind === "dm";
        if (dm || m.mentions_self || m.reply_to_self) {
          this.core.engaged(m.id.context, dm ? m.author.account : null, now);
        }
        break;
      }
      case "agent_turn_completed":
        this.core.turnCompleted(event.data.turn, event.data.context, event.data.text);
        break;
      case "custom": {
        const outcome = v2Payload(event, TURN_OUTCOME_TOPIC);
        if (outcome) {
          this.core.turnOutcome(outcome);
          break;
        }
        const focus = v2Payload(event, TURN_FOCUS_TOPIC);
        if (focus) {
          this.core.turnFocus(focus);
          break;
        }
        const impulse = v2Payload(event, ARBITER_IMPULSE_TOPIC);
        if (impulse && typeof impulse.id === "string" && impulse.target) this.#submit(impulse);
        break;
      }
      default:
        break;
    }
  }

  onTick(): Promise<void> {
    return this.#queue.run(async () => {
      const now = this.clock.now();
      this.producers.prune(now);
      await this.core.tick();
      await this.#followups(now);
      await this.#persist();
    });
  }

  persist(): Promise<void> {
    return this.#queue.run(() => this.#persist());
  }

  async #followups(now: number): Promise<void> {
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
    const social = this.ctx.services.get(SocialSignalsKey) ?? null;
    for (const followup of due) {
      if (this.#failedMarks.has(followup.id)) continue;
      const impulse = this.producers.followup(now, followup, social);
      if (!impulse) continue;
      const decision = await this.core.submit(impulse);
      // Rejected or expired: it stays due and comes back on a later tick.
      if (decision.verdict !== "accepted" && decision.verdict !== "deferred") continue;
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
    if (!this.core.book.dirty && !this.producers.dirty) return;
    const value = {
      ledger: this.core.book.snapshot(this.clock.now()),
      producers: this.producers.snapshot(),
    };
    try {
      const write = this.store.set(STATE_PROFILE, STATE_KEY, value as unknown as JsonValue);
      if (
        (await withTimeout(
          write.then(() => true),
          STORE_TIMEOUT_MS,
        )) === undefined
      ) {
        log.warn("saving arbiter state timed out");
      }
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not save arbiter state");
    }
  }
}
