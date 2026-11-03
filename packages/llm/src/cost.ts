// Cost tracking and budgets: pricing, per day / month totals per model, the
// `ok -> degraded -> exhausted` state machine and persistence.

import { getLogger } from "@miyoria/kernel";
import type { SettingsStore } from "@miyoria/store";
import { type Clock, customEvent, type Event, type JsonValue, systemClock } from "@miyoria/types";
import { z } from "zod";
import {
  BudgetExhaustedError,
  LlmError,
  type ModelRef,
  ModelRefSchema,
  type Usage,
} from "./types.js";

const log = getLogger("llm.cost");

/** Profile id under which usage totals are persisted. */
export const USAGE_PROFILE = "_global";
/** Settings-key prefix of persisted usage (`llm_usage:YYYY-MM-DD`, `llm_usage:YYYY-MM`). */
export const USAGE_KEY_PREFIX = "llm_usage:";
/** Topic of the budget state event. */
export const BUDGET_TOPIC = "llm.budget";

/** Receives events the router wants to publish (set by the module). */
export type EventSink = (event: Event) => void;

/**
 * Price of a model in USD per million tokens (`[llm.pricing."provider:model"]`).
 * `prompt_tokens` includes the cached tokens (OpenAI / DeepSeek semantics), so the cached part
 * is priced at `cached_input_per_mtok` (default: `input_per_mtok`) and the rest at
 * `input_per_mtok`.
 */
export const PricingSchema = z.object({
  input_per_mtok: z.number().default(0),
  cached_input_per_mtok: z.number().nullable().default(null),
  output_per_mtok: z.number().default(0),
});
export type Pricing = z.output<typeof PricingSchema>;

export function pricing(p: Partial<Pricing> = {}): Pricing {
  return { input_per_mtok: 0, cached_input_per_mtok: null, output_per_mtok: 0, ...p };
}

/** Cost of one call in USD. Over-reported cached tokens are clamped to the prompt size. */
export function callCost(p: Pricing, usage: Usage): number {
  const prompt = usage.prompt_tokens;
  const cached = Math.min(usage.cached_prompt_tokens ?? 0, usage.prompt_tokens);
  const cachedPrice = p.cached_input_per_mtok ?? p.input_per_mtok;
  return (
    ((prompt - cached) * p.input_per_mtok +
      cached * cachedPrice +
      usage.completion_tokens * p.output_per_mtok) /
    1_000_000
  );
}

/** What to do when the budget is used up: reject requests, or keep going on fallback models. */
export type OnExhausted = "stop" | "fallback";

/**
 * `[llm.budget]`. Limits `<= 0` count as unset.
 *
 * ```toml
 * [llm.budget]
 * daily_usd = 2.0
 * monthly_usd = 40.0
 * degrade_at = 0.8
 * on_exhausted = "stop"            # or "fallback"
 * budget_exempt_purposes = ["fast"]
 * timezone_offset_hours = 8
 *
 * [llm.budget.fallback]            # used while degraded / exhausted
 * chat = ["deepseek:deepseek-chat"]
 * ```
 */
export const BudgetConfigSchema = z.object({
  daily_usd: z.number().nullable().default(null),
  monthly_usd: z.number().nullable().default(null),
  /** Fraction of a limit at which the state becomes `degraded`. */
  degrade_at: z.number().default(0.8),
  on_exhausted: z.enum(["stop", "fallback"]).default("stop"),
  /** Replacement chains per purpose while degraded or exhausted. */
  fallback: z.record(z.string(), z.array(ModelRefSchema)).default({}),
  /** Purposes that may still run when exhausted with `on_exhausted = "stop"`. */
  budget_exempt_purposes: z.array(z.string()).default([]),
  /** UTC offset (hours) that defines day and month boundaries. */
  timezone_offset_hours: z.number().default(8),
});
export type BudgetConfig = z.output<typeof BudgetConfigSchema>;

export function budgetConfig(b: Partial<BudgetConfig> = {}): BudgetConfig {
  return { ...BudgetConfigSchema.parse({}), ...b };
}

function limit(v: number | null): number | null {
  return v !== null && v > 0 ? v : null;
}

export type BudgetState = "ok" | "degraded" | "exhausted";

/** Usage and cost of one model within one period. */
export interface ModelUsage {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  cost_usd: number;
}

const ModelUsageSchema = z.object({
  calls: z.number().default(0),
  prompt_tokens: z.number().default(0),
  completion_tokens: z.number().default(0),
  cached_prompt_tokens: z.number().default(0),
  cost_usd: z.number().default(0),
});

/** Persisted document of one day or month: `{"models": {"<provider:model>": ModelUsage}}`. */
const PeriodUsageSchema = z.object({
  models: z.record(z.string(), ModelUsageSchema).default({}),
});

function emptyUsage(): ModelUsage {
  return { calls: 0, prompt_tokens: 0, completion_tokens: 0, cached_prompt_tokens: 0, cost_usd: 0 };
}

class PeriodUsage {
  readonly models = new Map<string, ModelUsage>();

  static fromJson(value: JsonValue, key: string): PeriodUsage {
    const parsed = PeriodUsageSchema.safeParse(value);
    if (!parsed.success) throw new LlmError(`invalid \`${key}\`: ${z.prettifyError(parsed.error)}`);
    const out = new PeriodUsage();
    for (const [model, usage] of Object.entries(parsed.data.models)) out.models.set(model, usage);
    return out;
  }

  get isEmpty(): boolean {
    return this.models.size === 0;
  }

  #sorted(): [string, ModelUsage][] {
    return [...this.models.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  cost(): number {
    return this.#sorted().reduce((sum, [, m]) => sum + m.cost_usd, 0);
  }

  calls(): number {
    return this.#sorted().reduce((sum, [, m]) => sum + m.calls, 0);
  }

  merge(other: PeriodUsage): void {
    for (const [model, u] of other.models) {
      const m = this.#entry(model);
      m.calls += u.calls;
      m.prompt_tokens += u.prompt_tokens;
      m.completion_tokens += u.completion_tokens;
      m.cached_prompt_tokens += u.cached_prompt_tokens;
      m.cost_usd += u.cost_usd;
    }
  }

  add(model: string, usage: Usage, cost: number): void {
    const m = this.#entry(model);
    m.calls += 1;
    m.prompt_tokens += usage.prompt_tokens;
    m.completion_tokens += usage.completion_tokens;
    m.cached_prompt_tokens += usage.cached_prompt_tokens ?? 0;
    m.cost_usd += cost;
  }

  #entry(model: string): ModelUsage {
    let m = this.models.get(model);
    if (!m) {
      m = emptyUsage();
      this.models.set(model, m);
    }
    return m;
  }

  modelsRecord(): Record<string, ModelUsage> {
    return Object.fromEntries(this.#sorted().map(([k, v]) => [k, { ...v }]));
  }

  report(period: string): PeriodReport {
    return { period, total_usd: this.cost(), calls: this.calls(), models: this.modelsRecord() };
  }

  toJson(): JsonValue {
    return { models: this.modelsRecord() } as unknown as JsonValue;
  }
}

/** Totals of one day (`YYYY-MM-DD`) or month (`YYYY-MM`). */
export interface PeriodReport {
  period: string;
  total_usd: number;
  calls: number;
  /** Per `provider:model`, in key order. */
  models: Record<string, ModelUsage>;
}

/** Snapshot for the API / CLI. */
export interface CostReport {
  state: BudgetState;
  daily_usd: number | null;
  monthly_usd: number | null;
  degrade_at: number;
  today: PeriodReport;
  month: PeriodReport;
}

/** Payload of the `llm.budget` event. */
export interface BudgetEventPayload {
  state: BudgetState;
  spent_today_usd: number;
  daily_usd: number | null;
  spent_month_usd: number;
  monthly_usd: number | null;
}

/** `[YYYY-MM-DD, YYYY-MM]` of `now` in the configured timezone. */
export function periodKeys(now: number, offsetHours: number): [string, string] {
  let secs = Math.round(offsetHours * 3600);
  if (!Number.isFinite(secs) || Math.abs(secs) >= 86_400) secs = 0;
  const iso = new Date(now + secs * 1000).toISOString();
  return [iso.slice(0, 10), iso.slice(0, 7)];
}

export class CostTracker {
  readonly budget: BudgetConfig;
  readonly #pricing: ReadonlyMap<string, Pricing>;
  readonly #clock: Clock;
  #day: string;
  #month: string;
  #today = new PeriodUsage();
  #thisMonth = new PeriodUsage();
  #state: BudgetState = "ok";
  #dirty = false;
  /** Finished periods still to be written to the store. */
  #retired: [string, JsonValue][] = [];
  #sink: EventSink | undefined;
  #store: SettingsStore | undefined;
  /** Models already warned about missing pricing (exposed for tests). */
  readonly unpricedLogged = new Set<string>();

  constructor(
    pricingByModel: ReadonlyMap<string, Pricing> = new Map(),
    budget: BudgetConfig = budgetConfig(),
    clock: Clock = systemClock,
  ) {
    this.#pricing = pricingByModel;
    this.budget = budget;
    this.#clock = clock;
    [this.#day, this.#month] = periodKeys(clock.now(), budget.timezone_offset_hours);
  }

  setSink(sink: EventSink): void {
    this.#sink = sink;
  }

  #evaluate(today: number, month: number): BudgetState {
    let state: BudgetState = "ok";
    const degradeAt = Math.min(Math.max(this.budget.degrade_at, 0), 1);
    for (const [spent, cap] of [
      [today, limit(this.budget.daily_usd)],
      [month, limit(this.budget.monthly_usd)],
    ] as const) {
      if (cap === null) continue;
      if (spent >= cap) return "exhausted";
      if (spent >= cap * degradeAt) state = "degraded";
    }
    return state;
  }

  #setState(state: BudgetState): boolean {
    if (state === this.#state) return false;
    log.info({ from: this.#state, to: state }, "llm budget state changed");
    this.#state = state;
    return true;
  }

  /** Applies day / month rollover and re-evaluates the state. True when observers care. */
  #refresh(): boolean {
    const [day, month] = periodKeys(this.#clock.now(), this.budget.timezone_offset_hours);
    let changed = false;
    if (day !== this.#day) {
      if (!this.#today.isEmpty) {
        this.#retired.push([`${USAGE_KEY_PREFIX}${this.#day}`, this.#today.toJson()]);
      }
      this.#today = new PeriodUsage();
      this.#day = day;
      changed = true;
    }
    if (month !== this.#month) {
      if (!this.#thisMonth.isEmpty) {
        this.#retired.push([`${USAGE_KEY_PREFIX}${this.#month}`, this.#thisMonth.toJson()]);
      }
      this.#thisMonth = new PeriodUsage();
      this.#month = month;
      changed = true;
    }
    return this.#setState(this.#evaluate(this.#today.cost(), this.#thisMonth.cost())) || changed;
  }

  #payload(): BudgetEventPayload {
    return {
      state: this.#state,
      spent_today_usd: this.#today.cost(),
      daily_usd: limit(this.budget.daily_usd),
      spent_month_usd: this.#thisMonth.cost(),
      monthly_usd: limit(this.budget.monthly_usd),
    };
  }

  #emit(payload: BudgetEventPayload): void {
    this.#sink?.(customEvent(BUDGET_TOPIC, { ...payload }));
  }

  /**
   * Publishes the current state unconditionally (e.g. at startup, so listeners don't assume
   * `ok` after a restart with an exhausted budget).
   */
  announce(): void {
    this.#refresh();
    this.#emit(this.#payload());
  }

  /** Refreshes the state (publishing a change) and returns it. */
  state(): BudgetState {
    if (this.#refresh()) this.#emit(this.#payload());
    return this.#state;
  }

  /** Checks whether `purpose` may run now and returns the current state. */
  gate(purpose: string): BudgetState {
    const state = this.state();
    if (
      state === "exhausted" &&
      this.budget.on_exhausted === "stop" &&
      !this.budget.budget_exempt_purposes.includes(purpose)
    ) {
      throw new BudgetExhaustedError();
    }
    return state;
  }

  #price(model: string, usage: Usage): number {
    const p = this.#pricing.get(model);
    if (p) return callCost(p, usage);
    if (!this.unpricedLogged.has(model)) {
      this.unpricedLogged.add(model);
      log.warn({ model }, "no [llm.pricing] entry for model, its calls cost 0");
    }
    return 0;
  }

  /** The `[llm.pricing]` entry of `model` (`provider:model`), if any. */
  priceFor(model: string): Pricing | null {
    const p = this.#pricing.get(model);
    return p ? { ...p } : null;
  }

  /** Every configured price, by `provider:model`. */
  prices(): Record<string, Pricing> {
    return Object.fromEntries([...this.#pricing].map(([k, v]) => [k, { ...v }]));
  }

  /** Adds one finished call; returns its cost in USD. */
  record(model: string, usage: Usage): number {
    const cost = this.#price(model, usage);
    const rolled = this.#refresh();
    this.#today.add(model, usage, cost);
    this.#thisMonth.add(model, usage, cost);
    this.#dirty = true;
    const changed = this.#setState(this.#evaluate(this.#today.cost(), this.#thisMonth.cost()));
    if (rolled || changed) this.#emit(this.#payload());
    return cost;
  }

  report(): CostReport {
    const changed = this.#refresh();
    const report: CostReport = {
      state: this.#state,
      daily_usd: limit(this.budget.daily_usd),
      monthly_usd: limit(this.budget.monthly_usd),
      degrade_at: this.budget.degrade_at,
      today: this.#today.report(this.#day),
      month: this.#thisMonth.report(this.#month),
    };
    if (changed) this.#emit(this.#payload());
    return report;
  }

  /** Sets the store and merges the persisted totals of the current day and month. Call once. */
  async attachStore(store: SettingsStore): Promise<void> {
    this.#refresh();
    const day = this.#day;
    const month = this.#month;
    const load = async (key: string): Promise<PeriodUsage> => {
      const value = await store.get(USAGE_PROFILE, key);
      return value === null ? new PeriodUsage() : PeriodUsage.fromJson(value, key);
    };
    const dayUsage = await load(`${USAGE_KEY_PREFIX}${day}`);
    const monthUsage = await load(`${USAGE_KEY_PREFIX}${month}`);
    this.#store = store;
    // The clock may have crossed a boundary while loading.
    if (this.#day === day) this.#today.merge(dayUsage);
    if (this.#month === month) this.#thisMonth.merge(monthUsage);
    if (this.#refresh()) this.#emit(this.#payload());
  }

  /**
   * Writes unsaved totals to the store (no-op without a store or changes). Failed writes are
   * retried by the next flush.
   */
  async flush(): Promise<void> {
    const store = this.#store;
    if (!store) return;
    const writes = this.#retired;
    this.#retired = [];
    if (this.#dirty) {
      this.#dirty = false;
      writes.push([`${USAGE_KEY_PREFIX}${this.#day}`, this.#today.toJson()]);
      writes.push([`${USAGE_KEY_PREFIX}${this.#month}`, this.#thisMonth.toJson()]);
    }
    const failed: [string, JsonValue][] = [];
    let firstError: unknown;
    for (const [key, value] of writes) {
      try {
        await store.set(USAGE_PROFILE, key, value);
      } catch (error) {
        firstError ??= error;
        failed.push([key, value]);
      }
    }
    if (firstError !== undefined) {
      // Older documents go first so newer snapshots overwrite them.
      this.#retired = [...failed, ...this.#retired];
      throw firstError;
    }
  }

  /** Fallback chain configured for `purpose`, if any. */
  fallbackChain(purpose: string): ModelRef[] | undefined {
    return this.budget.fallback[purpose];
  }
}
