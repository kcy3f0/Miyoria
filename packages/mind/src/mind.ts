// Her mind loop: when to think (triggers, the adaptive heartbeat, the caps), one thought (the
// snapshot, the `mind` LLM call, her reply), applying it to her inner state and handing her
// intents to the agent, and following what became of them for the journal.

import { ActuatorRegistryKey } from "@miyoria/actions";
import { errorMessage, type Logger, type ServiceLookup, sleep } from "@miyoria/kernel";
import { assistantMessage, type ChatMessage, LlmRouterKey, userMessage } from "@miyoria/llm";
import { SocialKey } from "@miyoria/social";
import {
  type AccountRef,
  CHAT_DM,
  CHAT_START,
  type Clock,
  type ContextKey,
  contextKeyString,
  customEvent,
  type Envelope,
  type Event,
  type Intent,
  type IntentOutcome,
  IntentSinkKey,
  isJsonObject,
  type JsonValue,
  type KnowledgeChange,
  KnowledgeKey,
  type KnowledgeSubject,
  MIND_THOUGHT_TOPIC,
  type Mind,
  type MindStats,
  type MindSuggestion,
  newId,
  type PatchOp,
  Principals,
  type ProfileId,
  SALIENT_TOPIC,
  type SalientEvent,
  type SelfState,
  SelfStateKey,
  type Thought,
  type ThoughtDecision,
  type ThoughtDigest,
  type ThoughtIntent,
  type ThoughtTrigger,
  type TurnId,
  toTimestamp,
  WorldStateKey,
} from "@miyoria/types";
import type { MindConfig } from "./config.js";
import type { Journal } from "./journal.js";
import { type BudgetState, CallLog, heartbeatMs, inQuietHours } from "./pace.js";
import { type MindInput, mindMessages, type PersonRef, type PlaceRef } from "./prompt.js";
import { type DocDraft, type MindReply, MindReplyError, parseMindReply } from "./reply.js";
import { capabilityInfo, gather, NOT_FOR_HER } from "./snapshot.js";

const MINUTE_MS = 60_000;
/** Her own turns make her reflect at most this often. */
const AFTER_TURN_GAP_MS = 5 * MINUTE_MS;
/** A voice lull counts after at least this many lines within `CONVERSATION_MS`. */
const CONVERSATION_LINES = 3;
const CONVERSATION_MS = 5 * MINUTE_MS;
/** At most one voice-lull thought per channel in this time. */
const VOICE_QUIET_GAP_MS = 3 * MINUTE_MS;
/** While she is in voice the loop checks for lulls this often. */
const VOICE_CHECK_MS = 5_000;
/** Pending triggers kept (older ones are merged away). */
const MAX_PENDING = 12;
const RECENT_THOUGHTS = 5;
/** Events of intent turns remembered until the intent's outcome names the turn. */
const MAX_TURN_EVENTS = 200;
/** Salient events below this score do not wake her while the budget is degraded. */
const DEGRADED_MIN_SCORE = 0.6;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export interface MindDeps {
  config: MindConfig;
  profile: ProfileId;
  name: string;
  /** Her persona prompt (the live one, if the agent runs). */
  persona: () => string;
  services: ServiceLookup;
  clock: Clock;
  publish: (event: Event) => void;
  log: Logger;
  journal: Journal;
}

interface VoiceRoom {
  context: ContextKey;
  people: number;
  lines: number[];
  last: number | null;
  lullAt: number | null;
}

type TurnEvent =
  | { type: "decision"; decision: ThoughtDecision }
  | { type: "skipped"; why: string }
  | { type: "completed"; text: string };

const SALIENT_TEXT = (e: SalientEvent) => e.detail;

function localTime(now: number, offsetMinutes: number): string {
  const d = new Date(now + offsetMinutes * MINUTE_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}(星期${WEEKDAYS[d.getUTCDay()]})`
  );
}

function parseContext(value: JsonValue | undefined): ContextKey | null {
  if (!isJsonObject(value)) return null;
  const { platform, scope, channel, kind } = value;
  if (typeof platform !== "string" || typeof channel !== "string") return null;
  if (kind !== "channel" && kind !== "thread" && kind !== "dm" && kind !== "voice") return null;
  return { platform, scope: typeof scope === "string" ? scope : null, channel, kind };
}

function parseSalient(payload: JsonValue): SalientEvent | null {
  if (!isJsonObject(payload) || typeof payload.detail !== "string") return null;
  const account = isJsonObject(payload.account) ? payload.account : null;
  return {
    kind: (typeof payload.kind === "string" ? payload.kind : "came_online") as SalientEvent["kind"],
    key: typeof payload.key === "string" ? payload.key : "",
    account:
      account && typeof account.platform === "string" && typeof account.id === "string"
        ? { platform: account.platform, id: account.id }
        : null,
    person: typeof payload.person === "string" ? payload.person : null,
    display_name: typeof payload.display_name === "string" ? payload.display_name : null,
    context: parseContext(payload.context),
    detail: payload.detail,
    score: typeof payload.score === "number" ? payload.score : 0.5,
    count: typeof payload.count === "number" ? payload.count : 1,
    first_at: typeof payload.first_at === "string" ? payload.first_at : "",
    at: typeof payload.at === "string" ? payload.at : "",
  };
}

export class MindLoop implements Mind {
  readonly #d: MindDeps;
  readonly #calls: CallLog;
  #pending: ThoughtTrigger[] = [];
  #firstPendingAt: number | null = null;
  #suggestions: MindSuggestion[] = [];
  #salient: SalientEvent[] = [];
  #nextHeartbeat: number | null = null;
  #idleStreak = 0;
  #running = false;
  #thinking = false;
  #wake: (() => void) | null = null;
  #fallbackWarned = false;
  #tokens = 0;
  readonly #selfIds = new Set<string>();
  readonly #rooms = new Map<string, VoiceRoom>();
  readonly #labels = new Map<string, string>();
  /** Turns of her intents (and events seen for turns not yet known to be hers). */
  readonly #turnEvents = new Map<TurnId, TurnEvent[]>();
  readonly #ownTurns = new Set<TurnId>();

  constructor(deps: MindDeps) {
    this.#d = deps;
    this.#calls = new CallLog(deps.config);
  }

  // ---- Mind ---------------------------------------------------------------------------------

  get accepting(): boolean {
    return this.#idleReason() === null;
  }

  suggest(suggestion: MindSuggestion): boolean {
    if (!this.accepting) return false;
    this.#suggestions = [...this.#suggestions, suggestion].slice(-MAX_PENDING);
    // A followup must not be lost if she does not act on it right away.
    if (suggestion.reason === "followup") this.#followupAgenda(suggestion);
    this.trigger({
      kind: "suggestion",
      detail: `${suggestion.reason}`,
      context: suggestion.context,
      at: toTimestamp(this.#now()),
    });
    return true;
  }

  thoughts(limit = 50): Thought[] {
    return this.#d.journal.list(limit);
  }

  digests(limit = 20): ThoughtDigest[] {
    return this.#d.journal.digests(limit);
  }

  stats(): MindStats {
    const now = this.#now();
    const last = this.#calls.last();
    return {
      calls_last_hour: this.#calls.lastHour(now),
      max_calls_per_hour: this.#d.config.max_calls_per_hour,
      calls_total: this.#calls.total,
      tokens_total: this.#tokens,
      last_at: last === null ? null : toTimestamp(last),
      next_heartbeat_at: this.#nextHeartbeat === null ? null : toTimestamp(this.#nextHeartbeat),
      idle_reason: this.#idleReason(),
    };
  }

  // ---- triggers -----------------------------------------------------------------------------

  #now(): number {
    return this.#d.clock.now();
  }

  #budget(): BudgetState {
    return this.#d.services.get(LlmRouterKey)?.budgetState() ?? "ok";
  }

  #idleReason(): string | null {
    if (!this.#running) return "not running";
    if (this.#d.services.get(ActuatorRegistryKey)?.paused) return "paused";
    if (this.#budget() === "exhausted") return "budget exhausted";
    if (this.#d.config.max_calls_per_hour === 0) return "max_calls_per_hour is 0";
    return null;
  }

  /** Something worth thinking about happened. */
  trigger(t: ThoughtTrigger): void {
    if (this.#pending.length === 0) this.#firstPendingAt = this.#now();
    this.#pending = [...this.#pending, t].slice(-MAX_PENDING);
    this.#wake?.();
  }

  #followupAgenda(s: MindSuggestion): void {
    const self = this.#d.services.get(SelfStateKey);
    if (!self) return;
    const person = s.about[0]
      ? (this.#d.services.get(SocialKey)?.personOf(s.about[0]) ?? null)
      : null;
    if (self.agenda().some((a) => a.text === s.hint)) return;
    self.addAgenda({
      text: s.hint,
      why: "之前說好要問的",
      person,
      context: s.context,
      expiresAt: toTimestamp(this.#now() + 2 * 24 * 60 * MINUTE_MS),
    });
  }

  /** Feeds one bus event (salience, her turns, voice activity, gate decisions). */
  observe(env: Envelope): void {
    const event = env.event;
    const now = this.#now();
    switch (event.type) {
      case "platform_ready":
        this.#selfIds.add(event.data.self_account.id);
        return;
      case "voice_joined":
      case "voice_participants": {
        const id = contextKeyString(event.data.context);
        const room = this.#rooms.get(id) ?? {
          context: event.data.context,
          people: 0,
          lines: [],
          last: null,
          lullAt: null,
        };
        room.people = event.data.participants.filter(
          (p) => !p.is_self && !this.#selfIds.has(p.account.id),
        ).length;
        if (event.type === "voice_joined") this.#rooms.set(id, room);
        else if (this.#rooms.has(id)) this.#rooms.set(id, room);
        this.#wake?.();
        return;
      }
      case "voice_left":
        this.#rooms.delete(contextKeyString(event.data.context));
        return;
      case "voice_utterance":
        if (event.data.speaker.is_bot || this.#selfIds.has(event.data.speaker.account.id)) return;
        this.#voiceLine(event.data.context, now);
        return;
      case "voice_playback":
        if (event.data.state === "started") this.#voiceLine(event.data.context, now);
        return;
      case "agent_turn_completed": {
        const { turn, context, text } = event.data;
        if (this.#turnEvent(turn, { type: "completed", text })) return;
        const last = this.#calls.last();
        const quietEnough = last === null || now - last >= AFTER_TURN_GAP_MS;
        if (text.trim() !== "" && quietEnough && !this.#pending.some((p) => p.kind === "turn")) {
          this.trigger({ kind: "turn", detail: "", context, at: toTimestamp(now) });
        }
        return;
      }
      case "agent_decision": {
        const d = event.data;
        const skipped = d.reasons.find((r) => r.startsWith("skipped: "));
        if (!d.respond && skipped && d.reasons.some((r) => r.startsWith("intent:"))) {
          this.#turnEvent(d.turn, { type: "skipped", why: skipped.slice("skipped: ".length) });
        }
        return;
      }
      case "custom": {
        const { topic, payload } = event.data;
        if (topic === SALIENT_TOPIC) {
          const salient = parseSalient(payload);
          if (!salient) return;
          if (this.#budget() === "degraded" && salient.score < DEGRADED_MIN_SCORE) return;
          this.#salient = [...this.#salient, salient].slice(-MAX_PENDING);
          this.trigger({
            kind: "salient",
            detail: SALIENT_TEXT(salient),
            context: salient.context,
            at: toTimestamp(now),
          });
        } else if (topic === "gate.decision" && isJsonObject(payload)) {
          const turn = typeof payload.turn === "string" ? payload.turn : null;
          if (turn === null) return;
          this.#turnEvent(turn, {
            type: "decision",
            decision: {
              at: typeof payload.at === "string" ? payload.at : toTimestamp(now),
              capability: String(payload.capability ?? ""),
              allowed: payload.allowed === true,
              stage: String(payload.stage ?? ""),
              reason: String(payload.reason ?? ""),
            },
          });
        } else if (topic === "llm.budget") {
          this.#wake?.();
        }
        return;
      }
      default:
        return;
    }
  }

  #voiceLine(context: ContextKey, now: number): void {
    const room = this.#rooms.get(contextKeyString(context));
    if (!room) return;
    room.lines = [...room.lines.filter((t) => now - t < CONVERSATION_MS), now];
    room.last = now;
  }

  /**
   * Records an event of an intent turn. Returns whether the turn is (or may become) one of hers;
   * unknown turns are remembered until an intent outcome claims them.
   */
  #turnEvent(turn: TurnId, e: TurnEvent): boolean {
    const list = this.#turnEvents.get(turn) ?? [];
    list.push(e);
    this.#turnEvents.set(turn, list);
    if (this.#turnEvents.size > MAX_TURN_EVENTS) {
      const oldest = this.#turnEvents.keys().next().value;
      if (oldest !== undefined) this.#turnEvents.delete(oldest);
    }
    if (!this.#ownTurns.has(turn)) return false;
    this.#d.journal.updateByTurn(turn, (_t, intent) => applyTurnEvent(intent, e));
    return true;
  }

  #own(turn: TurnId): void {
    this.#ownTurns.add(turn);
    if (this.#ownTurns.size > MAX_TURN_EVENTS) {
      const oldest = this.#ownTurns.values().next().value;
      if (oldest !== undefined) this.#ownTurns.delete(oldest);
    }
  }

  /** Voice channels she is in that went quiet after a conversation. */
  #checkVoice(now: number): void {
    for (const room of this.#rooms.values()) {
      if (room.people === 0 || room.last === null) continue;
      if (now - room.last < this.#d.config.voice_quiet_secs * 1000) continue;
      const conversation = room.lines.filter(
        (t) => room.last !== null && room.last - t < CONVERSATION_MS,
      );
      if (conversation.length < CONVERSATION_LINES) continue;
      if (room.lullAt !== null && now - room.lullAt < VOICE_QUIET_GAP_MS) continue;
      room.lullAt = now;
      room.lines = [];
      this.trigger({
        kind: "voice_quiet",
        detail: "大家安靜下來了,可以找個話題(記得的事、議程、大家在做的事)",
        context: room.context,
        at: toTimestamp(now),
      });
    }
  }

  // ---- loop ---------------------------------------------------------------------------------

  async run(signal: AbortSignal): Promise<void> {
    this.#running = true;
    try {
      while (!signal.aborted) {
        const now = this.#now();
        this.#checkVoice(now);
        const delay = this.#due(now);
        if (delay <= 0) {
          await this.#thinkPending(signal);
          continue;
        }
        const nap = Math.min(delay, this.#rooms.size > 0 ? VOICE_CHECK_MS : 60_000);
        // A trigger ends the nap early (and its timer with it).
        const napping = new AbortController();
        const stop = () => napping.abort();
        signal.addEventListener("abort", stop, { once: true });
        this.#wake = stop;
        await sleep(nap, napping.signal).catch(() => undefined);
        signal.removeEventListener("abort", stop);
        this.#wake = null;
      }
    } finally {
      this.#running = false;
    }
  }

  /** Ms until the next thought may happen (≤ 0: now). */
  #due(now: number): number {
    if (this.#idleReason() !== null) {
      // Nothing waits through a pause: what was going on is stale by then.
      this.#pending = [];
      this.#suggestions = [];
      this.#salient = [];
      this.#nextHeartbeat = null;
      return 30_000;
    }
    const rate = this.#calls.waitMs(now);
    if (this.#pending.length > 0) {
      const coalesced = (this.#firstPendingAt ?? now) + this.#d.config.coalesce_ms - now;
      return Math.max(coalesced, rate);
    }
    if (this.#nextHeartbeat === null) this.#scheduleHeartbeat(now);
    if (this.#nextHeartbeat === null) return 60_000;
    return Math.max(this.#nextHeartbeat - now, rate);
  }

  #scheduleHeartbeat(now: number): void {
    const self = this.#d.services.get(SelfStateKey);
    const world = this.#d.services.get(WorldStateKey)?.snapshot() ?? null;
    const ms = heartbeatMs(
      {
        lively: world?.channels.some((c) => c.lively) ?? false,
        inVoice: [...this.#rooms.values()].some((r) => r.people > 0),
        agendaDue: (self?.agenda() ?? []).some((a) => a.due === null || Date.parse(a.due) <= now),
        night: inQuietHours(now, this.#d.config),
        budget: this.#budget(),
        idleStreak: this.#idleStreak,
        boredom: self?.boredom() ?? 0,
      },
      this.#d.config,
    );
    this.#nextHeartbeat = ms === null ? null : now + ms;
  }

  async #thinkPending(signal: AbortSignal): Promise<void> {
    const now = this.#now();
    const triggers =
      this.#pending.length > 0
        ? this.#pending
        : [{ kind: "heartbeat" as const, detail: "", context: null, at: toTimestamp(now) }];
    const suggestions = this.#suggestions;
    const salient = this.#salient;
    this.#pending = [];
    this.#suggestions = [];
    this.#salient = [];
    this.#firstPendingAt = null;
    const onlyHeartbeat = triggers.every((t) => t.kind === "heartbeat");
    const thought = await this.think(triggers, suggestions, salient, signal);
    const acted = (thought?.intents.length ?? 0) > 0;
    this.#idleStreak = onlyHeartbeat && !acted ? this.#idleStreak + 1 : 0;
    this.#scheduleHeartbeat(this.#now());
  }

  // ---- one thought --------------------------------------------------------------------------

  /** Thinks once about `triggers`; `null` when she cannot think right now. */
  async think(
    triggers: ThoughtTrigger[],
    suggestions: MindSuggestion[] = [],
    salient: SalientEvent[] = [],
    signal?: AbortSignal,
  ): Promise<Thought | null> {
    const d = this.#d;
    const router = d.services.get(LlmRouterKey);
    if (!router || this.#thinking) return null;
    this.#thinking = true;
    const started = this.#now();
    try {
      const cfg = d.config;
      if (!router.configures(cfg.purpose) && !this.#fallbackWarned) {
        this.#fallbackWarned = true;
        d.log.warn({ purpose: cfg.purpose }, "no model chain for the mind purpose; using chat");
      }
      const self = d.services.get(SelfStateKey);
      const registry = d.services.get(ActuatorRegistryKey);
      const snap = await gather({
        services: d.services,
        profile: d.profile,
        now: started,
        triggers,
        suggestions,
        salient,
        contributors: cfg.contributors,
        labels: this.#labels,
        ...(signal ? { signal } : {}),
      });
      const night = inQuietHours(started, cfg);
      const input: MindInput = {
        name: d.name,
        persona: d.persona(),
        time: localTime(started, cfg.utc_offset_minutes),
        night,
        self: self?.snapshot() ?? null,
        capabilities: capabilityInfo(registry),
        maxIntents: cfg.max_intents,
        triggers,
        suggestions,
        world: snap.world,
        places: snap.places,
        people: snap.people,
        agenda: snap.agenda,
        recent: d.journal.recent(RECENT_THOUGHTS),
        memories: snap.memories,
        documents: snap.documents,
        lessons: snap.lessons,
        recap: snap.recap,
        digest: d.journal.digests(1)[0]?.summary ?? null,
      };
      this.#calls.record(started);
      const thought: Thought = {
        id: newId(),
        at: toTimestamp(started),
        triggers,
        thought: "",
        changes: [],
        intents: [],
        tokens: null,
        error: null,
        ms: 0,
      };
      let reply: MindReply;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);
      try {
        // `json_mode` is a hint; the reply is extracted and validated either way, and one
        // unusable reply gets one repair try with the problem spelled out.
        let messages: ChatMessage[] = mindMessages(input);
        for (let attempt = 1; ; attempt++) {
          const response = await router.complete(
            cfg.purpose,
            {
              messages,
              json_mode: true,
              thinking: true,
              max_tokens: cfg.max_tokens,
              session: `mind-${d.profile}`,
            },
            controller.signal,
          );
          const usage = response.usage;
          if (usage) {
            const used = usage.prompt_tokens + usage.completion_tokens;
            thought.tokens = (thought.tokens ?? 0) + used;
            this.#tokens += used;
          }
          try {
            reply = parseMindReply(response.text, cfg.max_intents);
            break;
          } catch (error) {
            if (!(error instanceof MindReplyError) || attempt >= 2) throw error;
            messages = [
              ...messages,
              assistantMessage(response.text.slice(0, 4000)),
              userMessage(
                `上面的回覆不能用:${error.message}。請只回傳一個符合格式的 JSON 物件,不要加其他文字。`,
              ),
            ];
          }
        }
      } catch (error) {
        if (signal?.aborted) return null;
        thought.error = controller.signal.aborted ? "timed out" : errorMessage(error);
        thought.ms = this.#now() - started;
        d.log.warn({ err: thought.error }, "her thought failed");
        await d.journal.add(thought);
        return thought;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      thought.thought = reply.thought;
      thought.ms = this.#now() - started;
      const onlyHeartbeat = triggers.every((t) => t.kind === "heartbeat");
      thought.changes = await this.#apply(reply, snap.people, snap.places, snap.focus, self);
      const intents = this.#intents(
        reply,
        snap.people,
        snap.places,
        snap.focus,
        night && onlyHeartbeat,
      );
      thought.intents = intents.map(([, record]) => record);
      await d.journal.add(thought);
      // Acting can take a while (the scheduler's lanes, joining voice): the loop goes on.
      void this.#act(thought.id, intents, signal).catch((error: unknown) => {
        d.log.warn({ err: errorMessage(error) }, "acting on her intents failed");
      });
      return thought;
    } finally {
      this.#thinking = false;
    }
  }

  /** Applies feelings, drives, policy and agenda; returns what changed, in words. */
  async #apply(
    reply: MindReply,
    people: PersonRef[],
    places: PlaceRef[],
    focus: ContextKey | null,
    self: SelfState | undefined,
  ): Promise<string[]> {
    const changes: string[] = [];
    const now = this.#now();
    const person = (ref: string | null) =>
      ref === null ? undefined : people.find((p) => p.ref === ref);
    const place = (ref: string | null) =>
      ref === null ? undefined : places.find((p) => p.ref === ref);
    const social = this.#d.services.get(SocialKey);
    for (const f of reply.feelings) {
      const p = person(f.person);
      if (!p || p.person === null) continue;
      if (f.note !== null && self) {
        try {
          await self.setFeeling(p.person, f.note, "self");
          changes.push(`對 ${p.name} 的感覺`);
        } catch (error) {
          this.#d.log.warn({ err: errorMessage(error) }, "cannot write her feelings");
        }
      }
      if ((f.hint === "+" || f.hint === "-") && social) {
        // A hint, not a number: social's daily caps decide what it is worth.
        await social.applyEvents(
          p.person,
          [["mind", f.hint === "+" ? "warm" : "cold", 0.3]],
          null,
          null,
          now,
        );
        changes.push(`好感 ${p.name} ${f.hint}`);
      }
    }
    if (!self) return changes;
    const drives = Object.entries(reply.drives);
    if (drives.length > 0) {
      self.adjust(reply.drives, "mind");
      changes.push(
        `慾望 ${drives.map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v.toFixed(2)}`).join("、")}`,
      );
    }
    for (const t of reply.talkativeness) {
      const scope = this.#scope(t.scope, place(t.scope)?.context ?? null, focus);
      if (scope === null) continue;
      self.setTalkativeness(scope, { level: t.level, forMs: t.minutes * MINUTE_MS, why: t.why });
      changes.push(`多話程度 ${scope} ${t.level.toFixed(2)}(${t.minutes} 分鐘)`);
    }
    if (reply.initiative !== null) {
      self.setInitiative(reply.initiative.level, reply.initiative.why);
      changes.push(`主動程度 ${reply.initiative.level.toFixed(2)}`);
    }
    for (const a of reply.agendaAdd) {
      const item = self.addAgenda({
        text: a.text,
        why: a.why,
        person: person(a.person)?.person ?? null,
        context: place(a.place)?.context ?? null,
        due: a.dueInMin === null ? null : toTimestamp(now + a.dueInMin * MINUTE_MS),
        expiresAt: toTimestamp(now + a.expiresInMin * MINUTE_MS),
      });
      changes.push(`議程 +「${item.text}」`);
    }
    const open = self.agenda();
    const byRef = (ref: string) => {
      const n = /^g(\d+)$/.exec(ref.trim())?.[1];
      return n === undefined ? undefined : open[Number(n) - 1];
    };
    for (const ref of reply.agendaDone) {
      const item = byRef(ref);
      if (item && self.completeAgenda(item.id)) changes.push(`完成議程「${item.text}」`);
    }
    for (const ref of reply.agendaDrop) {
      const item = byRef(ref);
      if (item && self.dropAgenda(item.id)) changes.push(`放棄議程「${item.text}」`);
    }
    changes.push(...(await this.#documents(reply.documents, people, focus)));
    return changes;
  }

  /** Her document changes (her own judgment, privileged), each all or nothing. */
  async #documents(
    drafts: readonly DocDraft[],
    people: PersonRef[],
    focus: ContextKey | null,
  ): Promise<string[]> {
    const kb = this.#d.services.get(KnowledgeKey);
    if (!kb || drafts.length === 0) return [];
    const out: string[] = [];
    const subjectOf = (ref: string | null): KnowledgeSubject | null => {
      const r = ref?.trim() ?? "";
      if (r === "self") return { type: "self" };
      if (r === "server") {
        return focus?.scope && focus.kind !== "dm"
          ? { type: "guild", platform: focus.platform, guild: focus.scope }
          : null;
      }
      if (r.startsWith("topic:") && r.length > 6) return { type: "topic", name: r.slice(6) };
      const person = people.find((p) => p.ref === r)?.person ?? null;
      return person === null ? null : { type: "person", person };
    };
    for (const d of drafts) {
      let change: KnowledgeChange | null = null;
      switch (d.type) {
        case "create": {
          const subject = subjectOf(d.subject);
          if (subject && d.kind && d.title) {
            change = {
              type: "create",
              subject,
              kind: d.kind,
              title: d.title,
              content: d.content,
              why: d.why,
            };
          }
          break;
        }
        case "patch":
          if (d.doc)
            change = { type: "patch", doc: d.doc, ops: d.ops as unknown as PatchOp[], why: d.why };
          break;
        case "retitle":
          if (d.doc)
            change = { type: "retitle", doc: d.doc, kind: d.kind, title: d.title, why: d.why };
          break;
        case "delete":
          if (d.doc) change = { type: "delete", doc: d.doc, why: d.why };
          break;
        case "merge":
          if (d.doc && d.into) {
            change = { type: "merge", doc: d.doc, into: d.into, path: d.path, why: d.why };
          }
          break;
      }
      if (change === null) continue;
      try {
        const result = await kb.apply(change, {
          kind: "self",
          account: null,
          person: null,
          name: null,
          context: focus,
        });
        if (result.ok) {
          out.push(result.doc ? `資料 ${d.type}「${result.doc.title}」` : `資料 ${d.type}`);
        } else this.#d.log.debug({ err: result.error }, "her document change was refused");
      } catch (error) {
        this.#d.log.warn({ err: errorMessage(error) }, "cannot change her documents");
      }
    }
    return out;
  }

  /** A talkativeness scope from her reply: a place ref, `here`, `server` or a kind. */
  #scope(raw: string, place: ContextKey | null, focus: ContextKey | null): string | null {
    if (place !== null) return contextKeyString(place);
    const v = raw.trim().toLowerCase();
    if (v === "*" || v === "voice" || v === "text") return v;
    if (v === "here") return focus === null ? null : contextKeyString(focus);
    if (v === "server") {
      return focus?.scope ? `${focus.platform}:${focus.scope}` : null;
    }
    return null;
  }

  /** Her intents resolved against the snapshot: `[intent, journal record]`. */
  #intents(
    reply: MindReply,
    people: PersonRef[],
    places: PlaceRef[],
    focus: ContextKey | null,
    quiet: boolean,
  ): [Intent | null, ThoughtIntent][] {
    const registry = this.#d.services.get(ActuatorRegistryKey);
    const now = this.#now();
    return reply.intents.map((draft) => {
      const place = draft.place === null ? undefined : places.find((p) => p.ref === draft.place);
      const who = draft.person === null ? undefined : people.find((p) => p.ref === draft.person);
      let context: ContextKey | null = place?.context ?? focus;
      const args = { ...draft.args };
      let problem: string | null = null;
      const known = registry?.get(draft.action) !== undefined;
      if (!known || NOT_FOR_HER.includes(draft.action)) problem = "not something she can do";
      else if (quiet && (draft.action === CHAT_START || draft.action === CHAT_DM)) {
        problem = "quiet hours";
      }
      if (draft.action === CHAT_DM) {
        if (!who) problem ??= "nobody to DM";
        else args.to = who.account.id;
      }
      if (draft.action === "voice.join" && place?.context.kind === "voice") {
        args.channel = place.context.channel;
        if (place.context.scope !== null) args.guild = place.context.scope;
      }
      if (draft.action === "voice.join" && args.channel === undefined) {
        problem ??= "no voice channel to join";
      }
      if (draft.action === CHAT_START && context === null) problem ??= "no place to talk";
      if (context?.kind === "dm") context = null;
      const about: AccountRef | null = who?.account ?? null;
      const intent: Intent = {
        id: newId(),
        capability: draft.action,
        args: JSON.parse(JSON.stringify(args)),
        why: draft.why,
        opening: draft.opening,
        context,
        about,
        created_at: toTimestamp(now),
        expires_at: toTimestamp(now + draft.expiresInS * 1000),
      };
      const record: ThoughtIntent = {
        id: intent.id,
        capability: intent.capability,
        args: intent.args,
        why: intent.why,
        opening: intent.opening,
        context,
        about,
        expires_at: intent.expires_at,
        status: problem === null ? "pending" : "dropped",
        detail: problem,
        turn: null,
        decisions: [],
        said: null,
      };
      return [problem === null ? intent : null, record];
    });
  }

  /** Hands her intents to the agent one by one and follows their outcome. */
  async #act(
    thoughtId: string,
    intents: [Intent | null, ThoughtIntent][],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const [intent] of intents) {
      if (intent === null || signal?.aborted) continue;
      const outcome = await this.#submit(intent, signal);
      if (outcome.turn !== null) this.#own(outcome.turn);
      this.#d.journal.update(thoughtId, (t) => {
        const record = t.intents.find((i) => i.id === intent.id);
        if (!record) return;
        record.status = outcome.status;
        record.detail = outcome.detail;
        record.turn = outcome.turn;
        // Events of the turn that arrived before its outcome.
        for (const e of outcome.turn === null ? [] : (this.#turnEvents.get(outcome.turn) ?? [])) {
          applyTurnEvent(record, e);
        }
      });
    }
  }

  async #submit(intent: Intent, signal: AbortSignal | undefined): Promise<IntentOutcome> {
    const sink = this.#d.services.get(IntentSinkKey);
    try {
      if (sink) return await sink.submit(intent, signal);
      // Without the agent she can still act, just not talk.
      const registry = this.#d.services.get(ActuatorRegistryKey);
      if (!registry) return { status: "dropped", detail: "no actuator registry", turn: null };
      const turn = newId();
      const outcome = await registry.invoke(
        {
          principal: Principals.self(intent.context, null),
          capability: intent.capability,
          args: intent.args,
          why: intent.why === "" ? null : intent.why,
          turn,
          about: intent.about,
        },
        signal ? { signal } : {},
      );
      if (outcome.status === "done") return { status: "done", detail: outcome.result.text, turn };
      if (outcome.status === "denied") {
        return { status: "denied", detail: outcome.decision.reason, turn };
      }
      return { status: "failed", detail: outcome.error, turn };
    } catch (error) {
      return { status: "failed", detail: errorMessage(error), turn: null };
    }
  }

  /** Publishes a journal entry (`mind.thought`). */
  static publish(publish: (event: Event) => void, thought: Thought): void {
    publish(customEvent(MIND_THOUGHT_TOPIC, JSON.parse(JSON.stringify(thought)) as JsonValue));
  }
}

/** Folds an event of her intent's turn into its journal record. */
export function applyTurnEvent(intent: ThoughtIntent, e: TurnEvent): void {
  switch (e.type) {
    case "decision":
      if (intent.decisions.length < 10) intent.decisions.push(e.decision);
      return;
    case "skipped":
      intent.status = "dropped";
      intent.detail = e.why;
      return;
    case "completed":
      if (e.text.trim() !== "") {
        intent.said = e.text;
        if (intent.status === "started") intent.status = "done";
      } else if (intent.status === "started") {
        intent.status = "dropped";
        intent.detail = "she stayed quiet or was interrupted";
      }
      return;
  }
}
