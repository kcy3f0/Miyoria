import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { type StreamStatus, streamEvents } from "../api/sse";
import type { Envelope } from "../api/types";
import { useConnection } from "./connection";
import { queryKeys } from "./queries";

export const EVENT_BUFFER = 500;

export interface EventSnapshot {
  /** Newest first, at most `EVENT_BUFFER`. */
  events: Envelope[];
  status: StreamStatus;
  /** Events received since the panel opened (not capped). */
  received: number;
}

type Listener = () => void;

/** Ring buffer of bus envelopes; notifies at most every `flushMs`. */
export class EventStore {
  private snapshot: EventSnapshot = { events: [], status: { state: "closed" }, received: 0 };
  private pending: Envelope[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<Listener>();

  constructor(private readonly flushMs = 80) {}

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): EventSnapshot => this.snapshot;

  push(env: Envelope): void {
    this.pending.push(env);
    if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  flush(): void {
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const fresh = this.pending.reverse();
    this.pending = [];
    this.snapshot = {
      ...this.snapshot,
      events: [...fresh, ...this.snapshot.events].slice(0, EVENT_BUFFER),
      received: this.snapshot.received + fresh.length,
    };
    this.emit();
  }

  setStatus(status: StreamStatus): void {
    this.snapshot = { ...this.snapshot, status };
    this.emit();
  }

  clear(): void {
    this.snapshot = { ...this.snapshot, events: [] };
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

export const EventStoreContext = createContext<EventStore | null>(null);

/** Keeps one `/api/events` stream open while signed in and shares it. */
export function EventStreamProvider({ children }: { children: ReactNode }) {
  const { client, config } = useConnection();
  const queryClient = useQueryClient();
  const store = useMemo(() => new EventStore(), []);

  useEffect(() => {
    if (!config.token) return;
    const ctl = new AbortController();
    void streamEvents(client, {
      signal: ctl.signal,
      onStatus: (s) => store.setStatus(s),
      onEnvelope: (env) => {
        store.push(env);
        // Keep cached lists fresh without polling.
        const t = env.event.type;
        if (t === "module_state_changed") void queryClient.invalidateQueries({ queryKey: queryKeys.modules });
        else if (t === "agent_decision") void queryClient.invalidateQueries({ queryKey: queryKeys.decisionsAll });
        else if (t === "agent_turn_completed") void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      },
    });
    return () => ctl.abort();
  }, [client, config.token, queryClient, store]);

  return <EventStoreContext.Provider value={store}>{children}</EventStoreContext.Provider>;
}

export function useEventStore(): EventStore {
  const s = useContext(EventStoreContext);
  if (!s) throw new Error("useEventStore outside EventStreamProvider");
  return s;
}

export function useEvents(): EventSnapshot {
  const store = useEventStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
