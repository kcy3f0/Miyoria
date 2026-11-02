// One turn: attention decision, prompt assembly (contributor sections and everything else
// derived from other people go into the user-role data message, see prompt.ts), generation
// (with the tool loop; tool calls run for the speaker as principal `user`) and output, filtered
// by `filterOutgoing`. Text replies think first and are sent once complete; voice replies do
// not think and are spoken sentence by sentence while the model is still generating.
//
// An initiative turn has no input and skips attention (the coordinator already checked the
// context is quiet). While the LLM budget is exhausted nothing is generated: a turn she would
// have answered gets a canned line at most once per context per `budget_notice_interval_ms`.

import { errorMessage, sleep } from "@miyoria/kernel";
import {
  assistantMessage,
  type ChatMessage,
  type ChatRequest,
  contextSession,
  type LlmRouter,
  LlmRouterKey,
  type StreamEvent,
  type ToolCall,
  type ToolSpec,
  toolResultMessage,
} from "@miyoria/llm";
import type { Tool, ToolContext } from "@miyoria/tools";
import {
  type AccountRef,
  type ActionSink,
  ActionSinkKey,
  AuthorizerKey,
  type ContextKey,
  contextKeyString as contextKeyDisplay,
  filterOutgoing,
  type IncomingMessage,
  type JsonValue,
  type LaneKey,
  newAction,
  type Participant,
  Principals,
  type Priority,
  PromptContributorsKey,
  type PromptRequest,
  type SocialSignals,
  safeName,
  sameAccount,
  type TurnId,
  textLane,
  timestampMs,
  toTimestamp,
  VoiceSinkKey,
  voiceLane,
} from "@miyoria/types";
import { assess, decide as sample, type VoiceAttention } from "./attention.js";
import type { AttentionConfig, ChannelMode } from "./config.js";
import { typingRefreshMs } from "./config.js";
import { gather } from "./contributors.js";
import type { TurnFlags } from "./coordinator.js";
import { Expression, ExpressionParser, type Segment } from "./expression.js";
import { voiceScope } from "./handle.js";
import { agentTurns } from "./metrics.js";
import {
  buildMessages,
  checkMessages,
  cleanReply,
  renderSections,
  situationData,
  situationPrompt,
  splitMessage,
  transcriptLine,
} from "./prompt.js";
import type { Agent, Initiative } from "./runtime.js";
import { type HistoryEntry, messageText, type Session } from "./session.js";
import { attitudeHint, type BudgetState, EXHAUSTED_LINE, moodHint } from "./signals.js";
import { isSpeakable, SentenceSplitter } from "./speech.js";
import { ReactTool } from "./tools.js";
import { contextId, fixed, guard, TimeoutError, timeout } from "./util.js";

const TYPING_TTL_MS = 10_000;
/** History lines shown to the `fast` model. */
const CHECK_HISTORY = 12;
/** History lines before the input sent to prompt contributors. */
const CONTRIBUTOR_HISTORY = 6;
/** People in the prompt request (text contexts) and with attitude hints. */
const MAX_PEOPLE = 10;
const MAX_ATTITUDE_HINTS = 5;

export class TurnError extends Error {
  override readonly name = "TurnError";
}

/**
 * Runs one turn and publishes `agent.turn.completed`. When `signal` aborts (the coordinator
 * cancelled the turn) it stops without publishing anything more.
 */
export async function runTurn(
  agent: Agent,
  key: ContextKey,
  session: Session,
  turn: TurnId,
  inputs: readonly IncomingMessage[],
  initiative: Initiative | null,
  flags: TurnFlags,
  signal: AbortSignal,
): Promise<void> {
  const t = new Turn(agent, key, session, turn, inputs, initiative, flags, signal);
  let text: string;
  try {
    text = await t.respond();
  } catch (error) {
    if (signal.aborted) return;
    agent.log.warn({ turn, context: contextId(key), error: errorMessage(error) }, "turn failed");
    text = "";
  }
  if (signal.aborted) return;
  agent.ctx.publish({ type: "agent_turn_completed", data: { turn, context: key, text } }, { turn });
}

/** What attention concluded (not yet published). */
interface Decision {
  respond: boolean;
  direct: boolean;
  score: number;
  reasons: string[];
}

/** Per-turn additions to the prompt. */
interface Extras {
  /** Her own state (mood): the situation (system) message. */
  notes: string[];
  /** Her attitude towards the people of the turn (names them): the data message. */
  people: string[];
  /** Rendered contributor sections (data blocks): the data message. */
  sections: string | null;
  /** For the decision trace. */
  reasons: string[];
}

/** One model response of the generation loop. */
interface Step {
  expression: Expression;
  /** Raw text as the model wrote it (tags included). */
  raw: string;
  calls: ToolCall[];
}

interface CheckReply {
  respond: boolean;
  reason: string;
}

/**
 * Streams a voice reply: every completed sentence is submitted as a `speak` action right away,
 * so the first one plays while the rest is generated.
 */
class Speech {
  readonly #splitter = new SentenceSplitter();
  /** Latest `<emo:...>`; sent with each sentence. */
  #emotion: string | null = null;
  /** Everything submitted so far. */
  spoken = "";

  constructor(
    readonly sink: ActionSink,
    readonly flags: TurnFlags,
    readonly names: readonly string[],
    readonly context: ContextKey,
    readonly turn: TurnId,
    readonly lane: LaneKey,
    readonly priority: Priority,
    readonly ttlMs: number,
    readonly signal: AbortSignal,
    /** Tells the voice sink a sentence is coming (`VoiceSink.prepare`). */
    readonly prepare: ((text: string) => void) | null = null,
  ) {}

  /** Her speech was interrupted: nothing more is said. */
  stopped(): boolean {
    return this.flags.interrupted;
  }

  async text(text: string): Promise<void> {
    for (const sentence of this.#splitter.push(text)) await this.#say(sentence);
  }

  /**
   * A new emotion applies from the next sentence on: a finished sentence that was still held
   * is said with the previous one first.
   */
  async emotion(emotion: string): Promise<void> {
    const done = this.#splitter.flushComplete();
    if (done !== null) await this.#say(done);
    this.#emotion = emotion;
  }

  /** Says the unfinished rest (end of a response, or a pause). */
  async flush(): Promise<void> {
    const rest = this.#splitter.flush();
    if (rest !== null) await this.#say(rest);
  }

  async #say(sentence: string): Promise<void> {
    if (this.stopped()) return;
    const text = filterOutgoing(cleanReply(sentence, this.names));
    if (!isSpeakable(text)) return;
    this.prepare?.(text);
    const action = newAction(
      this.lane,
      this.priority,
      { type: "speak", context: this.context, text, emotion: this.#emotion },
      { ttl: this.ttlMs, turn: this.turn },
    );
    try {
      await guard(this.sink.submit(action), this.signal);
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new TurnError(`submitting speech: ${errorMessage(error)}`, { cause: error });
    }
    this.flags.queued = true;
    this.spoken += text;
  }
}

/** Cuts `text` to `maxChars` characters (plus `…`). */
export function truncate(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : text;
}

export class CheckError extends Error {
  override readonly name = "CheckError";
}

/** Parses the `fast` model's `{"respond": bool, "reason": "..."}` reply. */
export function parseCheck(text: string): CheckReply {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || start >= end) {
    throw new CheckError("no JSON object in fast model reply");
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new CheckError(`invalid JSON from fast model: ${errorMessage(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CheckError("invalid JSON from fast model: expected an object");
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.respond !== "boolean") {
    throw new CheckError("invalid JSON from fast model: `respond` must be a boolean");
  }
  const reason = obj.reason ?? "";
  if (typeof reason !== "string") {
    throw new CheckError("invalid JSON from fast model: `reason` must be a string");
  }
  return { respond: obj.respond, reason };
}

/** Topic of latency measurements (the `voice` package's `LATENCY_TOPIC`). */
const VOICE_LATENCY_TOPIC = "voice.latency";

class Turn {
  /** A voice channel: the reply is spoken. */
  readonly voice: boolean;
  readonly social: SocialSignals | undefined;
  /** The first model response's latency was published (`voice.latency`, stage `llm`). */
  #latencyReported = false;

  constructor(
    readonly agent: Agent,
    readonly key: ContextKey,
    readonly session: Session,
    readonly turn: TurnId,
    readonly inputs: readonly IncomingMessage[],
    /** She starts the conversation on her own (`inputs` is empty). */
    readonly initiative: Initiative | null,
    readonly flags: TurnFlags,
    readonly signal: AbortSignal,
  ) {
    this.voice = key.kind === "voice";
    this.social = agent.social();
  }

  get #now(): number {
    return this.agent.ctx.clock.now();
  }

  #priority(direct: boolean): Priority {
    return direct ? "direct" : "initiative";
  }

  /** Returns the text she sent or said (empty if she stayed quiet). */
  async respond(): Promise<string> {
    const names = this.agent.persona.names();
    const budget = this.agent.handle.llmBudget();
    let decision: Decision;
    if (this.initiative !== null) {
      const reasons = [`initiative:${this.initiative.reason}`];
      const respond = budget === "ok";
      if (!respond) reasons.push(`skipped: llm budget ${budget}`);
      decision = { respond, direct: false, score: 0, reasons };
    } else {
      decision = await this.#decide(names, budget);
    }
    const { respond, direct, score, reasons } = decision;
    if (!respond) {
      this.#publishDecision(false, score, reasons);
      return "";
    }
    if (budget === "exhausted") {
      const notice = this.agent.takeBudgetNotice(this.key);
      reasons.push(
        notice
          ? "llm budget exhausted: out-of-energy line"
          : "llm budget exhausted: already told them, staying quiet",
      );
      this.#publishDecision(notice, score, reasons);
      return notice ? await this.#sayExhausted(direct) : "";
    }
    const extras = await this.#extras();
    reasons.push(...extras.reasons);
    this.#publishDecision(true, score, reasons);
    return await this.#generate(direct, names, extras);
  }

  #publishDecision(respond: boolean, score: number, reasons: string[]): void {
    this.signal.throwIfAborted();
    agentTurns.inc({ decision: respond ? "responded" : "ignored" });
    this.agent.ctx.publish(
      {
        type: "agent_decision",
        data: { turn: this.turn, context: this.key, respond, score, reasons },
      },
      { turn: this.turn },
    );
  }

  /**
   * Someone she ignores entirely (only their old lines can still be in history: new ones are
   * not recorded).
   */
  #hidden(entry: HistoryEntry): boolean {
    return !entry.isSelf && (this.social?.attitude(entry.account)?.blocked ?? false);
  }

  /**
   * Mean affinity of the turn's speakers (unknown people count as 0), if social signals are
   * available.
   */
  #speakerAffinity(): number | null {
    const social = this.social;
    if (!social) return null;
    const authors = this.#authors();
    if (authors.length === 0) return null;
    const sum = authors.reduce((acc, a) => acc + (social.attitude(a)?.affinity ?? 0), 0);
    return sum / authors.length;
  }

  /** Runs attention. */
  async #decide(names: readonly string[], budget: BudgetState): Promise<Decision> {
    const cfg = this.agent.config;
    const [interests, profileShare] = this.agent.persona.read(
      (p) => [p.manifest.interests, p.manifest.behavior.max_share_of_recent] as const,
    );
    const configured = this.agent.handle.channelMode(this.key);
    // Short on budget: no joining in, no fast-model checks.
    const mode: ChannelMode =
      budget !== "ok" && configured === "ambient" ? "mention-only" : configured;
    const activeness = this.agent.handle.activeness(this.key);
    const affinity = this.#speakerAffinity();
    const mood = this.agent.mood();
    const voiceCfg = cfg.voice;
    let attentionCfg: AttentionConfig;
    let maxShare: number;
    if (this.voice) {
      attentionCfg = {
        ...cfg.attention,
        cooldown_ms: voiceCfg.cooldown_ms,
        llm_check: voiceCfg.llm_check,
        gray_low: voiceCfg.gray_low,
      };
      maxShare = voiceCfg.max_share_of_recent;
    } else {
      attentionCfg = cfg.attention;
      maxShare = cfg.attention.max_share_of_recent ?? profileShare;
    }
    const voice: VoiceAttention | null = this.voice
      ? {
          someoneSpeaking: this.session.someoneSpeaking(),
          ambientFactor: voiceCfg.ambient_factor,
          questionWindowMs: voiceCfg.question_window_ms,
          interruptScale: voiceCfg.interrupt_scale,
        }
      : null;
    const assessment = assess({
      config: attentionCfg,
      mode,
      activeness,
      names,
      interests,
      maxShare,
      session: this.session,
      inputs: this.inputs,
      now: this.#now,
      voice,
      affinity,
      mood,
    });
    const reasons = assessment.reasons;
    if (mode !== configured) reasons.push(`llm budget ${budget}: as mention-only`);
    const scale = assessment.ambientScale;
    const ambient = (p: number): number => Math.min(Math.max(p * scale, 0), 1);
    let probability: number;
    switch (assessment.gate.kind) {
      case "ignore":
        probability = 0;
        break;
      case "sample":
        probability = assessment.gate.probability;
        break;
      case "ask_llm": {
        try {
          const reply = await this.#llmCheck();
          if (reply.respond) {
            reasons.push(`fast model: respond (${reply.reason})`);
            probability = ambient(cfg.attention.llm_yes_probability);
          } else {
            reasons.push(`fast model: stay quiet (${reply.reason})`);
            probability = 0;
          }
        } catch (error) {
          if (this.signal.aborted) throw error;
          reasons.push(`fast model check failed: ${errorMessage(error)}`);
          probability = ambient(assessment.score);
        }
        break;
      }
    }
    const [respond, roll] = sample(probability, this.agent.random);
    reasons.push(
      roll === null
        ? `p ${fixed(probability, 2)}`
        : `p ${fixed(probability, 2)}, roll ${fixed(roll, 2)}`,
    );
    return { respond, direct: assessment.direct, score: assessment.score, reasons };
  }

  /** Stable id of this conversation for the LLM provider (routing, prompt caching). */
  #llmSession(): string {
    const profile = this.agent.persona.read((p) => p.id);
    return contextSession(profile, this.key);
  }

  async #llmCheck(): Promise<CheckReply> {
    const router = this.agent.ctx.services.require(LlmRouterKey);
    const name = this.agent.persona.displayName();
    const messages = checkMessages(
      name,
      this.session.recent(CHECK_HISTORY).filter((e) => !this.#hidden(e)),
    );
    const request: ChatRequest = {
      messages,
      temperature: 0,
      max_tokens: 1000, // reasoning models spend part of this on thinking
      json_mode: true,
      session: `${this.#llmSession()}-attention`,
    };
    // The voice gray-zone check is on the reply's critical path: no thinking. Text checks use
    // `[llm.thinking]` for the purpose.
    if (this.voice) request.thinking = false;
    const response = await timeout(
      this.agent.config.attention.llm_check_timeout_ms,
      this.signal,
      (signal) => router.complete("fast", request, signal),
    );
    return parseCheck(response.text);
  }

  /** The name she knows `account` by in this turn. */
  #nameOf(account: AccountRef): string | null {
    const input = this.inputs.find((m) => sameAccount(m.author.account, account));
    if (input) return input.author.display_name;
    const member = this.session.voiceMembers().find((m) => sameAccount(m.account, account));
    if (member) return member.display_name;
    const seen = this.session.participants().find((p) => sameAccount(p.account, account));
    return seen ? seen.displayName : null;
  }

  /**
   * The people this turn is about: its speakers, or for an initiative the accounts its hint is
   * about.
   */
  #focus(): AccountRef[] {
    const out = [...this.#authors()];
    for (const account of this.initiative?.about ?? []) {
      if (!out.some((a) => sameAccount(a, account))) out.push(account);
    }
    return out;
  }

  /** Mood and attitude lines, plus the sections of prompt contributors. */
  async #extras(): Promise<Extras> {
    const extras: Extras = { notes: [], people: [], sections: null, reasons: [] };
    const mood = this.agent.mood();
    if (mood !== null) extras.notes.push(moodHint(mood));
    const focus = this.#focus();
    const social = this.social;
    if (social) {
      const hints: string[] = [];
      for (const account of focus) {
        if (hints.length >= MAX_ATTITUDE_HINTS) break;
        const attitude = social.attitude(account);
        if (!attitude) continue;
        const name = this.#nameOf(account);
        if (name === null) continue;
        hints.push(attitudeHint(safeName(name), attitude));
      }
      extras.people.push(...hints);
    }
    const registry = this.agent.ctx.services.get(PromptContributorsKey);
    if (!registry || registry.all().length === 0) return extras;
    const request = this.#promptRequest(focus);
    const cfg = this.agent.config;
    const gathered = await gather(registry, request, cfg.contributor_timeout_ms, this.signal);
    extras.reasons = gathered.reasons();
    extras.sections = renderSections(gathered.sections, cfg.max_context_chars);
    return extras;
  }

  /** What prompt contributors get to see of this turn. */
  #promptRequest(speakers: AccountRef[]): PromptRequest {
    const her = this.agent.persona.displayName();
    const profile = this.agent.persona.read((p) => p.id);
    const person = (account: AccountRef) => this.social?.attitude(account)?.person ?? null;
    const members = this.session.voiceMembers();
    const participants: Participant[] =
      this.voice && members.length > 0
        ? members.map((m) => ({
            account: m.account,
            display_name: m.display_name,
            person: person(m.account),
          }))
        : this.session
            .participants()
            .slice(0, MAX_PEOPLE)
            .map((p) => ({
              account: p.account,
              display_name: p.displayName,
              person: person(p.account),
            }));
    // Speakers are always among the participants.
    for (const account of speakers) {
      if (participants.some((p) => sameAccount(p.account, account))) continue;
      const name = this.#nameOf(account);
      if (name !== null) {
        participants.push({ account, display_name: name, person: person(account) });
      }
    }
    const shownSpeakers = speakers.filter((a) =>
      participants.some((p) => sameAccount(p.account, a)),
    );
    const query =
      this.initiative !== null
        ? this.initiative.hint.trim()
        : this.inputs.map((m) => `${m.author.display_name}: ${messageText(m)}`).join("\n");
    const firstInput =
      this.inputs.length === 0 ? null : Math.min(...this.inputs.map((m) => timestampMs(m.ts)));
    const before = this.session
      .history()
      .filter((e) => (firstInput === null || e.ts < firstInput) && !this.#hidden(e));
    const recent = before
      .slice(Math.max(before.length - CONTRIBUTOR_HISTORY, 0))
      .map((e) => transcriptLine(e, her));
    return {
      profile,
      turn: this.turn,
      context: this.key,
      participants,
      speakers: shownSpeakers,
      query,
      recent,
      voice: this.voice,
      now: toTimestamp(this.#now),
    };
  }

  async #generate(direct: boolean, names: readonly string[], extras: Extras): Promise<string> {
    const cfg = this.agent.config;
    const services = this.agent.ctx.services;
    const router = services.require(LlmRouterKey);
    const sink = services.require(ActionSinkKey);

    const persona = this.agent.persona.personaPrompt();
    const members = this.session.voiceMembers();
    const present =
      this.voice && members.length > 0
        ? members.map((m) => m.display_name)
        : this.session
            .participants()
            .slice(0, MAX_PEOPLE)
            .map((p) => p.displayName);
    const situation = situationPrompt(
      {
        context: this.key,
        direct,
        initiative: this.initiative?.hint ?? null,
        notes: extras.notes,
      },
      new Date(this.#now),
    );
    const data = situationData({
      voice: this.voice,
      present,
      people: extras.people,
      initiative:
        this.initiative === null
          ? null
          : { reason: this.initiative.reason, hint: this.initiative.hint },
      sections: extras.sections,
    });
    const messages = buildMessages(
      persona,
      situation,
      this.session.recent(cfg.prompt_history).filter((e) => !this.#hidden(e)),
      data,
    );

    const priority = this.#priority(direct);
    if (this.voice) {
      const [platform, scope] = voiceScope(this.key);
      const voiceSink = this.agent.ctx.services.get(VoiceSinkKey);
      const speech = new Speech(
        sink,
        this.flags,
        names,
        this.key,
        this.turn,
        voiceLane(platform, scope),
        priority,
        cfg.voice.speak_ttl_ms,
        this.signal,
        voiceSink?.prepare ? (text) => voiceSink.prepare?.(this.key, text) : null,
      );
      await this.#produce(router, messages, priority, speech);
      if (speech.spoken === "") this.agent.log.debug({ turn: this.turn }, "she stayed quiet");
      return speech.spoken;
    }

    const lane = textLane(this.key);
    // Typing is refreshed until the reply is ready; cancelling the turn stops it too.
    const typing = new AbortController();
    const stopTyping = () => typing.abort();
    this.signal.addEventListener("abort", stopTyping, { once: true });
    const typingLoop = this.#keepTyping(sink, lane, priority, typing.signal);
    let expression: Expression;
    try {
      expression = await this.#produce(router, messages, priority, null);
    } finally {
      typing.abort();
      this.signal.removeEventListener("abort", stopTyping);
      await typingLoop;
    }
    if (expression.isSilent()) {
      this.agent.log.debug({ turn: this.turn }, "she chose silence");
      return "";
    }
    const text = filterOutgoing(cleanReply(expression.text, names));
    if (text === "") return "";
    return await this.#sendText(sink, text, direct, priority);
  }

  /** Sends `text` (split into several messages if long) as her reply. */
  async #sendText(
    sink: ActionSink,
    text: string,
    direct: boolean,
    priority: Priority,
  ): Promise<string> {
    const cfg = this.agent.config;
    const lane = textLane(this.key);
    const replyTo =
      cfg.reply_reference && direct && this.key.kind !== "dm"
        ? (this.inputs.at(-1)?.id ?? null)
        : null;
    const displayName = this.agent.persona.displayName();
    const me = this.agent.selfAccount(this.key.platform);
    this.signal.throwIfAborted();
    this.flags.committed = true;
    const chunks = splitMessage(text, cfg.max_message_chars);
    for (const [i, chunk] of chunks.entries()) {
      const action = newAction(
        lane,
        priority,
        {
          type: "send_message",
          context: this.key,
          message: { text: chunk, reply_to: i === 0 ? replyTo : null },
        },
        { ttl: cfg.reply_ttl_ms, turn: this.turn },
      );
      const id = action.id;
      this.session.recordOwn(displayName, me, chunk, id, this.#now);
      this.agent.trackAction(id, this.session);
      try {
        await guard(sink.submit(action), this.signal);
      } catch (error) {
        this.agent.untrackAction(id);
        this.session.forgetAction(id);
        if (this.signal.aborted) throw error;
        throw new TurnError(`submitting reply: ${errorMessage(error)}`, { cause: error });
      }
    }
    return text;
  }

  /** Budget exhausted: says (or writes) the constant out-of-energy line. */
  async #sayExhausted(direct: boolean): Promise<string> {
    const sink = this.agent.ctx.services.require(ActionSinkKey);
    const priority = this.#priority(direct);
    if (!this.voice) return await this.#sendText(sink, EXHAUSTED_LINE, direct, priority);
    const [platform, scope] = voiceScope(this.key);
    const action = newAction(
      voiceLane(platform, scope),
      priority,
      { type: "speak", context: this.key, text: EXHAUSTED_LINE, emotion: "tired" },
      { ttl: this.agent.config.voice.speak_ttl_ms, turn: this.turn },
    );
    try {
      await guard(sink.submit(action), this.signal);
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new TurnError(`submitting speech: ${errorMessage(error)}`, { cause: error });
    }
    return EXHAUSTED_LINE;
  }

  /** Submits a typing indicator every `typing_refresh_ms` until `signal` aborts. */
  async #keepTyping(
    sink: ActionSink,
    lane: LaneKey,
    priority: Priority,
    signal: AbortSignal,
  ): Promise<void> {
    const refresh = typingRefreshMs(this.agent.config);
    while (!signal.aborted) {
      const typing = newAction(
        lane,
        priority,
        { type: "typing", context: this.key },
        {
          ttl: TYPING_TTL_MS,
          turn: this.turn,
          coalesce_key: `typing:${contextKeyDisplay(this.key)}`,
        },
      );
      try {
        await sink.submit(typing);
      } catch (error) {
        this.agent.log.warn({ error: errorMessage(error) }, "could not submit typing action");
      }
      try {
        await sleep(refresh, signal);
      } catch {
        return;
      }
    }
  }

  /**
   * Runs the model, executing tool calls for up to `max_tool_steps` rounds, and returns the
   * reply to send.
   *
   * Text written alongside tool calls is kept in the conversation sent back to the model but
   * only used as the reply if the final response has none, so it is never sent twice. With
   * `speech` (voice), all text is spoken as it streams in, including text written alongside
   * tool calls.
   */
  async #produce(
    router: LlmRouter,
    initial: ChatMessage[],
    priority: Priority,
    speech: Speech | null,
  ): Promise<Expression> {
    const cfg = this.agent.config;
    const toolsEnabled = cfg.tools_enabled && this.inputs.length > 0;
    const messages = [...initial];
    let earlier: Expression | null = null;
    for (let step = 0; step <= cfg.max_tool_steps; step++) {
      const tools = toolsEnabled ? this.#toolSpecs() : [];
      const offered = tools.length > 0;
      const request: ChatRequest = {
        messages: [...messages],
        tools,
        temperature: cfg.temperature,
        max_tokens: cfg.max_tokens,
        // Text replies may think first; spoken ones must start talking right away.
        thinking: !this.voice,
        session: this.#llmSession(),
      };
      const { expression, raw, calls } = await this.#streamStep(router, request, speech);
      if (speech?.stopped()) {
        this.agent.log.debug({ turn: this.turn }, "speech interrupted, generation stopped");
        return expression;
      }
      if (calls.length === 0 || !offered || step === cfg.max_tool_steps) {
        if (calls.length > 0) {
          this.agent.log.warn(
            { turn: this.turn, offered },
            "ignoring tool calls (disabled or step limit reached)",
          );
        }
        return earlier !== null && expression.isSilent() ? earlier : expression;
      }
      if (!expression.isSilent()) earlier = expression;
      messages.push(assistantMessage(raw, calls));
      for (const call of calls) {
        const result = await this.#runTool(call, priority);
        messages.push(toolResultMessage(call.id, result));
      }
    }
    return earlier ?? new Expression();
  }

  /**
   * Streams one model response, publishing emotions as they arrive (and speaking its
   * sentences, with `speech`).
   */
  async #streamStep(router: LlmRouter, request: ChatRequest, speech: Speech | null): Promise<Step> {
    const offeredTools = (request.tools?.length ?? 0) > 0;
    const stream = await guard(router.stream("chat", request, this.signal), this.signal);
    const iterator = stream[Symbol.asyncIterator]();
    const parser = new ExpressionParser();
    const expression = new Expression();
    let raw = "";
    const calls: ToolCall[] = [];
    let finished = false;
    try {
      for (;;) {
        const next: IteratorResult<StreamEvent> = await guard(iterator.next(), this.signal);
        if (next.done) {
          finished = true;
          break;
        }
        const event = next.value;
        if (event.type === "text_delta") {
          raw += event.text;
          for (const segment of parser.push(event.text)) {
            await this.#take(expression, segment, speech);
          }
          // With tools on offer, calls may still follow the silence.
          if (expression.silence && !offeredTools) break;
          if (speech?.stopped()) break;
        } else if (event.type === "reasoning_delta") {
          this.agent.log.debug({ turn: this.turn, reasoning: event.text }, "reasoning");
        } else if (event.type === "tool_call_delta") {
          while (calls.length <= event.index) calls.push({ id: "", name: "", arguments: "" });
          const call = calls[event.index] as ToolCall;
          if (event.id !== null) call.id = event.id;
          if (event.name !== null) call.name += event.name;
          call.arguments += event.arguments;
        } else {
          break;
        }
      }
    } finally {
      if (!finished) {
        // Like dropping the Rust stream; never wait for a provider that ignores aborts.
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      }
    }
    this.#reportLatency(stream.model, stream.firstTokenMs);
    for (const segment of parser.finish()) await this.#take(expression, segment, speech);
    if (speech) await speech.flush();
    const named = calls.filter((c) => c.name !== "");
    named.forEach((call, i) => {
      if (call.id === "") call.id = `call_${i}`;
    });
    return { expression, raw, calls: named };
  }

  /**
   * Publishes the first token latency of the turn's first model response in a voice channel
   * (`voice.latency`, stage `llm`; the panel's voice monitor shows it).
   */
  #reportLatency(model: string, firstTokenMs: number | null): void {
    if (!this.voice || this.#latencyReported || firstTokenMs === null) return;
    this.#latencyReported = true;
    this.agent.ctx.publish(
      {
        type: "custom",
        data: {
          topic: VOICE_LATENCY_TOPIC,
          payload: {
            stage: "llm",
            context: contextJson(this.key),
            turn: this.turn,
            model,
            first_token_ms: Math.round(firstTokenMs),
          },
        },
      },
      { turn: this.turn },
    );
  }

  /** Distinct authors of the turn's messages; a tool permission must be granted to all. */
  #authors(): AccountRef[] {
    const out: AccountRef[] = [];
    for (const m of this.inputs) {
      if (!out.some((a) => sameAccount(a, m.author.account))) out.push(m.author.account);
    }
    return out;
  }

  /** Runs one tool call; the result (or error) is a short text for the model. */
  async #runTool(call: ToolCall, priority: Priority): Promise<string> {
    const [ok, full] = await this.#tryTool(call, priority);
    const result = truncate(full, this.agent.config.max_tool_result_chars);
    this.agent.log.debug({ turn: this.turn, tool: call.name, ok, result }, "tool call");
    this.signal.throwIfAborted();
    this.agent.ctx.publish(
      {
        type: "custom",
        data: {
          topic: "agent.tool",
          payload: {
            turn: this.turn,
            context: contextJson(this.key),
            tool: call.name,
            ok,
            result,
          },
        },
      },
      { turn: this.turn },
    );
    return result;
  }

  /** The tools offered in this context (`react` makes no sense in voice). */
  #offers(name: string): boolean {
    return !(this.voice && name === ReactTool.NAME);
  }

  #toolSpecs(): ToolSpec[] {
    return this.agent.tools.specs().filter((t) => this.#offers(t.name));
  }

  #tool(name: string): Tool | undefined {
    return this.#offers(name) ? this.agent.tools.get(name) : undefined;
  }

  async #tryTool(call: ToolCall, priority: Priority): Promise<[boolean, string]> {
    const tool = this.#tool(call.name);
    if (!tool) return [false, `error: unknown tool \`${call.name}\``];
    const node = tool.permission ?? null;
    if (node !== null) {
      const authorizer = this.agent.ctx.services.get(AuthorizerKey);
      const allowed =
        authorizer !== undefined && this.#authors().every((a) => authorizer.allows(a, node));
      if (!allowed) {
        return [false, "error: permission denied (the user who asked may not use this tool)"];
      }
    }
    let args: JsonValue;
    if (call.arguments.trim() === "") {
      args = {};
    } else {
      try {
        args = JSON.parse(call.arguments) as JsonValue;
      } catch (error) {
        return [false, `error: arguments are not valid JSON: ${errorMessage(error)}`];
      }
    }
    const last = this.inputs.at(-1);
    if (!last) return [false, "error: no triggering message"];
    try {
      const out = await timeout(this.agent.config.tool_timeout_ms, this.signal, (signal) => {
        const ctx: ToolContext = {
          turn: this.turn,
          context: this.key,
          account: last.author.account,
          // The person she is answering asked: a request she may decline (see the gate).
          principal: Principals.user(last.author.account, this.key),
          message: last.id,
          priority,
          signal,
        };
        return tool.call(ctx, args);
      });
      return [true, out];
    } catch (error) {
      if (this.signal.aborted) throw error;
      if (error instanceof TimeoutError) return [false, "error: timed out"];
      return [false, `error: ${errorMessage(error)}`];
    }
  }

  /**
   * Folds a segment into `expression`; with `speech`, also speaks text and tracks the emotion
   * for the next sentence (nothing after a silence).
   */
  async #take(expression: Expression, segment: Segment, speech: Speech | null): Promise<void> {
    const out = expression.silence ? null : speech;
    if (out === null) {
      this.#apply(expression, segment);
      return;
    }
    switch (segment.type) {
      case "text":
        this.#apply(expression, segment);
        await out.text(segment.text);
        return;
      case "emotion":
        await out.emotion(segment.emotion);
        break;
      case "pause":
        await out.flush();
        break;
      case "silence":
        break;
    }
    this.#apply(expression, segment);
  }

  #apply(expression: Expression, segment: Segment): void {
    if (segment.type === "emotion" && !expression.silence) {
      this.signal.throwIfAborted();
      this.agent.ctx.publish(
        {
          type: "custom",
          data: {
            topic: "agent.emotion",
            payload: {
              turn: this.turn,
              context: contextJson(this.key),
              emotion: segment.emotion,
              ...(segment.intensity === undefined ? {} : { intensity: segment.intensity }),
            },
          },
        },
        { turn: this.turn },
      );
    }
    expression.apply(segment);
  }
}

/** The context as a JSON object (event payloads). */
function contextJson(key: ContextKey): JsonValue {
  return { platform: key.platform, scope: key.scope, channel: key.channel, kind: key.kind };
}
