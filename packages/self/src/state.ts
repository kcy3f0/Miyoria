// The `SelfStateKey` service: the engine advanced to "now" on every call, plus her mood and the
// feelings records. Every change calls `changed` so the module saves it.

import type {
  AgendaInput,
  AgendaItem,
  Clock,
  ContextKey,
  Drives,
  EffectiveTalkativeness,
  Feeling,
  Mood,
  PersonId,
  SelfSnapshot,
  SelfState,
  Talkativeness,
  TalkativenessInput,
} from "@miyoria/types";
import { toTimestamp } from "@miyoria/types";
import type { Circumstances, SelfEngine } from "./engine.js";
import type { FeelingsBook } from "./feelings.js";

export interface SelfServiceDeps {
  engine: SelfEngine;
  feelings: FeelingsBook;
  clock: Clock;
  /** What she is doing right now (playing, live, energy). */
  circumstances: () => Circumstances;
  mood: () => Mood | null;
  /** Called after every change of the persisted state. */
  changed: (reason: string) => void;
}

export class SelfService implements SelfState {
  constructor(private readonly d: SelfServiceDeps) {}

  /** Advances the engine to now and returns now. */
  now(): number {
    const now = this.d.clock.now();
    this.d.engine.advance(now, this.d.circumstances());
    return now;
  }

  snapshot(): SelfSnapshot {
    const now = this.now();
    const e = this.d.engine;
    return {
      at: toTimestamp(now),
      mood: this.d.mood(),
      boredom: e.boredom(),
      drives: e.drives(),
      policy: e.policy(now),
      agenda: e.allAgenda(now),
    };
  }

  drives(): Drives {
    this.now();
    return this.d.engine.drives();
  }

  boredom(): number {
    this.now();
    return this.d.engine.boredom();
  }

  adjust(delta: Partial<Drives> & { boredom?: number }, reason: string): void {
    this.now();
    this.d.engine.adjust(delta);
    this.d.changed(reason);
  }

  talkativeness(context: ContextKey | null): EffectiveTalkativeness | null {
    return this.d.engine.talkativeness(context, this.now());
  }

  setTalkativeness(scope: string, input: TalkativenessInput): Talkativeness {
    const t = this.d.engine.setTalkativeness(scope, input, this.now());
    this.d.changed("talkativeness");
    return t;
  }

  clearTalkativeness(scope: string): boolean {
    this.now();
    const removed = this.d.engine.clearTalkativeness(scope);
    if (removed) this.d.changed("talkativeness");
    return removed;
  }

  initiative(): number {
    this.now();
    return this.d.engine.initiative();
  }

  setInitiative(level: number, why: string): void {
    this.now();
    this.d.engine.setInitiative(level, why);
    this.d.changed("initiative");
  }

  agenda(): AgendaItem[] {
    return this.d.engine.agenda(this.now());
  }

  addAgenda(input: AgendaInput): AgendaItem {
    const item = this.d.engine.addAgenda(input, this.now());
    this.d.changed("agenda");
    return item;
  }

  completeAgenda(id: string): AgendaItem | null {
    const item = this.d.engine.completeAgenda(id, this.now());
    if (item) this.d.changed("agenda");
    return item;
  }

  dropAgenda(id: string): AgendaItem | null {
    const item = this.d.engine.dropAgenda(id, this.now());
    if (item) this.d.changed("agenda");
    return item;
  }

  feeling(person: PersonId): Feeling | null {
    return this.d.feelings.get(person);
  }

  feelings(): Feeling[] {
    return this.d.feelings.all();
  }

  setFeeling(person: PersonId, text: string, by: string): Promise<Feeling | null> {
    return this.d.feelings.set(person, text, by, this.d.clock.now());
  }
}
