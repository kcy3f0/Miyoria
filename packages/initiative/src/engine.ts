// The decision logic, free of I/O: feed it events and ticks with an explicit `now` (epoch ms),
// and it returns the initiatives to emit.

import { getLogger } from "@miyoria/kernel";
import {
  type AccountRef,
  type Attitude,
  type ContextKey,
  contextKeyString,
  type Event,
  type Followup,
  type MoodSignals,
  type SocialSignals,
  type Timestamp,
  timestampMs,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { z } from "zod";
import { type InitiativeConfig, isContextDisabled } from "./config.js";

const log = getLogger("initiative.engine");

const IDLE_HINT = "頻道冷掉了,可以找點話題";
const IDLE_VOICE_HINT = "語音頻道安靜下來了,可以找點話題";
const GREETING_HINT = "跟他打招呼";
const VOICE_JOIN_HINT = "他剛進語音頻道,跟他打個招呼";
const VOICE_JOIN_MANY_HINT = "他們剛進語音頻道,跟大家打個招呼";

const DAY_MS = 86_400_000;
/** chrono's `num_days_from_ce` of 1970-01-01. */
const DAYS_FROM_CE_TO_EPOCH = 719_163;

/** Optional read-only services the engine consults. */
export interface Signals {
  social?: SocialSignals | null;
  mood?: MoodSignals | null;
}

export type InitiativeReason = "idle_channel" | "greeting" | "voice_join" | "followup";

/** One initiative to publish as `agent_initiative`. */
export interface Emission {
  context: ContextKey;
  reason: InitiativeReason;
  hint: string;
  about: AccountRef[];
}

/** The `agent_initiative` event of an emission. */
export function emissionEvent(emission: Emission): Extract<Event, { type: "agent_initiative" }> {
  return {
    type: "agent_initiative",
    data: {
      context: emission.context,
      reason: emission.reason,
      hint: emission.hint,
      about: emission.about,
    },
  };
}

/** Why an initiative was held back. */
export type Blocked =
  | "disabled"
  | "quiet_hours"
  /** An earlier idle nudge in this context is still waiting for a reply. */
  | "pending"
  /** A conversation is going on right now. */
  | "busy"
  | "context_cap"
  | "global_cap";

/** Counter that resets when the day changes. */
interface DayCount {
  day: number;
  count: number;
}

function dayCountCurrent(c: DayCount, day: number): number {
  return c.day === day ? c.count : 0;
}

function dayCountBump(c: DayCount, day: number): void {
  c.count = dayCountCurrent(c, day) + 1;
  c.day = day;
}

/** An emitted initiative waiting to see whether anyone answers. */
interface Pending {
  at: number;
  /** When she said something after the initiative. */
  spokeAt: number | null;
}

interface CtxState {
  context: ContextKey;
  lastActivity: number | null;
  lastHuman: number | null;
  /** Recent messages `[time, hers]` inside the busy window. */
  recent: Array<[number, boolean]>;
  /** Current conversation segment. */
  segTotal: number;
  segSelf: number;
  blockedLogged: boolean;
  count: DayCount;
  backoffLevel: number;
  backoffAt: number | null;
  pending: Pending | null;
}

function newCtxState(context: ContextKey): CtxState {
  return {
    context,
    lastActivity: null,
    lastHuman: null,
    recent: [],
    segTotal: 0,
    segSelf: 0,
    blockedLogged: false,
    count: { day: 0, count: 0 },
    backoffLevel: 0,
    backoffAt: null,
    pending: null,
  };
}

function resetSegment(st: CtxState): void {
  st.segTotal = 0;
  st.segSelf = 0;
  st.blockedLogged = false;
}

function secsMs(s: number): number {
  return s * 1000;
}

function lively(st: CtxState, cfg: InitiativeConfig): boolean {
  return st.segSelf >= 1 && st.segTotal >= cfg.lively_min_messages;
}

function busy(st: CtxState, cfg: InitiativeConfig, now: number): boolean {
  const since = now - secsMs(cfg.busy_window_secs);
  let count = 0;
  for (const [ts, hers] of st.recent) {
    if (ts > since) {
      if (hers) return true;
      count++;
    }
  }
  return count >= Math.max(cfg.busy_min_messages, 1);
}

/** Backoff level after decay. */
function backoffLevel(st: CtxState, cfg: InitiativeConfig, now: number): number {
  if (st.backoffAt === null) return 0;
  const decaySecs = Math.max(cfg.backoff_decay_days, 1) * 86_400;
  const elapsedSecs = Math.max(Math.trunc((now - st.backoffAt) / 1000), 0);
  const forgotten = Math.floor(elapsedSecs / decaySecs);
  return Math.max(st.backoffLevel - forgotten, 0);
}

function adjustLevel(st: CtxState, cfg: InitiativeConfig, now: number, up: boolean): void {
  const level = backoffLevel(st, cfg, now);
  st.backoffLevel = up ? Math.min(level + 1, cfg.max_backoff_doublings) : Math.max(level - 1, 0);
  st.backoffAt = now;
}

interface Person {
  lastAt: number;
  context: ContextKey;
}

// --- persisted snapshot (serde JSON of the Rust `Snapshot`) ---

const DayCountSchema = z.object({ day: z.number(), count: z.number() });
const AccountRefSchema = z.object({ platform: z.string(), id: z.string() });
const ContextKeySchema = z.object({
  platform: z.string(),
  scope: z.string().nullable(),
  channel: z.string(),
  kind: z.enum(["channel", "thread", "dm", "voice"]),
});

/** Persistable counters, backoff and greeting days. */
export const SnapshotSchema = z.object({
  global: DayCountSchema.prefault({ day: 0, count: 0 }),
  contexts: z
    .array(
      z.object({
        context: ContextKeySchema,
        count: DayCountSchema,
        backoff_level: z.number(),
        backoff_at: z.string().nullable(),
      }),
    )
    .default([]),
  seen: z.array(z.tuple([AccountRefSchema, z.number()])).default([]),
});
export interface Snapshot {
  global: { day: number; count: number };
  contexts: Array<{
    context: ContextKey;
    count: { day: number; count: number };
    backoff_level: number;
    backoff_at: Timestamp | null;
  }>;
  seen: Array<[AccountRef, number]>;
}

/** Collision-free map key of a context (the display form is not unique across kinds). */
function ctxId(c: ContextKey): string {
  return `${c.platform}\u0000${c.scope ?? ""}\u0000${c.scope === null ? "dm" : "g"}\u0000${c.channel}\u0000${c.kind}`;
}

function accId(a: AccountRef): string {
  return `${a.platform}\u0000${a.id}`;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Pure decision state machine behind the module. */
export class Engine {
  readonly #cfg: InitiativeConfig;
  readonly #selfAccounts = new Set<string>();
  readonly #contexts = new Map<string, CtxState>();
  readonly #people = new Map<string, Person & { account: AccountRef }>();
  /** Non-self participants of the voice channels she is in. */
  readonly #voice = new Map<string, { context: ContextKey; members: Map<string, AccountRef> }>();
  readonly #voiceGreeted = new Map<string, number>();
  /** Day index of each person's first message seen. */
  readonly #seenDay = new Map<string, { account: AccountRef; day: number }>();
  readonly #global: DayCount = { day: 0, count: 0 };
  #dirty = false;

  constructor(cfg: InitiativeConfig) {
    this.#cfg = cfg;
  }

  // --- time helpers ---

  #localMs(now: number): number {
    return now + Math.round(this.#cfg.timezone_offset_hours * 3600) * 1000;
  }

  /** Day index; the day starts at `day_start_hour` local time. */
  #dayOf(now: number): number {
    const shifted = this.#localMs(now) - (this.#cfg.day_start_hour % 24) * 3_600_000;
    return Math.floor(shifted / DAY_MS) + DAYS_FROM_CE_TO_EPOCH;
  }

  #inQuietHours(now: number): boolean {
    const start = this.#cfg.quiet_start_hour % 24;
    const end = this.#cfg.quiet_end_hour % 24;
    const local = this.#localMs(now);
    const hour = Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 3_600_000);
    if (start === end) return false;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  #moodFactor(sig: Signals): number {
    const raw = sig.mood ? sig.mood.mood().energy : 0.5;
    const energy = Math.min(Math.max(raw, 0), 1);
    return 2 ** (this.#cfg.mood_influence * (1 - 2 * energy));
  }

  #ctx(context: ContextKey): CtxState {
    const id = ctxId(context);
    let st = this.#contexts.get(id);
    if (!st) {
      st = newCtxState(context);
      this.#contexts.set(id, st);
    }
    return st;
  }

  // --- persistence ---

  /** Returns a snapshot when something changed since the last call. */
  takeSnapshot(): Snapshot | null {
    if (!this.#dirty) return null;
    this.#dirty = false;
    return {
      global: { ...this.#global },
      contexts: [...this.#contexts.values()]
        .filter((st) => st.count.count > 0 || st.backoffLevel > 0)
        .map((st) => ({
          context: st.context,
          count: { ...st.count },
          backoff_level: st.backoffLevel,
          backoff_at: st.backoffAt === null ? null : toTimestamp(st.backoffAt),
        })),
      seen: [...this.#seenDay.values()].map((s): [AccountRef, number] => [s.account, s.day]),
    };
  }

  restore(snapshot: Snapshot): void {
    this.#global.day = snapshot.global.day;
    this.#global.count = snapshot.global.count;
    for (const c of snapshot.contexts) {
      const st = this.#ctx(c.context);
      st.count = { ...c.count };
      st.backoffLevel = c.backoff_level;
      st.backoffAt = c.backoff_at === null ? null : timestampMs(c.backoff_at);
    }
    for (const [account, day] of snapshot.seen) {
      this.#seenDay.set(accId(account), { account, day });
    }
  }

  // --- events ---

  /** Digests one bus event; may return greetings to emit right away. */
  observe(now: number, event: Event, sig: Signals): Emission[] {
    switch (event.type) {
      case "platform_ready":
        this.#selfAccounts.add(accId(event.data.self_account));
        return [];
      case "platform_message_created": {
        const m = event.data;
        return this.#onMessage(now, m.id.context, m.author.account, m.author.is_bot, sig);
      }
      case "voice_utterance": {
        const u = event.data;
        return this.#onMessage(now, u.context, u.speaker.account, u.speaker.is_bot, sig);
      }
      case "voice_playback":
        if (event.data.state === "started") this.#record(now, event.data.context, true);
        return [];
      case "voice_joined": {
        const { context, participants } = event.data;
        this.#voice.set(ctxId(context), { context, members: this.#nonSelf(participants) });
        this.#ctx(context);
        return [];
      }
      case "voice_left": {
        const id = ctxId(event.data.context);
        this.#voice.delete(id);
        this.#contexts.delete(id);
        return [];
      }
      case "voice_participants":
        return this.#onVoiceParticipants(now, event.data.context, event.data.participants, sig);
      default:
        return [];
    }
  }

  #nonSelf(participants: readonly VoiceParticipant[]): Map<string, AccountRef> {
    const out = new Map<string, AccountRef>();
    for (const p of participants) {
      if (!p.is_self && !this.#selfAccounts.has(accId(p.account))) {
        out.set(accId(p.account), p.account);
      }
    }
    return out;
  }

  #onMessage(
    now: number,
    context: ContextKey,
    account: AccountRef,
    isBot: boolean,
    sig: Signals,
  ): Emission[] {
    const hers = this.#selfAccounts.has(accId(account));
    if (isBot && !hers) return [];
    this.#record(now, context, hers);
    if (hers) return [];
    const st = this.#contexts.get(ctxId(context));
    if (st) st.lastHuman = now;
    this.#people.set(accId(account), { account, lastAt: now, context });
    const greeting = this.#maybeGreet(now, context, account, sig);
    return greeting ? [greeting] : [];
  }

  /** Records a message in a context and settles a pending initiative. */
  #record(now: number, context: ContextKey, hers: boolean): void {
    const cfg = this.#cfg;
    const st = this.#ctx(context);
    if (st.lastActivity !== null && now - st.lastActivity > secsMs(cfg.idle_after_secs)) {
      resetSegment(st);
    }
    st.lastActivity = now;
    const since = now - secsMs(cfg.busy_window_secs);
    while (st.recent.length > 0 && (st.recent[0] as [number, boolean])[0] <= since) {
      st.recent.shift();
    }
    st.recent.push([now, hers]);
    st.segTotal++;
    if (hers) st.segSelf++;
    let replied = false;
    if (st.pending) {
      if (hers) {
        st.pending.spokeAt ??= now;
      } else {
        replied = st.pending.spokeAt !== null;
      }
    }
    if (replied) {
      st.pending = null;
      adjustLevel(st, cfg, now, false);
      this.#dirty = true;
      log.debug({ context: contextKeyString(context) }, "initiative got a reply, backoff relaxed");
    }
  }

  #maybeGreet(
    now: number,
    context: ContextKey,
    account: AccountRef,
    sig: Signals,
  ): Emission | null {
    const day = this.#dayOf(now);
    const key = accId(account);
    const previous = this.#seenDay.get(key);
    this.#seenDay.set(key, { account, day });
    if (previous?.day === day) return null;
    this.#dirty = true;
    if (!this.#cfg.greeting) return null;
    const attitude = sig.social?.attitude(account) ?? null;
    if (!attitude || attitude.blocked || !this.#isFriend(attitude)) return null;
    return this.#tryEmit(now, context, "greeting", GREETING_HINT, [account], false);
  }

  #isFriend(a: Attitude): boolean {
    return this.#cfg.friend_labels.includes(a.label);
  }

  #onVoiceParticipants(
    now: number,
    context: ContextKey,
    participants: readonly VoiceParticipant[],
    sig: Signals,
  ): Emission[] {
    const members = this.#nonSelf(participants);
    const id = ctxId(context);
    const previous = this.#voice.get(id);
    this.#voice.set(id, { context, members });
    if (!previous) {
      // We never saw her join: this is just the baseline.
      this.#ctx(context);
      return [];
    }
    const day = this.#dayOf(now);
    const cooldown = secsMs(this.#cfg.voice_join_cooldown_secs);
    const joiners = [...members.entries()]
      .filter(([k]) => !previous.members.has(k))
      .map(([, a]) => a)
      .sort((a, b) => cmpStr(a.id, b.id));
    for (const j of joiners) {
      const prev = this.#seenDay.get(accId(j));
      this.#seenDay.set(accId(j), { account: j, day });
      if (prev?.day !== day) this.#dirty = true;
    }
    if (!this.#cfg.voice_join) return [];
    const eligible = joiners.filter((j) => {
      const greeted = this.#voiceGreeted.get(accId(j));
      if (greeted !== undefined && now - greeted < cooldown) return false;
      const a = sig.social?.attitude(j);
      return (
        !!a && !a.blocked && (a.affinity >= this.#cfg.voice_join_min_affinity || this.#isFriend(a))
      );
    });
    if (eligible.length === 0) return [];
    const hint = eligible.length === 1 ? VOICE_JOIN_HINT : VOICE_JOIN_MANY_HINT;
    const e = this.#tryEmit(now, context, "voice_join", hint, [...eligible], false);
    if (!e) return [];
    for (const j of eligible) this.#voiceGreeted.set(accId(j), now);
    return [e];
  }

  // --- ticks ---

  /** Periodic work: settles unanswered initiatives and finds idle contexts. */
  tick(now: number, sig: Signals): Emission[] {
    this.#settlePending(now);
    this.#prune(now);
    const mood = this.#moodFactor(sig);
    const cfg = this.#cfg;
    const idleMax = secsMs(cfg.idle_max_secs);
    const due: ContextKey[] = [];
    for (const [id, st] of this.#contexts) {
      if (st.lastActivity === null) continue;
      const elapsed = now - st.lastActivity;
      if (elapsed > idleMax) {
        resetSegment(st);
        continue;
      }
      if (!cfg.idle_channel || !lively(st, cfg)) continue;
      if (st.context.kind === "voice" && (this.#voice.get(id)?.members.size ?? 0) === 0) continue;
      const threshold = cfg.idle_after_secs * 2 ** backoffLevel(st, cfg, now) * mood;
      if (elapsed / 1000 >= threshold) due.push(st.context);
    }
    due.sort((a, b) => cmpStr(contextKeyString(a), contextKeyString(b)));
    const out: Emission[] = [];
    for (const ctx of due) {
      const hint = ctx.kind === "voice" ? IDLE_VOICE_HINT : IDLE_HINT;
      const result = this.#tryEmitChecked(now, ctx, "idle_channel", hint, [], true);
      if ("blocked" in result) {
        const st = this.#contexts.get(ctxId(ctx));
        if (st && !st.blockedLogged) {
          st.blockedLogged = true;
          log.debug(
            { context: contextKeyString(ctx), blocked: result.blocked },
            "idle initiative held back",
          );
        }
      } else {
        out.push(result.emission);
      }
    }
    return out;
  }

  #settlePending(now: number): void {
    const cfg = this.#cfg;
    const window = secsMs(cfg.reply_window_secs);
    for (const st of this.#contexts.values()) {
      const p = st.pending;
      if (!p) continue;
      if (now < (p.spokeAt ?? p.at) + window) continue;
      if (p.spokeAt !== null) {
        adjustLevel(st, cfg, now, true);
        this.#dirty = true;
        log.debug(
          { context: contextKeyString(st.context), level: st.backoffLevel },
          "initiative unanswered, backing off",
        );
      }
      st.pending = null;
    }
  }

  #prune(now: number): void {
    const day = this.#dayOf(now);
    const before = this.#seenDay.size;
    for (const [k, s] of this.#seenDay) if (s.day < day - 1) this.#seenDay.delete(k);
    if (this.#seenDay.size !== before) this.#dirty = true;
    for (const [k, p] of this.#people) if (now - p.lastAt >= DAY_MS) this.#people.delete(k);
    for (const [k, at] of this.#voiceGreeted) if (now - at >= DAY_MS) this.#voiceGreeted.delete(k);
  }

  // --- followups ---

  /**
   * Decides whether a due followup can be brought up now. On a result the caller must publish
   * it and mark the followup done.
   */
  planFollowup(now: number, followup: Followup, sig: Signals): Emission | null {
    if (!this.#cfg.followup) return null;
    const active = secsMs(this.#cfg.followup_active_secs);
    // [context, account, last active]
    const cands: Array<[ContextKey, AccountRef | null, number]> = [];
    if (followup.person !== null) {
      const person = followup.person;
      const social = sig.social;
      if (!social) return null;
      const isThem = (a: AccountRef): boolean => {
        const att = social.attitude(a);
        return !!att && att.person === person && !att.blocked;
      };
      for (const p of this.#people.values()) {
        if (now - p.lastAt <= active && isThem(p.account)) {
          cands.push([p.context, p.account, p.lastAt]);
        }
      }
      for (const v of this.#voice.values()) {
        for (const acc of v.members.values()) {
          if (isThem(acc)) cands.push([v.context, acc, now]);
        }
      }
    } else {
      const ctx = followup.context;
      if (!ctx) return null;
      const last = this.#contexts.get(ctxId(ctx))?.lastHuman ?? null;
      if (last === null) return null;
      if (now - last <= active) cands.push([ctx, null, last]);
    }
    const own = followup.context ? ctxId(followup.context) : null;
    cands.sort((a, b) => {
      const pa = own !== null && ctxId(a[0]) === own ? 1 : 0;
      const pb = own !== null && ctxId(b[0]) === own ? 1 : 0;
      return pb - pa || b[2] - a[2] || cmpStr(contextKeyString(a[0]), contextKeyString(b[0]));
    });
    for (const [ctx, account] of cands) {
      const result = this.#tryEmitChecked(
        now,
        ctx,
        "followup",
        followup.about,
        account ? [account] : [],
        false,
      );
      if ("emission" in result) return result.emission;
      log.debug(
        { id: followup.id, context: contextKeyString(ctx), blocked: result.blocked },
        "followup held back",
      );
    }
    return null;
  }

  // --- budget ---

  #tryEmit(
    now: number,
    context: ContextKey,
    reason: InitiativeReason,
    hint: string,
    about: AccountRef[],
    idle: boolean,
  ): Emission | null {
    const result = this.#tryEmitChecked(now, context, reason, hint, about, idle);
    if ("emission" in result) return result.emission;
    log.debug(
      { context: contextKeyString(context), reason, blocked: result.blocked },
      "initiative held back",
    );
    return null;
  }

  /** Applies hard rules, then caps; on success books the initiative. */
  #tryEmitChecked(
    now: number,
    context: ContextKey,
    reason: InitiativeReason,
    hint: string,
    about: AccountRef[],
    idle: boolean,
  ): { emission: Emission } | { blocked: Blocked } {
    if (isContextDisabled(this.#cfg, context)) return { blocked: "disabled" };
    // Idle nudges are not reactions to anyone, so they stay out of quiet hours and do not
    // stack up on an unanswered one.
    if (idle && this.#inQuietHours(now)) return { blocked: "quiet_hours" };
    const day = this.#dayOf(now);
    const st = this.#ctx(context);
    if (idle && st.pending) return { blocked: "pending" };
    if (busy(st, this.#cfg, now)) return { blocked: "busy" };
    if (dayCountCurrent(st.count, day) >= this.#cfg.max_per_context_per_day) {
      return { blocked: "context_cap" };
    }
    if (dayCountCurrent(this.#global, day) >= this.#cfg.max_per_day) {
      return { blocked: "global_cap" };
    }
    dayCountBump(st.count, day);
    st.pending ??= { at: now, spokeAt: null };
    resetSegment(st);
    dayCountBump(this.#global, day);
    this.#dirty = true;
    log.debug({ context: contextKeyString(context), reason, hint }, "initiative emitted");
    return { emission: { context, reason, hint, about } };
  }
}
