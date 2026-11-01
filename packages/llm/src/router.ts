import { errorMessage, getLogger } from "@miyoria/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type BudgetConfig,
  type BudgetState,
  budgetConfig,
  type CostReport,
  CostTracker,
  type EventSink,
  type Pricing,
} from "./cost.js";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatStream,
  collectResponse,
  LlmError,
  type ModelRef,
  modelRefString,
  type StreamEvent,
  type Usage,
} from "./types.js";

const log = getLogger("llm.router");

/** Calls and tokens per `provider:model` since startup. */
export interface UsageRecord {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
}

export interface LlmRouterOptions {
  /** Prices keyed by `provider:model`; unpriced models cost 0. */
  pricing?: ReadonlyMap<string, Pricing>;
  budget?: BudgetConfig;
  /** Replaces the cost tracker (tests with a fake clock). */
  tracker?: CostTracker;
}

/**
 * Routes requests by purpose (`chat`, `fast`, `summarizer`, `game`, `vision`, ...) to a chain
 * of models, falling back to the next model if one fails before producing any output.
 * Provided as the `LlmRouterKey` service by the `llm` module.
 */
export class LlmRouter {
  readonly #providers: ReadonlyMap<string, ChatProvider>;
  readonly #purposes: Map<string, ModelRef[]>;
  readonly #usage = new Map<string, UsageRecord>();
  readonly #cost: CostTracker;

  constructor(
    providers: ReadonlyMap<string, ChatProvider>,
    purposes: ReadonlyMap<string, ModelRef[]>,
    options: LlmRouterOptions = {},
  ) {
    this.#providers = providers;
    this.#purposes = new Map(purposes);
    this.#cost =
      options.tracker ?? new CostTracker(options.pricing, options.budget ?? budgetConfig());
  }

  /** Overrides purposes, e.g. with the active profile's `[llm.purposes]`. */
  setPurposes(overrides: ReadonlyMap<string, ModelRef[]>): void {
    for (const [purpose, chain] of overrides) this.#purposes.set(purpose, chain);
  }

  /** The chain of `purpose`, or of `chat` when the purpose is not configured. */
  chain(purpose: string): ModelRef[] {
    return [...(this.#purposes.get(purpose) ?? this.#purposes.get("chat") ?? [])];
  }

  hasPurpose(purpose: string): boolean {
    return this.chain(purpose).length > 0;
  }

  /** The purpose whose chain a request for `purpose` uses (`chat` if unconfigured). */
  #effectivePurpose(purpose: string): string {
    return this.#purposes.has(purpose) ? purpose : "chat";
  }

  /** The configured fallback while degraded or exhausted, else the normal chain. */
  #chainForState(purpose: string, state: BudgetState): ModelRef[] {
    if (state !== "ok") {
      const fallback = this.#cost.fallbackChain(this.#effectivePurpose(purpose));
      if (fallback && fallback.length > 0) return [...fallback];
    }
    return this.chain(purpose);
  }

  /** Usage per `provider:model` since startup. */
  usage(): Map<string, UsageRecord> {
    return new Map([...this.#usage].map(([k, v]) => [k, { ...v }]));
  }

  /** Spend so far today and this month, per model, plus the budget state. */
  costReport(): CostReport {
    return this.#cost.report();
  }

  /** Current budget state (re-evaluated, so day rollovers are applied). */
  budgetState(): BudgetState {
    return this.#cost.state();
  }

  /** Publishes the current budget state as an `llm.budget` event. */
  announceBudget(): void {
    this.#cost.announce();
  }

  /** Where budget events (`llm.budget`) are published. */
  setEventSink(sink: EventSink): void {
    this.#cost.setSink(sink);
  }

  /**
   * Loads persisted usage of the current day and month and enables `flush`. Call once, after
   * `setEventSink`.
   */
  attachStore(store: SettingsStore): Promise<void> {
    return this.#cost.attachStore(store);
  }

  /** Persists unsaved usage totals (no-op without a store). */
  flush(): Promise<void> {
    return this.#cost.flush();
  }

  /**
   * Streams a response for `purpose` (falls back to `chat` if the purpose is not configured).
   * `request.model` is overwritten.
   *
   * Rejects with `BudgetExhaustedError` when the budget is used up and `on_exhausted = "stop"`
   * (unless the purpose is exempt). While degraded or exhausted the `[llm.budget.fallback]`
   * chain replaces the normal one.
   */
  async stream(purpose: string, request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    const state = this.#cost.gate(purpose);
    const chain = this.#chainForState(purpose, state);
    if (chain.length === 0) {
      throw new LlmError(
        `no model configured for purpose \`${purpose}\` (and no \`chat\` fallback)`,
      );
    }
    let lastError: unknown;
    for (const model of chain) {
      const key = modelRefString(model);
      const provider = this.#providers.get(model.provider);
      if (!provider) {
        log.warn({ model: key }, "unknown provider in model chain");
        lastError = new LlmError(`unknown provider \`${model.provider}\``);
        continue;
      }
      let iterator: AsyncIterator<StreamEvent>;
      let first: IteratorResult<StreamEvent>;
      try {
        const stream = await provider.stream({ ...request, model: model.model }, signal);
        iterator = stream[Symbol.asyncIterator]();
        // Only fall back if the model fails before its first event.
        first = await iterator.next();
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn({ model: key, err: errorMessage(error) }, "model failed, trying next in chain");
        lastError = error;
        continue;
      }
      return this.#track(key, first, iterator);
    }
    throw lastError ?? new LlmError("all models failed");
  }

  async complete(
    purpose: string,
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    return collectResponse(await this.stream(purpose, request, signal));
  }

  #record(key: string, usage: Usage): void {
    let record = this.#usage.get(key);
    if (!record) {
      record = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cached_prompt_tokens: 0 };
      this.#usage.set(key, record);
    }
    record.calls += 1;
    record.prompt_tokens += usage.prompt_tokens;
    record.completion_tokens += usage.completion_tokens;
    record.cached_prompt_tokens += usage.cached_prompt_tokens ?? 0;
    this.#cost.record(key, usage);
  }

  async *#track(
    key: string,
    first: IteratorResult<StreamEvent>,
    rest: AsyncIterator<StreamEvent>,
  ): ChatStream {
    let finished = false;
    try {
      for (let next = first; !next.done; next = await rest.next()) {
        const ev = next.value;
        if (ev.type === "done" && ev.usage) this.#record(key, ev.usage);
        yield ev;
      }
      finished = true;
    } finally {
      if (!finished) await rest.return?.();
    }
  }
}
