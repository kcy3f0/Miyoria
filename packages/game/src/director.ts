// The director: one game session at a time, a decision every `decide_secs` (sooner on important
// events), goal tracking, queue goals, commentary and mood nudges.

import { type ActuatorRegistry, deniedText, GatedToolsKey } from "@miyoria/actions";
import { errorMessage, getLogger, type ModuleContext, sleep, withTimeout } from "@miyoria/kernel";
import { type ChatRequest, type LlmRouter, LlmRouterKey, sessionId } from "@miyoria/llm";
import { RequestQueueKey } from "@miyoria/queue";
import { type ToolContext, type ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  ActivityManagerKey,
  ARBITER_IMPULSE_TOPIC,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  customEvent,
  type Envelope,
  type JsonObject,
  type JsonValue,
  newId,
  newImpulse,
  Principals,
  serviceKey,
  type TaskFailureCode,
  type Timestamp,
  toTimestamp,
  v2Event,
} from "@miyoria/types";
import { GAME_ACT } from "./actions.js";
import type { GameConfig } from "./config.js";
import {
  ActionCall,
  type Decision,
  type GoalFacts,
  type GoalSource,
  goalLocked,
  goalNote,
  judge,
  type MoodNudge,
  type PromptParts,
  parseDecision,
  prompts,
  splitObservation,
  type Verdict,
  verdictDebug,
} from "./decision.js";
import {
  activeGuard,
  afterSuccess,
  type FailureGuard,
  guardAfter,
  guardNote,
  withheld,
} from "./guard.js";

const log = getLogger("game");

/** Topic of the director's decision traces (for the panel / overlay). */
export const DECISION_TOPIC = "game.director.decision";
/** Initiative reason of commentary requests. */
export const INITIATIVE_REASON = "game";
/**
 * Topic of session changes, `{state: "started" | "stopped", game, game_name, context}` (the
 * stage's scene director switches to the game scene and back on it). A session that ended by
 * itself also carries `code` (`disconnected`, `crashed`) and `reason`; the ActivityManager turns
 * that into `failed(code)`.
 */
export const SESSION_TOPIC = "game.director.session";

/** Where the adapter's raw tools are: the gated registry first, then the app's (old hosts). */
export type AdapterTools = Pick<ToolRegistry, "get">;

/** The adapter tools as `services` has them now. */
export function adapterTools(services: ModuleContext["services"]): AdapterTools | null {
  const gated = services.get(GatedToolsKey);
  const tools = services.get(ToolRegistryKey);
  if (!gated && !tools) return null;
  return { get: (name) => gated?.get(name) ?? tools?.get(name) };
}

/** Whether in-game chat of a game is its own conversation (then the director only notes it). */
export interface ChatHandled {
  handles(game: string): boolean;
}

/** Provided by module `game.chat`. */
export const GameChatKey = serviceKey<ChatHandled>("GameChat");

/** What `Director.preflight` found out about the game before a session starts. */
export interface Preflight {
  /** The adapter reaches the game but she is not in a world yet (main menu, loading). */
  inMenu: boolean;
}

/** Persona bits used in the decision prompt. */
export interface Persona {
  /** Profile id (for the LLM session id). */
  profile: string;
  name: string;
  text: string;
}

/** Where `game start` sends commentary. */
export type Placement =
  /** Her voice channel, else the stream context, else where the command ran. */
  "auto" | "voice" | "here" | "stream";

/** Current goal as shown by `game status` and the prompt section. */
export interface GoalView {
  text: string;
  /** `(觀眾 Owen 的請求)`, empty for her own goals. */
  note: string;
  age_secs: number;
  action: string | null;
  /** Request queue item id for viewer goals. */
  queue_item: number | null;
}

/** Snapshot of the running session (serialized like the Rust struct). */
export interface GameStatus {
  game: string;
  game_name: string;
  context: ContextKey;
  started_at: Timestamp;
  goal: GoalView | null;
  backlog: string[];
  summary: string;
  busy: boolean | null;
  last_action: string | null;
  recent: string[];
}

/** Shared slot the director writes its status to (read by commands and the prompt section). */
export class View {
  current: GameStatus | null = null;
}

/** A refused control request; the message is user-facing (zh-TW). */
export class GameError extends Error {
  override readonly name = "GameError";
}

interface Goal {
  text: string;
  source: GoalSource;
  setAt: number;
  action: ActionCall | null;
  issuedAt: number | null;
  attempts: number;
}

function newGoal(text: string, source: GoalSource, now: number): Goal {
  return { text, source, setAt: now, action: null, issuedAt: null, attempts: 0 };
}

function goalLabel(goal: Goal): string {
  return `${goal.text}${goalNote(goal.source)}`;
}

interface QueuedGoal {
  item: number;
  text: string;
  requester: string;
}

interface Trigger {
  text: string[];
  important: boolean;
}

type Outcome = { type: "reached" } | { type: "failed"; why: string };

interface Session {
  generation: number;
  game: string;
  gameName: string;
  context: ContextKey;
  /** How `context` was chosen; `auto` follows her into a voice channel she joins later. */
  placement: Placement;
  /** Where the session was started from. */
  here: ContextKey;
  starter: AccountRef;
  startedAt: number;
  goal: Goal | null;
  backlog: QueuedGoal[];
  recent: string[];
  summary: string;
  busy: boolean | null;
  lastAction: string | null;
  nextDecide: number;
  decideStarted: number | null;
  trigger: Trigger | null;
  lastComment: number | null;
  /** Low-level actions withheld after a failure (see guard.ts). */
  guard: FailureGuard | null;
}

const observeTool = (s: Session): string => `game_${s.game}_observe`;
const actTool = (s: Session): string => `game_${s.game}_act`;

function toolCtx(s: Session, signal: AbortSignal): ToolContext {
  return {
    turn: newId(),
    context: s.context,
    account: s.starter,
    principal: Principals.director(s.context),
    message: { context: s.context, id: "game" },
    priority: "initiative",
    signal,
  };
}

/**
 * Runs an adapter action through the gate (`game.act`, principal `director`); a refusal or
 * failure throws, like a failing tool.
 */
async function actThroughGate(
  actuators: ActuatorRegistry,
  s: Session,
  call: JsonObject,
  signal: AbortSignal,
): Promise<string> {
  const outcome = await actuators.invoke(
    {
      principal: Principals.director(s.context),
      capability: GAME_ACT,
      args: { game: s.game, call },
      why: null,
      turn: null,
    },
    { signal },
  );
  switch (outcome.status) {
    case "done":
      return outcome.result.text;
    case "denied":
      throw new Error(`the gate refused: ${outcome.decision.reason}`);
    case "failed":
      throw new Error(outcome.error);
  }
}

/** `anyhow::Result<T>` stand-in for background steps. */
type Res<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(fn: () => Promise<T>): Promise<Res<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Result of a background step. */
type Done =
  | {
      type: "decided";
      generation: number;
      trigger: Trigger;
      observation: Res<string>;
      decision: Res<Decision> | null;
    }
  | {
      type: "acted";
      generation: number;
      action: ActionCall;
      verdict: Verdict;
      goal: string | null;
      result: Res<string>;
    };

type Work = (signal: AbortSignal) => Promise<Done>;

function firstLine(s: string, max: number): string {
  const line = s.split("\n")[0]?.replace(/\r$/, "") ?? "";
  const chars = [...line];
  const out = chars.slice(0, max).join("");
  return chars.length > max ? `${out}…` : out;
}

/** `"在 Minecraft 裡做一個高階動作"` → `Minecraft`; else the capitalized id. */
function gameName(actDescription: string | null, id: string): string {
  if (actDescription?.startsWith("在 ")) {
    const rest = actDescription.slice("在 ".length);
    const at = rest.indexOf(" 裡");
    if (at >= 0) {
      const name = rest.slice(0, at).trim();
      if (name !== "") return name;
    }
  }
  const chars = [...id];
  const first = chars.shift();
  return first === undefined ? "" : first.toUpperCase() + chars.join("");
}

async function callTool(
  tools: AdapterTools,
  name: string,
  ctx: ToolContext,
  args: JsonValue,
  timeoutMs: number,
): Promise<string> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool \`${name}\` is not registered`);
  // Giving up aborts the call too (the extension is told to cancel it).
  const timeout = new AbortController();
  const running = tool.call(
    { ...ctx, signal: AbortSignal.any([ctx.signal, timeout.signal]) },
    args,
  );
  running.catch(() => undefined);
  const result = await withTimeout(running, timeoutMs);
  if (result === undefined) {
    timeout.abort(new Error(`tool \`${name}\` timed out`));
    throw new Error(`tool \`${name}\` timed out`);
  }
  return result;
}

/** Everything a decision needs, owned so it can run in the background. */
interface DecideInput {
  generation: number;
  trigger: Trigger;
  cfg: GameConfig;
  tools: AdapterTools;
  router: LlmRouter | undefined;
  toolCtx: ToolContext;
  observeTool: string;
  actTool: string;
  persona: Persona;
  /** Game adapter id. */
  game: string;
  gameName: string;
  goal: string | null;
  lastAction: string | null;
  backlog: string[];
  recent: string[];
  /** The failure guard's prompt line, if it is on. */
  withheld: string | null;
}

async function decide(input: DecideInput): Promise<Done> {
  const observation = await attempt(() =>
    callTool(input.tools, input.observeTool, input.toolCtx, {}, input.cfg.tool_timeout_secs * 1000),
  );
  const decision = observation.ok ? await decideFrom(input, observation.value) : null;
  return {
    type: "decided",
    generation: input.generation,
    trigger: input.trigger,
    observation,
    decision,
  };
}

/** Asks the model, unless the game is not playable right now. */
async function decideFrom(input: DecideInput, observation: string): Promise<Res<Decision> | null> {
  const { state } = splitObservation(observation);
  if (state && (state.connected === false || state.in_game === false)) return null;
  return attempt(() => ask(input, observation));
}

async function ask(input: DecideInput, observation: string): Promise<Decision> {
  const cfg = input.cfg;
  const act = input.tools.get(input.actTool);
  if (!act) throw new Error(`tool \`${input.actTool}\` is not registered`);
  if (!input.router) throw new Error("no LLM router");
  const trigger = input.trigger.text.length === 0 ? "定時檢查" : input.trigger.text.join(";");
  const parts: PromptParts = {
    name: input.persona.name,
    persona: input.persona.text,
    game: input.gameName,
    actDescription: act.spec.description,
    actParameters: act.spec.parameters,
    trigger,
    goal: input.goal,
    lastAction: input.lastAction,
    backlog: input.backlog,
    recent: input.recent,
    observation,
    withheld: input.withheld,
  };
  const { system, user } = prompts(parts);
  const request: ChatRequest = {
    messages: [
      { role: "system", content: system, name: null, tool_calls: [], tool_call_id: null },
      { role: "user", content: user, name: null, tool_calls: [], tool_call_id: null },
    ],
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
    json_mode: true,
    session: sessionId(input.persona.profile, `game-${input.game}`),
  };
  const response = await withTimeout(
    input.router.complete(cfg.purpose, request, input.toolCtx.signal),
    cfg.llm_timeout_secs * 1000,
  );
  if (response === undefined) throw new Error("the decision timed out");
  return parseDecision(response.text);
}

/**
 * Drives one game session at a time. All methods run to completion without awaiting, so they
 * never interleave; background steps (observe / ask / act) report back through `#onDone`.
 */
export class Director {
  readonly #cfg: GameConfig;
  readonly #ctx: ModuleContext;
  readonly #persona: Persona;
  readonly #view: View;
  readonly #actuators: ActuatorRegistry;
  #voices: ContextKey[] = [];
  #session: Session | null = null;
  #generation = 0;
  /** The running background step, if any (aborted when a session starts or stops). */
  #work: AbortController | null = null;
  /** A goal set while the game was still starting (applied when the session starts). */
  #pendingGoal: { text: string; by: string } | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(
    cfg: GameConfig,
    ctx: ModuleContext,
    persona: Persona,
    view: View,
    /** Where its adapter actions go (`game.act`, through the gate). */
    actuators: ActuatorRegistry,
  ) {
    this.#cfg = cfg;
    this.#ctx = ctx;
    this.#persona = persona;
    this.#view = view;
    this.#actuators = actuators;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Stops all background activity (module stop). */
  close(): void {
    if (!this.#closed && this.#session) {
      try {
        this.#publishSession("stopped", this.#session);
      } catch (error) {
        log.debug({ err: errorMessage(error) }, "cannot publish the session end");
      }
    }
    this.#closed = true;
    this.#work?.abort();
    this.#work = null;
    this.#disarm();
  }

  #now(): number {
    return this.#ctx.clock.now();
  }

  #secs(s: number): number {
    return s * 1000;
  }

  #disarm(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** (Re)arms the decision timer: only while a session runs and no step is in flight. */
  #arm(): void {
    this.#disarm();
    const s = this.#session;
    if (this.#closed || !s || this.#work) return;
    const delay = Math.max(s.nextDecide - this.#now(), 0);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const work = this.#startDecide();
      if (work) this.#run(work);
      this.#arm();
    }, delay);
  }

  #run(work: Work): void {
    const controller = new AbortController();
    this.#work = controller;
    void work(controller.signal).then(
      (done) => {
        if (this.#work !== controller) return;
        this.#work = null;
        try {
          const next = this.#onDone(done);
          if (next) this.#run(next);
        } catch (error) {
          log.error({ err: error }, "game director step failed");
        }
        this.#arm();
      },
      (error: unknown) => {
        if (this.#work !== controller) return;
        this.#work = null;
        log.error({ err: error }, "game director step failed");
        this.#arm();
      },
    );
  }

  #cancelWork(): void {
    this.#work?.abort();
    this.#work = null;
  }

  #refreshView(): void {
    const s = this.#session;
    if (!s) {
      this.#view.current = null;
      return;
    }
    const now = this.#now();
    this.#view.current = {
      game: s.game,
      game_name: s.gameName,
      context: s.context,
      started_at: toTimestamp(s.startedAt),
      goal: s.goal
        ? {
            text: s.goal.text,
            note: goalNote(s.goal.source),
            age_secs: Math.floor(Math.max(now - s.goal.setAt, 0) / 1000),
            action: s.goal.action ? s.goal.action.display() : null,
            queue_item: s.goal.source.type === "queue" ? s.goal.source.item : null,
          }
        : null,
      backlog: s.backlog.map((q) => `#${q.item} ${q.text}(${q.requester})`),
      summary: s.summary,
      busy: s.busy,
      last_action: s.lastAction,
      recent: [...s.recent],
    };
  }

  // ----- commands -----

  /**
   * A voice channel her voice node is in (on `platform` when given), if any: the
   * ActivityManager's presence when it runs, else what the director saw on the bus.
   */
  voiceContext(platform: string | null = null): ContextKey | null {
    const presence = this.#ctx.services.get(ActivityManagerKey)?.snapshot().presence;
    if (presence !== undefined) {
      if (presence.type !== "in") return null;
      return platform === null || presence.channel.platform === platform
        ? { ...presence.channel }
        : null;
    }
    return this.#voices.find((v) => platform === null || v.platform === platform) ?? null;
  }

  /** Voice channels she is in (the manager's presence when it runs). */
  #voiceChannels(): ContextKey[] {
    const presence = this.#ctx.services.get(ActivityManagerKey)?.snapshot().presence;
    if (presence !== undefined) return presence.type === "in" ? [{ ...presence.channel }] : [];
    return this.#voices;
  }

  /** Keeps a goal for the session about to start; returns the reply text. */
  pendingGoal(text: string, by: string): string {
    const goal = text.trim();
    if (goal === "") throw new GameError("請輸入目標。");
    this.#pendingGoal = { text: goal, by };
    return `遊戲還在開,開好後就做:${goal}。`;
  }

  /**
   * Checks that the game is running and its adapter is connected before a session starts
   * (`[modules.game] require_connected`). Throws `GameError` (user-facing, so she can tell the
   * owner) when the adapter does not reach the game. A missing adapter is left to `start`.
   */
  async preflight(game: string, context: ContextKey, signal?: AbortSignal): Promise<Preflight> {
    if (!this.#cfg.require_connected) return { inMenu: false };
    const tools = adapterTools(this.#ctx.services);
    const observe = `game_${game}_observe`;
    if (!tools?.get(observe)) return { inMenu: false };
    const name = gameName(tools.get(`game_${game}_act`)?.spec.description ?? null, game);
    const ctx: ToolContext = {
      turn: newId(),
      context,
      account: { platform: context.platform, id: "game" },
      principal: Principals.director(context),
      message: { context, id: "game" },
      priority: "initiative",
      signal: signal ?? new AbortController().signal,
    };
    let raw: string;
    try {
      raw = await callTool(tools, observe, ctx, {}, this.#cfg.tool_timeout_secs * 1000);
    } catch (error) {
      throw new GameError(`看不到 ${name} 的狀態（${errorMessage(error)}），沒辦法開始玩。`);
    }
    let { state } = splitObservation(raw);
    if (state?.connected === false) {
      const launch = asObject(state.launch);
      if (this.#cfg.auto_launch && launch?.available === true) {
        state = await this.#launch(game, name, context, tools, ctx);
      } else {
        const problem =
          launch?.available === false && typeof launch.problem === "string"
            ? `（沒辦法自己開：${launch.problem}）`
            : "";
        throw new GameError(
          `${name} 還沒開，或遊戲裡的模組沒有連上，沒辦法開始玩。請擁有者先在直播機開遊戲並進入世界。${problem}`,
        );
      }
    }
    return { inMenu: state?.in_game === false };
  }

  /**
   * Starts the game with the adapter's `launch` action (through the gate, as the director) and
   * polls the observe tool until the game connects and, when the launch joins a world, loads it.
   * A refused or failed launch, a launcher error and running out of time throw `GameError`.
   */
  async #launch(
    game: string,
    name: string,
    context: ContextKey,
    tools: AdapterTools,
    ctx: ToolContext,
  ): Promise<JsonObject | null> {
    const cfg = this.#cfg;
    const outcome = await this.#actuators.invoke(
      {
        principal: Principals.director(context),
        capability: GAME_ACT,
        args: { game, call: { action: "launch", args: {} } },
        why: "要開始玩了,先把遊戲開起來",
        turn: null,
      },
      { signal: ctx.signal },
    );
    if (outcome.status === "denied") {
      throw new GameError(
        `沒辦法開 ${name}：${deniedText(outcome.decision.stage)}（${outcome.decision.reason}）`,
      );
    }
    if (outcome.status === "failed") throw new GameError(`${name} 開不起來：${outcome.error}`);
    // The SDK formats a failed action as `失敗:…`.
    const text = outcome.result.text;
    if (text.startsWith("失敗"))
      throw new GameError(`${name} 開不起來：${text.replace(/^失敗:?/, "")}`);
    log.info({ game }, "launching the game");
    const deadline = this.#now() + this.#secs(cfg.launch_wait_secs);
    let world = false;
    let last: JsonObject | null = null;
    for (;;) {
      await sleep(this.#secs(cfg.launch_poll_secs), ctx.signal);
      let raw: string;
      try {
        raw = await callTool(
          tools,
          `game_${game}_observe`,
          ctx,
          {},
          this.#secs(cfg.tool_timeout_secs),
        );
      } catch (error) {
        log.debug({ error: errorMessage(error) }, "observing the starting game failed");
        raw = "";
      }
      const { state } = splitObservation(raw);
      const timeUp = this.#now() >= deadline;
      if (state && state.connected !== false) {
        last = state;
        // Joining a world: wait for it to load (the main menu only while time is left).
        if (state.in_game !== false || !world || timeUp) return state;
      } else if (state) {
        const launch = asObject(state.launch);
        if (launch?.world) world = true;
        if (launch?.state === "failed") {
          throw new GameError(`${name} 開不起來：${String(launch.error ?? "不明原因")}`);
        }
      }
      if (timeUp) {
        if (last) return last;
        throw new GameError(
          `等了 ${cfg.launch_wait_secs} 秒，${name} 還是沒有連上，沒辦法開始玩。請擁有者看一下直播機。`,
        );
      }
    }
  }

  /** Starts a session. Throws `GameError` (user-facing message) when it cannot. */
  start(game: string, placement: Placement, here: ContextKey, invoker: AccountRef): string {
    try {
      const text = this.#start(game, placement, here, invoker);
      this.#cancelWork();
      return text;
    } finally {
      this.#refreshView();
      this.#arm();
    }
  }

  stop(): string {
    try {
      const text = this.#stop();
      this.#cancelWork();
      return text;
    } finally {
      this.#refreshView();
      this.#arm();
    }
  }

  goal(text: string, by: string): string {
    try {
      return this.#commandGoal(text, by);
    } finally {
      this.#refreshView();
      this.#arm();
    }
  }

  #resolveContext(placement: Placement, here: ContextKey): ContextKey {
    const voices = this.#voiceChannels();
    const voice = (): ContextKey | undefined =>
      voices.find((v) => v.platform === here.platform && v.scope === here.scope) ?? voices[0];
    const stream = (): ContextKey | null => this.#cfg.stream_context;
    switch (placement) {
      case "auto":
        return voice() ?? stream() ?? here;
      case "voice": {
        const v = voice();
        if (!v) throw new GameError("她目前不在語音頻道中，無法在語音裡實況。");
        return v;
      }
      case "here":
        return here;
      case "stream": {
        const s = stream();
        if (!s) throw new GameError("沒有設定直播頻道（[modules.game] stream_context）。");
        return s;
      }
    }
  }

  #start(game: string, placement: Placement, here: ContextKey, invoker: AccountRef): string {
    if (this.#session) {
      throw new GameError(`她已經在玩 ${this.#session.gameName}，要換遊戲請先使用 /game stop。`);
    }
    const tools = adapterTools(this.#ctx.services);
    if (!tools) throw new GameError("工具系統沒有啟用，無法玩遊戲。");
    const observe = `game_${game}_observe`;
    const act = tools.get(`game_${game}_act`);
    if (!tools.get(observe) || !act) {
      throw new GameError(
        `找不到 ${game} 的遊戲 adapter（工具 \`${observe}\`），請確認擴充套件已啟用。`,
      );
    }
    const context = this.#resolveContext(placement, here);
    const name = gameName(act.spec.description, game);
    this.#generation += 1;
    log.info({ game, context: contextKeyString(context) }, "game session started");
    const where = context.kind === "voice" ? "語音頻道" : "這個頻道";
    const now = this.#now();
    this.#session = {
      generation: this.#generation,
      game,
      gameName: name,
      context,
      placement,
      here,
      starter: invoker,
      startedAt: now,
      goal: null,
      backlog: [],
      recent: [],
      summary: "",
      busy: null,
      lastAction: null,
      nextDecide: now,
      decideStarted: null,
      trigger: { text: ["剛開始玩"], important: true },
      lastComment: null,
      guard: null,
    };
    this.#publishSession("started", this.#session);
    let text = `她開始玩 ${name} 了，實況會在${where}進行。`;
    const pending = this.#pendingGoal;
    this.#pendingGoal = null;
    if (pending !== null) text += this.#commandGoal(pending.text, pending.by);
    return text;
  }

  #publishSession(
    state: "started" | "stopped",
    s: Session,
    end: { code: TaskFailureCode; reason: string } | null = null,
  ): void {
    this.#ctx.publish(
      customEvent(SESSION_TOPIC, {
        state,
        game: s.game,
        game_name: s.gameName,
        context: { ...s.context },
        ...(end !== null ? { code: end.code, reason: end.reason } : {}),
      }),
    );
  }

  /**
   * Ends the session because the game went away (`disconnected`, its extension crashed): no
   * `stop` / `quit` actions (nothing to send them to); the session event carries the code.
   */
  #end(code: TaskFailureCode, reason: string): void {
    const s = this.#session;
    if (!s) return;
    this.#session = null;
    this.#generation += 1;
    this.#pendingGoal = null;
    log.warn({ game: s.game, code, reason }, "game session ended by itself");
    this.#publishSession("stopped", s, { code, reason });
    this.#cancelWork();
  }

  #stop(): string {
    const s = this.#session;
    this.#pendingGoal = null;
    if (!s) throw new GameError("她目前沒有在玩遊戲。");
    this.#session = null;
    this.#generation += 1;
    log.info({ game: s.game }, "game session stopped");
    this.#publishSession("stopped", s);
    const tools = adapterTools(this.#ctx.services);
    const act = tools?.get(actTool(s));
    if (act) {
      const actuators = this.#actuators;
      const quit = this.#cfg.close_on_stop && offers(act.spec.parameters, "quit");
      this.#ctx.spawn("game-stop", async (signal) => {
        const calls = quit ? ["stop", "quit"] : ["stop"];
        for (const name of calls) {
          try {
            // `quit` closes the game when the adapter's own rule says so (e.g. she launched it).
            await actThroughGate(actuators, s, new ActionCall(name, {}).toolArgs(), signal);
          } catch (error) {
            log.debug({ action: name, error: errorMessage(error) }, "stopping the game failed");
          }
        }
      });
    }
    const open: number[] = s.backlog.map((q) => q.item);
    if (s.goal?.source.type === "queue") open.unshift(s.goal.source.item);
    let text = `她已停止玩 ${s.gameName}。`;
    if (open.length > 0) {
      text += `觀眾請求 ${open.map((i) => `#${i}`).join("、")} 尚未完成，已保留在佇列中。`;
    }
    return text;
  }

  #commandGoal(rawText: string, by: string): string {
    const s = this.#session;
    if (!s) throw new GameError("她目前沒有在玩遊戲。");
    const text = rawText.trim();
    if (text === "") throw new GameError("請輸入目標。");
    const old = s.goal;
    s.goal = null;
    if (old?.source.type === "queue") {
      // The viewer's goal waits for its turn again.
      s.backlog.unshift({ item: old.source.item, text: old.text, requester: old.source.requester });
    }
    s.goal = newGoal(text, { type: "command", by }, this.#now());
    this.#trigger(`新目標:${text}`, true);
    return `已設定新目標：${text}。`;
  }

  // ----- events -----

  onEvent(env: Envelope): void {
    if (this.#closed || env.source === this.#ctx.id) return;
    const event = env.event;
    switch (event.type) {
      case "voice_joined":
      case "voice_participants":
        if (!this.#voices.some((v) => contextKeyEquals(v, event.data.context))) {
          this.#voices.push(event.data.context);
        }
        break;
      case "voice_left":
        this.#voices = this.#voices.filter((v) => !contextKeyEquals(v, event.data.context));
        break;
      case "module_state_changed": {
        // An extension that stopped or crashed takes the adapter's tools with it.
        const s = this.#session;
        const { module, state } = event.data;
        if (s && module.startsWith("ext.") && (state === "failed" || state === "stopped")) {
          if (!adapterTools(this.#ctx.services)?.get(observeTool(s))) {
            this.#end("crashed", `遊戲的擴充套件停止了(${module})`);
          }
        }
        break;
      }
      case "custom": {
        const { topic, payload } = event.data;
        if (topic === "queue.item_activated") {
          this.#onQueueItem(payload);
        } else {
          const s = this.#session;
          if (!s) return;
          const prefix = `game.${s.game}.`;
          if (!topic.startsWith(prefix)) return;
          const kind = asObject(payload)?.type;
          this.#onGameEvent(typeof kind === "string" ? kind : topic.slice(prefix.length), payload);
        }
        break;
      }
      default:
        return;
    }
    this.#refreshView();
    this.#arm();
  }

  #remember(line: string): void {
    const max = Math.max(this.#cfg.recent_events, 1);
    const s = this.#session;
    if (!s) return;
    s.recent.push(line);
    while (s.recent.length > max) s.recent.shift();
  }

  #onGameEvent(kind: string, payload: JsonValue): void {
    const obj = asObject(payload);
    const data = obj?.data ?? null;
    const dataObj = asObject(data);
    const text = typeof dataObj?.text === "string" ? dataObj.text : kind;
    const important = obj?.important === true;
    log.debug({ kind, text, important }, "game event");
    if (this.#cfg.end_events.includes(kind)) {
      // The game went away: the session ends (scene back, activity failed), no commentary.
      this.#end("disconnected", text);
      return;
    }
    this.#remember(text);

    const s = this.#session;
    const issuedAt = s?.goal?.issuedAt ?? null;
    const settled =
      issuedAt !== null && this.#now() - issuedAt >= this.#secs(this.#cfg.settle_secs);
    const cancelled = dataObj?.cancelled === true;
    if (settled && this.#cfg.failed_events.includes(kind)) {
      if (s) s.guard = guardAfter(this.#cfg, firstLine(text, 80), this.#now()) ?? s.guard;
      this.#finishGoal({ type: "failed", why: text });
    } else if (settled && !cancelled && this.#cfg.reached_events.includes(kind)) {
      this.#finishGoal({ type: "reached" });
    }

    switch (kind) {
      case "death": {
        this.#nudge({ valence: -0.15, arousal: 0.1, energy: 0.0, reason: "game: death" });
        const cur = this.#session;
        if (cur) {
          const g = cur.goal;
          // A requested goal survives the death; it is retried.
          if (g && goalLocked(g.source)) {
            g.action = null;
            g.issuedAt = null;
          } else {
            cur.goal = null;
          }
        }
        this.#commentEvent(text, true);
        break;
      }
      case "advancement":
        this.#nudge({ valence: 0.15, arousal: 0.1, energy: 0.0, reason: "game: advancement" });
        this.#commentEvent(text, true);
        break;
      case "chat":
        // Player chat is its own conversation when `game.chat` handles this game: she answers
        // there, so the director only notes it (as untrusted data for its next decision).
        if (important && !this.#chatHandled(dataObj)) this.#commentEvent(text, true);
        break;
      default:
        if (important) this.#commentEvent(text, true);
    }
    if (this.#cfg.trigger_events.includes(kind)) this.#trigger(text, important);
  }

  /** A player's chat line that `game.chat` turns into a conversation. */
  #chatHandled(data: JsonObject | null): boolean {
    const s = this.#session;
    if (!s || data?.system === true) return false;
    return this.#ctx.services.get(GameChatKey)?.handles(s.game) ?? false;
  }

  #onQueueItem(payload: JsonValue): void {
    const obj = asObject(payload);
    const kind = typeof obj?.kind === "string" ? obj.kind : "";
    if (kind !== this.#cfg.queue_kind) return;
    const item = obj?.id;
    const text = obj?.text;
    if (
      typeof item !== "number" ||
      !Number.isInteger(item) ||
      item < 0 ||
      typeof text !== "string"
    ) {
      log.warn({ payload }, "queue item without id or text");
      return;
    }
    const requester = typeof obj?.requester_name === "string" ? obj.requester_name : "觀眾";
    const s = this.#session;
    if (!s) {
      log.debug({ item }, "game goal activated while not playing; ignored");
      return;
    }
    const queued: QueuedGoal = { item, text, requester };
    if (s.goal && goalLocked(s.goal.source)) {
      s.backlog.push(queued);
      return;
    }
    this.#beginQueued(queued);
  }

  /** Makes a viewer goal current and announces it. */
  #beginQueued(q: QueuedGoal): void {
    const s = this.#session;
    if (!s) return;
    const line = `觀眾 ${q.requester} 想要你:${q.text}`;
    s.goal = newGoal(q.text, { type: "queue", item: q.item, requester: q.requester }, this.#now());
    this.#remember(line);
    this.#comment(`${line}。回應一下,然後開始做。`, true);
    this.#trigger(line, true);
  }

  #finishGoal(outcome: Outcome): void {
    const s = this.#session;
    if (!s) return;
    const goal = s.goal;
    if (!goal) return;
    s.goal = null;
    let line: string;
    let hint: { text: string; urgent: boolean } | null;
    if (goal.source.type === "queue") {
      const requester = goal.source.requester;
      if (outcome.type === "reached") {
        line = `完成目標:${goalLabel(goal)}`;
        hint = {
          text: `完成了觀眾 ${requester} 的請求「${goal.text}」,跟大家說一聲`,
          urgent: true,
        };
      } else {
        line = `目標失敗:${goalLabel(goal)}(${outcome.why})`;
        hint = {
          text: `觀眾 ${requester} 的請求「${goal.text}」沒做成(${outcome.why}),找個藉口`,
          urgent: true,
        };
      }
    } else if (outcome.type === "reached") {
      line = `完成目標:${goalLabel(goal)}`;
      hint = { text: `剛完成「${goal.text}」`, urgent: false };
    } else {
      line = `目標失敗:${goalLabel(goal)}(${outcome.why})`;
      hint = null;
    }
    log.info({ goal: goal.text, reached: outcome.type === "reached" }, "game goal finished");
    if (goal.source.type === "queue") {
      const queue = this.#ctx.services.get(RequestQueueKey);
      if (queue) {
        const item = goal.source.item;
        try {
          if (outcome.type === "reached") queue.complete(item);
          else queue.skip(item);
        } catch (error) {
          log.warn({ item, error: errorMessage(error) }, "could not finish the queue item");
        }
      }
    }
    this.#remember(line);
    if (hint) this.#comment(hint.text, hint.urgent);
    const next = this.#session?.backlog.shift();
    if (next) this.#beginQueued(next);
    else this.#trigger(line, false);
  }

  /** Asks for an early decision (at most every `min_decide_secs`). */
  #trigger(text: string, important: boolean): void {
    const min = this.#secs(this.#cfg.min_decide_secs);
    const s = this.#session;
    if (!s) return;
    s.trigger ??= { text: [], important: false };
    s.trigger.text.push(text);
    s.trigger.important ||= important;
    const now = this.#now();
    const earliest = s.decideStarted === null ? now : Math.max(s.decideStarted + min, now);
    if (earliest < s.nextDecide) s.nextDecide = earliest;
  }

  // ----- commentary and mood -----

  /**
   * Requests a commentary line; rate-limited unless urgent (urgent ones have their own, shorter
   * limit). Returns whether it was sent.
   */
  #comment(hint: string, urgent: boolean): boolean {
    const cfg = this.#cfg;
    const s = this.#session;
    if (!s) return false;
    const gap = this.#secs(urgent ? cfg.urgent_commentary_min_secs : cfg.commentary_min_secs);
    const now = this.#now();
    if (s.lastComment !== null && now - s.lastComment < gap) {
      log.debug({ hint, urgent }, "commentary rate-limited");
      return false;
    }
    s.lastComment = now;
    // `auto`: she may have joined (or left) a voice channel since the game started; comment
    // where she is now rather than where the game was started.
    if (s.placement === "auto") {
      s.context = this.#resolveContext("auto", s.here);
      // Not in voice and no stream channel: play quietly rather than fill a text channel with
      // running commentary (`where: "here"` asks for that explicitly).
      if (s.context.kind !== "voice" && s.context !== this.#cfg.stream_context) {
        log.debug({ hint }, "commentary skipped: not in voice");
        return false;
      }
    }
    const text = urgent
      ? `(你正在直播玩 ${s.gameName})${hint}`
      : `(你正在直播玩 ${s.gameName})實況:${hint}`;
    // Commentary is an impulse of source `game` (never her own topic); a newer line replaces
    // one still waiting for a free moment.
    const impulse = newImpulse(
      {
        source: "game",
        context: s.context,
        ttlMs: this.#secs(urgent ? cfg.urgent_commentary_min_secs : cfg.commentary_min_secs),
        why: `${s.gameName} 實況`,
        hint: text,
        reason: INITIATIVE_REASON,
        coalesce_key: `game:${contextKeyString(s.context)}`,
      },
      now,
    );
    this.#ctx.publish(v2Event(ARBITER_IMPULSE_TOPIC, impulse));
    return true;
  }

  #commentEvent(text: string, urgent: boolean): void {
    this.#comment(`剛剛${text}!馬上用一兩句話反應。`, urgent);
  }

  #nudge(m: MoodNudge): void {
    this.#ctx.publish(
      customEvent("mood.nudge", {
        valence: m.valence,
        arousal: m.arousal,
        energy: m.energy,
        reason: m.reason,
      }),
    );
  }

  // ----- decisions -----

  #startDecide(): Work | null {
    const cfg = this.#cfg;
    const s0 = this.#session;
    if (!s0) return null;
    const now = this.#now();
    // Hold the next tick far away until the result arrives.
    s0.nextDecide = now + this.#secs(cfg.decide_secs);
    s0.decideStarted = now;
    const tools = adapterTools(this.#ctx.services);
    if (!tools) {
      log.warn("no tool registry; cannot observe the game");
      return null;
    }
    const maxAge = this.#secs(cfg.max_goal_secs);
    if (s0.goal && now - s0.goal.setAt >= maxAge) {
      this.#finishGoal({ type: "failed", why: "太久了,放棄" });
    }
    const s = this.#session;
    if (!s) return null;
    const trigger = s.trigger ?? { text: [], important: false };
    s.trigger = null;
    const input: DecideInput = {
      generation: s.generation,
      trigger,
      cfg,
      tools,
      router: this.#ctx.services.get(LlmRouterKey),
      toolCtx: toolCtx(s, new AbortController().signal),
      observeTool: observeTool(s),
      actTool: actTool(s),
      persona: this.#persona,
      game: s.game,
      gameName: s.gameName,
      goal: s.goal
        ? `${goalLabel(s.goal)}(${
            s.goal.action === null
              ? "還沒開始"
              : `已進行 ${Math.floor(Math.max(this.#now() - s.goal.setAt, 0) / 1000)} 秒`
          })`
        : null,
      lastAction: s.lastAction,
      backlog: s.backlog.map((q) => `${q.text}(${q.requester})`),
      recent: [...s.recent],
      withheld: guardNote(s.guard, now),
    };
    return (signal) => decide({ ...input, toolCtx: { ...input.toolCtx, signal } });
  }

  #onDone(done: Done): Work | null {
    if (this.#session?.generation !== done.generation) return null;
    let next: Work | null = null;
    if (done.type === "decided") {
      next = this.#onDecided(done.trigger, done.observation, done.decision);
    } else {
      this.#onActed(done.action, done.verdict, done.goal, done.result);
    }
    if (!next) this.#scheduleAfterWork();
    this.#refreshView();
    return next;
  }

  #scheduleAfterWork(): void {
    const cfg = this.#cfg;
    const s = this.#session;
    if (!s) return;
    const now = this.#now();
    const next = s.trigger
      ? s.decideStarted === null
        ? now
        : Math.max(s.decideStarted + this.#secs(cfg.min_decide_secs), now)
      : (s.decideStarted ?? now) + this.#secs(cfg.decide_secs);
    s.nextDecide = Math.max(next, now);
  }

  #onDecided(
    trigger: Trigger,
    observation: Res<string>,
    decisionRes: Res<Decision> | null,
  ): Work | null {
    const cfg = this.#cfg;
    const s = this.#session;
    if (!s) return null;
    if (observation.ok) {
      const { summary, state } = splitObservation(observation.value);
      s.busy = typeof state?.busy === "boolean" ? state.busy : null;
      s.summary = summary;
    } else {
      log.warn({ error: observation.error }, "observing the game failed");
      if (!adapterTools(this.#ctx.services)?.get(observeTool(s))) {
        // The adapter is gone (its extension crashed or was disabled): the session ends.
        this.#end("crashed", "遊戲的擴充套件不見了");
        return null;
      }
      s.summary = `看不到遊戲畫面(${observation.error})`;
      s.busy = null;
      return null;
    }
    if (!decisionRes) return null;
    if (!decisionRes.ok) {
      log.warn({ error: decisionRes.error }, "game decision failed");
      return null;
    }
    const decision = decisionRes.value;
    if (decision.status === "done") this.#finishGoal({ type: "reached" });
    else if (decision.status === "failed") this.#finishGoal({ type: "failed", why: "做不到" });
    if (decision.mood) {
      const max = Math.abs(cfg.max_llm_nudge);
      const clamp = (v: number): number => Math.min(Math.max(v, -max), max);
      const m: MoodNudge = {
        valence: clamp(decision.mood.valence),
        arousal: clamp(decision.mood.arousal),
        energy: clamp(decision.mood.energy),
        reason: decision.mood.reason,
      };
      if (m.valence !== 0 || m.arousal !== 0 || m.energy !== 0) {
        m.reason = `game: ${m.reason}`;
        this.#nudge(m);
      }
    }
    if (decision.commentary !== null) this.#comment(decision.commentary, false);
    const cur = this.#session;
    if (!cur) return null;
    let verdict: Verdict | null = null;
    if (decision.action) {
      const g = cur.goal;
      const now = this.#now();
      const facts: GoalFacts | null = g
        ? {
            text: g.text,
            locked: goalLocked(g.source),
            pending: g.action === null,
            action: g.action,
            ageMs: now - g.setAt,
            sinceIssuedMs: g.issuedAt === null ? 0 : now - g.issuedAt,
          }
        : null;
      verdict = judge(cfg, facts, decision.action, decision.goal, cur.busy, trigger.important);
      const guard = activeGuard(cur.guard, now);
      if (verdict.type !== "keep" && guard && withheld(guard, decision.action.name, now)) {
        // The same kind of low-level retry right after a failure: she has to change method.
        verdict = { type: "keep", why: `withheld after a failure: ${guard.why}` };
        cur.lastAction = `${decision.action.display()} → 暫時不行:剛剛失敗過(${guard.why}),換個方法或目標`;
        if (!guard.nudged) {
          guard.nudged = true;
          this.#trigger("動作被擋下了,換個方法或目標", false);
        }
      }
    }
    this.#ctx.publish(
      customEvent(DECISION_TOPIC, {
        game: cur.game,
        trigger: trigger.text,
        goal: decision.goal,
        action: decision.action ? decision.action.display() : null,
        verdict: verdict ? verdictDebug(verdict) : null,
        commentary: decision.commentary,
        busy: cur.busy,
      }),
    );
    if (!decision.action || !verdict) return null;
    if (verdict.type === "keep") {
      log.debug({ action: decision.action.display(), why: verdict.why }, "kept the current goal");
      return null;
    }
    if (!adapterTools(this.#ctx.services)) return null;
    const generation = cur.generation;
    const actuators = this.#actuators;
    const action = decision.action;
    const goal = decision.goal;
    const settled = verdict;
    return async (signal) => {
      const result = await attempt(() => actThroughGate(actuators, cur, action.toolArgs(), signal));
      return { type: "acted", generation, action, verdict: settled, goal, result };
    };
  }

  #onActed(
    action: ActionCall,
    verdict: Verdict,
    goalText: string | null,
    result: Res<string>,
  ): void {
    const maxAttempts = Math.max(this.#cfg.max_attempts, 1);
    const instant = this.#cfg.instant_actions.includes(action.name);
    const s = this.#session;
    if (!s) return;
    // The SDK formats results as `成功…` / `失敗…`.
    const [ok, text] = result.ok
      ? ([!result.value.startsWith("失敗"), result.value] as const)
      : ([false, `失敗:${result.error}`] as const);
    s.lastAction = `${action.display()} → ${firstLine(text, 120)}`;
    log.debug({ action: action.display(), ok }, "game action");
    let failedGoal = false;
    const now = this.#now();
    if (!instant) {
      s.guard = ok
        ? afterSuccess(s.guard, action.name, now)
        : (guardAfter(this.#cfg, firstLine(text, 80), now) ?? s.guard);
    }
    if (verdict.type === "replace" && ok) {
      const goal = newGoal(goalText ?? action.display(), { type: "director" }, now);
      goal.action = action;
      goal.issuedAt = now;
      s.goal = goal;
    } else if (verdict.type === "step" && !instant) {
      const g = s.goal;
      if (g) {
        if (ok) {
          g.action = action;
          g.issuedAt = now;
        } else {
          g.attempts += 1;
          failedGoal = g.attempts >= maxAttempts;
        }
      }
    }
    if (failedGoal) this.#finishGoal({ type: "failed", why: firstLine(text, 60) });
    else if (!ok) this.#trigger("上一個動作失敗了", false);
  }
}

/** Whether the act tool's schema lists `action` (its `action` enum). */
function offers(parameters: JsonValue, action: string): boolean {
  const actionSchema = asObject(asObject(asObject(parameters)?.properties)?.action);
  const names = actionSchema?.enum;
  return Array.isArray(names) && names.includes(action);
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
