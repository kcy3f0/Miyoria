// The agent's event loop: turns bus events into session updates and coordinator input, and
// keeps the state shared by the per-context coordinators and their turns.

import { errorMessage, type Logger, type ModuleContext, type Subscription } from "@miyoria/kernel";
import type { ToolRegistry } from "@miyoria/tools";
import {
  type AccountRef,
  type ActionId,
  type Attitude,
  type ContextKey,
  type Envelope,
  type IncomingMessage,
  isJsonObject,
  type JsonValue,
  type Mood,
  MoodSignalsKey,
  newId,
  type PlatformId,
  type PlaybackState,
  type SocialSignals,
  SocialSignalsKey,
  type TurnId,
  type VoiceParticipant,
  type VoiceUtterance,
} from "@miyoria/types";
import type { RandomSource } from "./attention.js";
import type { AgentCommands } from "./commands.js";
import { type AgentConfig, cooldownFactor } from "./config.js";
import { Coordinator } from "./coordinator.js";
import type { AgentHandle } from "./handle.js";
import { startBackfill } from "./history.js";
import { agentTurns } from "./metrics.js";
import type { PersonaHandle } from "./persona.js";
import { Session } from "./session.js";
import { BUDGET_TOPIC, energyCooldownFactor, parseBudgetState } from "./signals.js";
import { accountId, contextId } from "./util.js";
import { type FetchLike, ImageLoader } from "./vision.js";

/** Module whose restart means the agent commands must be registered again. */
const COMMANDS_MODULE = "commands";

/** An `agent.initiative` request. */
export interface Initiative {
  reason: string;
  hint: string;
  about: AccountRef[];
}

export type Input =
  /** A platform message or a voice utterance (as a message). */
  | { type: "message"; message: IncomingMessage }
  | { type: "typing" }
  /** Someone in the voice channel started or stopped speaking. */
  | { type: "speaking" }
  /** Playback of her speech for `turn` changed. */
  | { type: "playback"; turn: TurnId; state: PlaybackState }
  /** Start a turn on her own (no new input), if the context is quiet. */
  | { type: "initiative"; initiative: Initiative };

/** Unbounded queue from the event loop to one coordinator (Rust `mpsc` channel). */
export class Inbox {
  readonly #items: Input[] = [];
  #waiter: (() => void) | null = null;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  get isEmpty(): boolean {
    return this.#items.length === 0;
  }

  /** `false` once closed (the coordinator is gone). */
  push(item: Input): boolean {
    if (this.#closed) return false;
    this.#items.push(item);
    this.#wake();
    return true;
  }

  shift(): Input | undefined {
    return this.#items.shift();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  /** Resolves once there is an item or the inbox is closed. */
  ready(): Promise<void> {
    if (this.#items.length > 0 || this.#closed) return Promise.resolve();
    return new Promise((resolve) => {
      const previous = this.#waiter;
      this.#waiter = () => {
        previous?.();
        resolve();
      };
    });
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }
}

interface ContextHandle {
  session: Session;
  inbox: Inbox;
}

/** State shared by the event loop, the per-context coordinators and turns. */
export class Agent {
  readonly #selfAccounts = new Map<string, AccountRef>();
  readonly #contexts = new Map<string, ContextHandle>();
  /** Her submitted messages awaiting `action.completed`. */
  readonly #pendingActions = new Map<ActionId, Session>();
  /** When she last said she is out of energy (budget exhausted), per context (clock ms). */
  readonly #budgetNotices = new Map<string, number>();
  /** Downloads the images she looks at (cached by attachment id). */
  readonly images: ImageLoader;

  constructor(
    readonly ctx: ModuleContext,
    readonly config: AgentConfig,
    readonly persona: PersonaHandle,
    readonly random: RandomSource,
    readonly handle: AgentHandle,
    readonly tools: ToolRegistry,
    readonly commands: AgentCommands,
    fetchImage?: FetchLike,
  ) {
    this.images = new ImageLoader(fetchImage, (key, error) =>
      this.log.debug({ image: key, error }, "could not download image"),
    );
  }

  get log(): Logger {
    return this.ctx.log;
  }

  static topics(): string[] {
    return [
      "platform.ready",
      "platform.message.created",
      "platform.typing",
      "voice.*",
      "action.completed",
      "system.module.state",
      "agent.initiative",
      BUDGET_TOPIC,
    ];
  }

  async run(sub: Subscription): Promise<void> {
    for await (const env of sub) {
      try {
        this.#handle(env);
      } catch (error) {
        this.log.warn({ error: errorMessage(error) }, "could not handle event");
      }
    }
  }

  #handle(env: Envelope): void {
    const event = env.event;
    switch (event.type) {
      case "platform_ready": {
        const account = event.data.self_account;
        this.log.debug({ platform: account.platform, id: account.id }, "self account ready");
        this.#selfAccounts.set(accountId(account), account);
        break;
      }
      case "platform_message_created":
        this.#onMessage(event.data);
        break;
      case "platform_typing":
        if (!this.isSelf(event.data.account)) {
          this.#contexts.get(contextId(event.data.context))?.inbox.push({ type: "typing" });
        }
        break;
      case "voice_joined":
      case "voice_participants":
        if (this.#isVoice(event.data.context)) {
          this.#onVoiceMembers(event.data.context, event.data.participants);
        }
        break;
      case "voice_left": {
        const { context, reason } = event.data;
        if (!this.#isVoice(context)) break;
        this.log.debug({ context: contextId(context), reason }, "left voice, session dropped");
        this.handle.setVoiceRoom(context, false);
        // Closing the inbox stops the coordinator (and its turn).
        const id = contextId(context);
        this.#contexts.get(id)?.inbox.close();
        this.#contexts.delete(id);
        break;
      }
      case "voice_speaking": {
        const { context, account, speaking } = event.data;
        if (!this.#isVoice(context) || this.isSelf(account)) break;
        const h = this.#contexts.get(contextId(context));
        if (h) {
          h.session.setSpeaking(account, speaking);
          h.inbox.push({ type: "speaking" });
        }
        break;
      }
      case "voice_utterance":
        if (this.#isVoice(event.data.context)) this.#onUtterance(event.data);
        break;
      case "voice_playback": {
        const { context, turn, state, text } = event.data;
        if (this.#isVoice(context)) this.#onPlayback(context, turn, state, text);
        break;
      }
      case "action_completed": {
        const { action, ok } = event.data;
        const session = this.#pendingActions.get(action);
        this.#pendingActions.delete(action);
        if (session && !ok) session.forgetAction(action);
        break;
      }
      case "module_state_changed":
        if (event.data.state === "running" && event.data.module === COMMANDS_MODULE) {
          this.commands.install(this.ctx.services, this.handle, this.persona);
        }
        break;
      case "agent_initiative": {
        const { context, reason, hint, about } = event.data;
        this.#onInitiative(context, { reason, hint, about: [...about] });
        break;
      }
      case "custom":
        if (event.data.topic === BUDGET_TOPIC) this.#onBudget(event.data.payload);
        break;
      default:
        break;
    }
  }

  /** The context's handle, creating the context (session and coordinator) if needed. */
  #context(key: ContextKey): ContextHandle {
    const id = contextId(key);
    let handle = this.#contexts.get(id);
    if (!handle) {
      const session = new Session(key, this.config.history_limit, this.ctx.clock);
      const inbox = new Inbox();
      const created: ContextHandle = { session, inbox };
      handle = created;
      this.#contexts.set(id, created);
      const coordinator = new Coordinator(this, key, session, inbox);
      this.ctx.spawn("context", (signal) => coordinator.run(signal));
    }
    return handle;
  }

  /** The context's handle if it exists (a stray signal must not bring a session back). */
  #existing(key: ContextKey): ContextHandle | undefined {
    return this.#contexts.get(contextId(key));
  }

  #onMessage(incoming: IncomingMessage): void {
    const msg = this.#voiceTextChat(incoming);
    if (this.isBlocked(msg.author.account)) {
      this.log.debug(
        { context: contextId(msg.id.context), account: msg.author.account.id },
        "ignoring blocked user",
      );
      return;
    }
    const isSelf = this.isSelf(msg.author.account);
    const ignored = isSelf || (msg.author.is_bot && !this.config.respond_to_bots);
    const cold = this.#existing(msg.id.context) === undefined;
    const handle = this.#context(msg.id.context);
    if (cold) startBackfill(this, handle.session, msg);
    handle.session.recordMessage(msg, isSelf);
    if (!ignored) handle.inbox.push({ type: "message", message: msg });
  }

  /**
   * Text typed in the chat of the voice channel she is in belongs to the voice conversation
   * (`voice.text_chat`): she answers it by speaking. On Discord a voice channel's text chat
   * has the channel's own id, so the voice context is the same channel with kind `voice`.
   */
  #voiceTextChat(msg: IncomingMessage): IncomingMessage {
    const context = msg.id.context;
    if (!this.config.voice.text_chat || context.kind !== "channel" || context.scope === null) {
      return msg;
    }
    const room = this.handle.voiceContext(context.platform, context.scope);
    if (room === null || room.channel !== context.channel) return msg;
    return { ...msg, id: { ...msg.id, context: room } };
  }

  #onVoiceMembers(context: ContextKey, members: readonly VoiceParticipant[]): void {
    this.handle.setVoiceRoom(context, true);
    for (const m of members) {
      if (m.is_self) this.#selfAccounts.set(accountId(m.account), m.account);
    }
    const others = members.filter((m) => !m.is_self);
    this.#context(context).session.setVoiceMembers(others);
  }

  #onUtterance(utterance: VoiceUtterance): void {
    if (
      utterance.text.trim() === "" ||
      this.isSelf(utterance.speaker.account) ||
      this.isBlocked(utterance.speaker.account)
    ) {
      return;
    }
    this.handle.setVoiceRoom(utterance.context, true);
    const msg = utteranceMessage(utterance);
    const ignored = msg.author.is_bot && !this.config.respond_to_bots;
    const handle = this.#context(utterance.context);
    handle.session.recordUtterance(msg);
    if (!ignored) handle.inbox.push({ type: "message", message: msg });
  }

  /** Her own speech enters history once it starts playing. */
  #onPlayback(context: ContextKey, turn: TurnId | null, state: PlaybackState, text: string): void {
    const h = this.#existing(context);
    if (!h) return;
    const name = this.persona.displayName();
    const me = this.selfAccount(context.platform);
    const now = this.ctx.clock.now();
    switch (state) {
      case "started":
        h.session.recordSpeech(name, me, text, turn, now);
        break;
      case "interrupted":
        h.session.recordInterruption(name, me, text, turn, now);
        break;
      case "finished":
        h.session.noteSelfSpoke(now);
        break;
      case "failed":
        break;
    }
    if (turn !== null) h.inbox.push({ type: "playback", turn, state });
  }

  #onInitiative(context: ContextKey, initiative: Initiative): void {
    const mode = this.handle.channelMode(context);
    if (mode === "off" || mode === "mention-only") {
      this.initiativeSkipped(context, initiative.reason, `mode ${mode}`);
      return;
    }
    const budget = this.handle.llmBudget();
    if (budget !== "ok") {
      this.initiativeSkipped(context, initiative.reason, `llm budget ${budget}`);
      return;
    }
    if (context.kind === "voice") {
      // Only where she is: a stray request must not create a session.
      const delivered =
        this.#existing(context)?.inbox.push({ type: "initiative", initiative }) ?? false;
      if (!delivered) {
        this.initiativeSkipped(context, initiative.reason, "not in this voice channel");
      }
      return;
    }
    this.#context(context).inbox.push({ type: "initiative", initiative });
  }

  /** Publishes the decision not to act on an initiative request. */
  initiativeSkipped(context: ContextKey, reason: string, why: string): void {
    this.log.debug({ context: contextId(context), reason, why }, "initiative skipped");
    const turn = newId();
    agentTurns.inc({ decision: "ignored" });
    this.ctx.publish(
      {
        type: "agent_decision",
        data: {
          turn,
          context,
          respond: false,
          score: 0,
          reasons: [`initiative:${reason}`, `skipped: ${why}`],
        },
      },
      { turn },
    );
  }

  #onBudget(payload: JsonValue): void {
    const raw = isJsonObject(payload) ? payload.state : undefined;
    if (typeof raw !== "string") {
      this.log.warn({ payload }, "llm.budget event without a state");
      return;
    }
    let state: ReturnType<typeof parseBudgetState>;
    try {
      state = parseBudgetState(raw);
    } catch (error) {
      this.log.warn({ error: errorMessage(error) }, "ignoring llm.budget event");
      return;
    }
    const before = this.handle.setLlmBudget(state);
    if (before !== state) this.log.info({ before, state }, "llm budget state changed");
    if (state !== "exhausted") this.#budgetNotices.clear();
  }

  /**
   * Whether she may say she is out of energy in `context` now; records it if so (at most once
   * per `budget_notice_interval_ms`).
   */
  takeBudgetNotice(context: ContextKey): boolean {
    const now = this.ctx.clock.now();
    const id = contextId(context);
    const last = this.#budgetNotices.get(id);
    if (last !== undefined && Math.max(now - last, 0) < this.config.budget_notice_interval_ms) {
      return false;
    }
    this.#budgetNotices.set(id, now);
    return true;
  }

  social(): SocialSignals | undefined {
    return this.ctx.services.get(SocialSignalsKey);
  }

  attitude(account: AccountRef): Attitude | null {
    return this.social()?.attitude(account) ?? null;
  }

  mood(): Mood | null {
    return this.ctx.services.get(MoodSignalsKey)?.mood() ?? null;
  }

  /** She ignores this person entirely (social module decision). */
  isBlocked(account: AccountRef): boolean {
    return this.attitude(account)?.blocked ?? false;
  }

  /**
   * Minimum time (ms) since she last spoke before she starts a conversation in `context`: the
   * attention cooldown scaled by activeness and energy.
   */
  ambientCooldownMs(context: ContextKey): number {
    const base =
      context.kind === "voice" ? this.config.voice.cooldown_ms : this.config.attention.cooldown_ms;
    const mood = this.mood();
    const energy = mood === null ? 1 : energyCooldownFactor(mood);
    const factor = cooldownFactor(this.handle.activeness(context)) * energy;
    return Math.trunc(base * factor);
  }

  isSelf(account: AccountRef): boolean {
    return this.#selfAccounts.has(accountId(account));
  }

  /** One of her accounts on `platform`, used to attribute her replies. */
  selfAccount(platform: PlatformId): AccountRef {
    const ids = [...this.#selfAccounts.values()]
      .filter((a) => a.platform === platform)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return ids[0] ?? { platform, id: "self" };
  }

  trackAction(action: ActionId, session: Session): void {
    this.#pendingActions.set(action, session);
  }

  untrackAction(action: ActionId): void {
    this.#pendingActions.delete(action);
  }

  /** Removes an idle context unless input is waiting for it. */
  retire(key: ContextKey, inbox: Inbox): boolean {
    if (!inbox.isEmpty) return false;
    const id = contextId(key);
    if (this.#contexts.get(id)?.inbox === inbox) this.#contexts.delete(id);
    inbox.close();
    return true;
  }

  #isVoice(context: ContextKey): boolean {
    if (context.kind === "voice") return true;
    this.log.debug({ context: contextId(context) }, "ignoring voice event for a non-voice context");
    return false;
  }
}

/** A voice utterance as turn input. Its `MessageRef` names the utterance, not a message. */
function utteranceMessage(u: VoiceUtterance): IncomingMessage {
  return {
    id: { context: u.context, id: u.id },
    author: u.speaker,
    text: u.text.trim(),
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: u.ended_at,
  };
}
