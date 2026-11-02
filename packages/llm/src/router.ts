import { errorMessage, getLogger, type MetricsRegistry } from "@miyoria/kernel";
import type { SettingsStore } from "@miyoria/store";
import { type Clock, systemClock } from "@miyoria/types";
import {
  type BudgetConfig,
  type BudgetState,
  budgetConfig,
  type CostReport,
  CostTracker,
  type EventSink,
  type Pricing,
} from "./cost.js";
import { errorKind, type LlmMetrics, llmMetrics } from "./metrics.js";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  collectResponse,
  hasImages,
  LlmError,
  type ModelRef,
  modelRefString,
  ProviderHttpError,
  type StreamEvent,
  textOnlyRequest,
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
  /** Where call, token, cost, latency and error metrics go. Default: the process-wide one. */
  metrics?: MetricsRegistry;
  /** Clock of the first-token latency. Default: the system clock. */
  clock?: Clock;
  /** `[llm.thinking]`: whether reasoning models think, per purpose (default off). */
  thinking?: ReadonlyMap<string, boolean>;
  /**
   * `[llm.image_input]`: whether a model takes image parts, keyed by `provider:model` or by
   * `provider` (the model entry wins). Unlisted models do.
   */
  imageInput?: ReadonlyMap<string, boolean>;
}

/** HTTP statuses with which a provider may refuse image parts it does not support. */
const IMAGE_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 413, 415, 422]);

function rejectsImages(error: unknown): boolean {
  return error instanceof ProviderHttpError && IMAGE_REJECTION_STATUSES.has(error.status);
}

/** One routed call while it streams. */
interface Call {
  key: string;
  purpose: string;
  /** When `LlmRouter.stream` was called (before any fallback). */
  requestedAt: number;
  /** When the request to the answering model was sent. */
  sentAt: number;
  firstTokenAt: number | null;
}

/**
 * The stream `LlmRouter.stream` returns: a `ChatStream` that also tells which model answered
 * and how long the first token took.
 */
export class RoutedStream implements AsyncIterable<StreamEvent> {
  readonly #call: Call;
  readonly #events: AsyncGenerator<StreamEvent>;

  /** @internal Created by `LlmRouter.stream`. */
  constructor(call: Call, events: AsyncGenerator<StreamEvent>) {
    this.#call = call;
    this.#events = events;
  }

  /** `provider:model` that is answering. */
  get model(): string {
    return this.#call.key;
  }

  /**
   * Milliseconds from the `stream` call to the first text or reasoning delta, including time
   * spent on models that failed before it; `null` until one arrives.
   */
  get firstTokenMs(): number | null {
    const at = this.#call.firstTokenAt;
    return at === null ? null : Math.max(0, at - this.#call.requestedAt);
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return this.#events;
  }
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
  readonly #metrics: LlmMetrics;
  readonly #clock: Clock;
  readonly #thinking: ReadonlyMap<string, boolean>;
  readonly #imageInput: ReadonlyMap<string, boolean>;
  /** Models that refused image parts in this run (`provider:model`); they get text from now on. */
  readonly #refusedImages = new Set<string>();

  constructor(
    providers: ReadonlyMap<string, ChatProvider>,
    purposes: ReadonlyMap<string, ModelRef[]>,
    options: LlmRouterOptions = {},
  ) {
    this.#providers = providers;
    this.#purposes = new Map(purposes);
    this.#cost =
      options.tracker ?? new CostTracker(options.pricing, options.budget ?? budgetConfig());
    this.#metrics = llmMetrics(options.metrics);
    this.#clock = options.clock ?? systemClock;
    this.#thinking = options.thinking ?? new Map();
    this.#imageInput = options.imageInput ?? new Map();
  }

  /**
   * Whether `model` takes image parts: not after it refused them in this run, else
   * `[llm.image_input]` for the model, then for its provider; unlisted models do.
   */
  modelTakesImages(model: ModelRef): boolean {
    const key = modelRefString(model);
    if (this.#refusedImages.has(key)) return false;
    return this.#imageInput.get(key) ?? this.#imageInput.get(model.provider) ?? true;
  }

  /**
   * Whether a request for `purpose` would reach a model that looks at images (the first model
   * of the chain in use), so callers can skip preparing images nobody sees.
   */
  takesImages(purpose: string): boolean {
    const first = this.#chainForState(purpose, this.#cost.state())[0];
    return first !== undefined && this.modelTakesImages(first);
  }

  /** `request.thinking`, else `[llm.thinking]` for the purpose; off when neither says. */
  #thinkingFor(purpose: string, request: ChatRequest): boolean {
    return request.thinking ?? this.#thinking.get(purpose) ?? false;
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

  /** Whether `purpose` has a chain of its own (not just the `chat` fallback). */
  configures(purpose: string): boolean {
    return (this.#purposes.get(purpose)?.length ?? 0) > 0;
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
  async stream(purpose: string, request: ChatRequest, signal?: AbortSignal): Promise<RoutedStream> {
    const requestedAt = this.#clock.now();
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
      const sentAt = this.#clock.now();
      let routed: ChatRequest = {
        ...request,
        model: model.model,
        thinking: this.#thinkingFor(purpose, request),
      };
      const images = hasImages(routed.messages);
      if (images && !this.modelTakesImages(model)) routed = textOnlyRequest(routed);
      try {
        try {
          [iterator, first] = await this.#open(provider, routed, signal);
        } catch (error) {
          // A provider that cannot take image parts: once more as text, and remember it.
          if (signal?.aborted || !images || !hasImages(routed.messages) || !rejectsImages(error)) {
            throw error;
          }
          log.warn(
            { model: key, err: errorMessage(error) },
            "model refused image input, retrying as text",
          );
          [iterator, first] = await this.#open(provider, textOnlyRequest(routed), signal);
          this.#refusedImages.add(key);
          log.warn({ model: key }, "sending this model text only from now on");
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn({ model: key, err: errorMessage(error) }, "model failed, trying next in chain");
        this.#metrics.errors.inc({
          model: key,
          purpose,
          stage: "request",
          kind: errorKind(error),
        });
        lastError = error;
        continue;
      }
      const call: Call = { key, purpose, requestedAt, sentAt, firstTokenAt: null };
      this.#metrics.calls.inc({ model: key, purpose });
      if (!first.done) this.#observe(call, first.value);
      return new RoutedStream(call, this.#track(call, first, iterator, signal));
    }
    throw lastError ?? new LlmError("all models failed");
  }

  /** Starts a response; only failures before the first event count as the model failing. */
  async #open(
    provider: ChatProvider,
    request: ChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<[AsyncIterator<StreamEvent>, IteratorResult<StreamEvent>]> {
    const stream = await provider.stream(request, signal);
    const iterator = stream[Symbol.asyncIterator]();
    return [iterator, await iterator.next()];
  }

  async complete(
    purpose: string,
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    return collectResponse(await this.stream(purpose, request, signal));
  }

  /** Notes the first text or reasoning delta of `call`. */
  #observe(call: Call, ev: StreamEvent): void {
    if (call.firstTokenAt !== null) return;
    if (ev.type !== "text_delta" && ev.type !== "reasoning_delta") return;
    const now = this.#clock.now();
    call.firstTokenAt = now;
    this.#metrics.firstToken.observe(
      { model: call.key, purpose: call.purpose },
      Math.max(0, now - call.sentAt) / 1000,
    );
  }

  #record(call: Call, usage: Usage): void {
    const key = call.key;
    let record = this.#usage.get(key);
    if (!record) {
      record = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cached_prompt_tokens: 0 };
      this.#usage.set(key, record);
    }
    record.calls += 1;
    record.prompt_tokens += usage.prompt_tokens;
    record.completion_tokens += usage.completion_tokens;
    record.cached_prompt_tokens += usage.cached_prompt_tokens ?? 0;
    const cost = this.#cost.record(key, usage);
    const labels = { model: key, purpose: call.purpose };
    const tokens = this.#metrics.tokens;
    tokens.inc({ ...labels, type: "prompt" }, usage.prompt_tokens);
    tokens.inc({ ...labels, type: "completion" }, usage.completion_tokens);
    tokens.inc({ ...labels, type: "cached_prompt" }, usage.cached_prompt_tokens ?? 0);
    this.#metrics.cost.inc(labels, cost);
  }

  async *#track(
    call: Call,
    first: IteratorResult<StreamEvent>,
    rest: AsyncIterator<StreamEvent>,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamEvent> {
    let finished = false;
    try {
      for (let next = first; !next.done; ) {
        const ev = next.value;
        this.#observe(call, ev);
        if (ev.type === "done" && ev.usage) this.#record(call, ev.usage);
        yield ev;
        try {
          next = await rest.next();
        } catch (error) {
          if (!signal?.aborted) {
            this.#metrics.errors.inc({
              model: call.key,
              purpose: call.purpose,
              stage: "stream",
              kind: errorKind(error),
            });
          }
          throw error;
        }
      }
      finished = true;
    } finally {
      if (!finished) await rest.return?.();
    }
  }
}
