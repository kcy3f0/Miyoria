import {
  type Envelope,
  type EnvelopeOptions,
  type Event,
  envelopeTopic,
  type ModuleId,
  newEnvelope,
} from "@miyoria/types";
import { getLogger } from "./log.js";
import { type Counter, type MetricsRegistry, metrics } from "./metrics.js";

const log = getLogger("kernel.bus");

/** Per-subscription buffer, like the Rust broadcast channel capacity. */
export const DEFAULT_BUS_CAPACITY = 4096;

/**
 * Matches dotted topics. `"platform.*"` matches every topic under `platform.`, `"*"` matches
 * everything, anything else must match exactly.
 */
export class TopicFilter {
  readonly patterns: readonly string[];

  constructor(patterns: Iterable<string>) {
    this.patterns = [...patterns];
  }

  static all(): TopicFilter {
    return new TopicFilter(["*"]);
  }

  static from(filter: TopicFilterLike): TopicFilter {
    if (filter instanceof TopicFilter) return filter;
    return new TopicFilter(typeof filter === "string" ? [filter] : filter);
  }

  matches(topic: string): boolean {
    return this.patterns.some((p) => {
      if (p === "*") return true;
      if (p.endsWith(".*")) {
        const prefix = p.slice(0, -2);
        return topic.startsWith(prefix) && topic.charAt(prefix.length) === ".";
      }
      return p === topic;
    });
  }
}

/** A filter, one pattern, or a list of patterns. */
export type TopicFilterLike = TopicFilter | string | readonly string[];

export interface SubscribeOptions {
  /** Closes the subscription when aborted. */
  signal?: AbortSignal;
  /** Buffered events before the oldest are dropped. Default `DEFAULT_BUS_CAPACITY`. */
  capacity?: number;
}

/**
 * A stream of matching envelopes. Consume it with `for await` (ends once closed) or `recv()`.
 * Events published after `subscribe()` returns are delivered in order. A slow subscriber that
 * falls more than `capacity` events behind skips the oldest ones (logged as lag).
 */
export class Subscription implements AsyncIterableIterator<Envelope> {
  readonly filter: TopicFilter;
  readonly #capacity: number;
  readonly #queue: Envelope[] = [];
  readonly #waiters: Array<(result: IteratorResult<Envelope>) => void> = [];
  readonly #onClose: () => void;
  readonly #dropped: Counter | undefined;
  #closed = false;
  #lagged = 0;

  /** @internal Created by `EventBus.subscribe`. */
  constructor(filter: TopicFilter, capacity: number, onClose: () => void, dropped?: Counter) {
    this.filter = filter;
    this.#capacity = capacity;
    this.#onClose = onClose;
    this.#dropped = dropped;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** @internal */
  deliver(envelope: Envelope): void {
    if (this.#closed || !this.filter.matches(envelopeTopic(envelope))) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: envelope, done: false });
      return;
    }
    if (this.#queue.length >= this.#capacity) {
      this.#queue.shift();
      this.#lagged++;
      this.#dropped?.inc();
    }
    this.#queue.push(envelope);
  }

  /** The next matching envelope, or `null` once the subscription is closed. */
  async recv(): Promise<Envelope | null> {
    const result = await this.next();
    return result.done ? null : result.value;
  }

  /** The next buffered envelope without waiting, or `null` when none is buffered. */
  tryRecv(): Envelope | null {
    this.#reportLag();
    return this.#queue.shift() ?? null;
  }

  #reportLag(): void {
    if (this.#lagged > 0) {
      log.warn({ skipped: this.#lagged }, "event subscriber lagged");
      this.#lagged = 0;
    }
  }

  next(): Promise<IteratorResult<Envelope>> {
    this.#reportLag();
    const value = this.#queue.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Stops delivery; pending and future `next()` calls finish. Buffered events are dropped. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
    this.#onClose();
  }

  return(): Promise<IteratorResult<Envelope>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

/** Distinct topic prefixes counted before the rest collapse into `"other"`. */
const MAX_TOPIC_PREFIXES = 64;

/** First segment of a dotted topic (`platform.message.created` -> `platform`). */
export function topicPrefix(topic: string): string {
  const dot = topic.indexOf(".");
  return dot < 0 ? topic : topic.slice(0, dot);
}

export interface EventBusOptions {
  capacity?: number;
  /** Where publish / drop counts go. Default: the process-wide `metrics`. */
  metrics?: MetricsRegistry;
}

/** In-process publish / subscribe bus. Publishing never blocks and never fails. */
export class EventBus {
  readonly #subscriptions = new Set<Subscription>();
  readonly #capacity: number;
  readonly #published: Counter;
  readonly #dropped: Counter;

  constructor(options: EventBusOptions = {}) {
    this.#capacity = options.capacity ?? DEFAULT_BUS_CAPACITY;
    const registry = options.metrics ?? metrics;
    this.#published = registry.counter("miyoria_bus_events_published_total", {
      help: "Events published on the bus, by the first segment of the topic.",
      labels: ["prefix"],
      maxSeries: MAX_TOPIC_PREFIXES,
    });
    this.#dropped = registry.counter("miyoria_bus_events_dropped_total", {
      help: "Events dropped because a subscriber fell more than its capacity behind.",
    });
  }

  publishEnvelope(envelope: Envelope): void {
    this.#published.inc({ prefix: topicPrefix(envelopeTopic(envelope)) });
    // No subscribers is not an error.
    for (const sub of this.#subscriptions) sub.deliver(envelope);
  }

  /** Wraps `event` in a fresh envelope from `source`, publishes it and returns the envelope. */
  publish(source: ModuleId, event: Event, options: EnvelopeOptions = {}): Envelope {
    const envelope = newEnvelope(source, event, options);
    this.publishEnvelope(envelope);
    return envelope;
  }

  subscribe(filter: TopicFilterLike, options: SubscribeOptions = {}): Subscription {
    const { signal } = options;
    const onAbort = () => sub.close();
    const sub: Subscription = new Subscription(
      TopicFilter.from(filter),
      options.capacity ?? this.#capacity,
      () => {
        this.#subscriptions.delete(sub);
        signal?.removeEventListener("abort", onAbort);
      },
      this.#dropped,
    );
    this.#subscriptions.add(sub);
    if (signal?.aborted) sub.close();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return sub;
  }

  /** Number of open subscriptions (diagnostics). */
  get subscriberCount(): number {
    return this.#subscriptions.size;
  }

  /** Closes every subscription (shutdown). */
  close(): void {
    for (const sub of [...this.#subscriptions]) sub.close();
  }
}
