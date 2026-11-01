// The Stage node: `miyoria stage` on the streaming PC.

import { errorMessage, getLogger, SerialQueue, sleep } from "@miyoria/kernel";
import { type Clock, systemClock } from "@miyoria/types";
import WebSocket from "ws";
import { z } from "zod";
import { AvatarProfile } from "./avatar.js";
import { EmotionController, type VtsCommand } from "./emotion.js";
import { Levels, LipSyncConfigSchema, MouthShaper, serveLevels } from "./lipsync.js";
import { GazeConfigSchema, IdleMotion, MOTION_PARAMS } from "./motion.js";
import { ObsConfigSchema, type ObsConnector, ObsController, ObsWebSocketConnector } from "./obs.js";
import { OverlayHub, serveOverlay } from "./overlay.js";
import {
  CLOSE,
  type CoreMessage,
  defaultStageStatus,
  encodeMessage,
  type GazeTarget,
  parseCoreMessage,
  type StageMessage,
  type StageStatus,
  sameStatus,
  VERSION,
} from "./protocol.js";
import {
  ApiError,
  ERROR_USER_DENIED,
  pluginInfo,
  tokenPath,
  VtsClient,
  VtsConfigSchema,
} from "./vts.js";
import { Watch } from "./watch.js";

const log = getLogger("stage");

/** Connecting to Core, and then waiting for its welcome, each take at most this long. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Stage node config (e.g. the `[stage]` section of `miyoria.toml`). */
export const StageConfigSchema = z.object({
  /** Core's Stage Link endpoint. */
  core_url: z.string().default("ws://127.0.0.1:7882/stage-link"),
  /** Stage Link token (same as `[modules."stage.link"] token`). Required. */
  token: z.string().default(""),
  /** Node name sent in `hello`. */
  node: z.string().default("stage"),
  /** Where the VTS token is stored. */
  data_dir: z.string().default("data/stage"),
  /** Overlay HTTP server address. */
  overlay_bind: z.string().default("127.0.0.1:7884"),
  /** Overlay web app files. */
  overlay_dir: z.string().default("apps/overlay/dist"),
  /** Core is considered gone after this long without traffic. */
  peer_timeout_ms: z.number().int().nonnegative().default(45_000),
  vts: VtsConfigSchema.prefault({}),
  obs: ObsConfigSchema.prefault({}),
  lipsync: LipSyncConfigSchema.prefault({}),
  gaze: GazeConfigSchema.prefault({}),
});
export type StageConfigSection = z.output<typeof StageConfigSchema>;

/** The Stage config plus the profile's `avatar.toml` (set by the caller). */
export type StageConfig = StageConfigSection & { avatar: AvatarProfile };

/** Parses a `[stage]` section (missing = defaults) and attaches `avatar`. */
export function parseStageConfig(section: unknown = {}, avatar = new AvatarProfile()): StageConfig {
  return { ...StageConfigSchema.parse(section ?? {}), avatar };
}

export class StageError extends Error {
  override readonly name = "StageError";
}

export interface RunStageOptions {
  /** OBS connections (default: obs-websocket-js with `[stage.obs]`). */
  obs?: ObsConnector;
  /** Stops the Stage. Default: Ctrl-C (SIGINT). */
  signal?: AbortSignal;
  clock?: Clock;
}

/**
 * Runs the Stage node until `options.signal` aborts (default: Ctrl-C). Rejects on unusable
 * config or when Core rejects the token.
 */
export async function runStage(config: StageConfig, options: RunStageOptions = {}): Promise<void> {
  let signal = options.signal;
  let cleanup = () => {};
  if (!signal) {
    const controller = new AbortController();
    const onSigint = () => {
      log.info("stopping the stage");
      controller.abort();
    };
    process.once("SIGINT", onSigint);
    cleanup = () => process.off("SIGINT", onSigint);
    signal = controller.signal;
  }
  try {
    const obs = options.obs ?? ObsWebSocketConnector.fromConfig(config.obs);
    await runStageWith(config, obs, signal, options.clock);
  } finally {
    cleanup();
  }
}

/** `runStage` with an explicit OBS connector, until `signal` aborts. */
export async function runStageWith(
  config: StageConfig,
  obsConnector: ObsConnector,
  signal: AbortSignal,
  clock: Clock = systemClock,
): Promise<void> {
  if (config.token.trim() === "") {
    throw new StageError(
      'the stage token is empty: set STAGE_LINK_TOKEN (the same value as `[modules."stage.link"] token` on Core)',
    );
  }
  const tasks = new AbortController();
  const stopTasks = () => tasks.abort();
  signal.addEventListener("abort", stopTasks, { once: true });
  const background: Promise<void>[] = [];
  const spawn = (name: string, run: () => Promise<void>) => {
    background.push(
      run().catch((error: unknown) => {
        if (!tasks.signal.aborted)
          log.error({ task: name, err: errorMessage(error) }, "stage task failed");
      }),
    );
  };

  try {
    const overlay = new OverlayHub();
    const overlayServer = await serveOverlay(
      config.overlay_bind,
      config.overlay_dir,
      overlay,
      tasks.signal,
    );
    background.push(overlayServer.done);

    const levels = new Levels(config.lipsync);
    const vts = new Watch<VtsClient | null>(null);
    let avatar: AvatarLoop | null = null;
    if (config.vts.enabled) {
      if (config.avatar.lipsync === "inject") {
        const levelsServer = await serveLevels(config.lipsync.bind, levels, tasks.signal, clock);
        background.push(levelsServer.done);
      }
      spawn("vts", () => vtsManager(config, vts, tasks.signal));
      avatar = new AvatarLoop(config, levels, vts, clock);
      const loop = avatar;
      spawn("avatar", () => loop.run(tasks.signal));
    }

    let obs: ObsController | null = null;
    if (config.obs.enabled) {
      const controller = new ObsController(obsConnector, config.obs);
      spawn("obs", () => controller.run(tasks.signal));
      obs = controller;
    }

    const stage = new Stage(vts, obs, overlay, levels, avatar);
    stage.aggregateStatus(tasks.signal);
    await coreLink(config, stage, signal);
  } finally {
    signal.removeEventListener("abort", stopTasks);
    tasks.abort();
    await Promise.race([Promise.allSettled(background), sleep(5_000)]);
  }
}

class Stage {
  readonly #vts: Watch<VtsClient | null>;
  readonly #obs: ObsController | null;
  readonly #overlay: OverlayHub;
  readonly #levels: Levels;
  readonly #avatar: AvatarLoop | null;
  readonly status = new Watch<StageStatus>(defaultStageStatus(), sameStatus);
  /** Connected to Core. */
  readonly core = new Watch<boolean>(false);
  /** Sends a reply to Core (set while a session is up). */
  replies: ((msg: StageMessage) => void) | null = null;

  constructor(
    vts: Watch<VtsClient | null>,
    obs: ObsController | null,
    overlay: OverlayHub,
    levels: Levels,
    avatar: AvatarLoop | null,
  ) {
    this.#vts = vts;
    this.#obs = obs;
    this.#overlay = overlay;
    this.#levels = levels;
    this.#avatar = avatar;
  }

  #vtsClient(): VtsClient | null {
    const c = this.#vts.get();
    return c && !c.isClosed() ? c : null;
  }

  currentStatus(): StageStatus {
    const obs = this.#obs?.state();
    return {
      vts: this.#vtsClient() !== null,
      obs: obs?.connected ?? false,
      scene: obs?.scene ?? null,
      streaming: obs?.streaming ?? false,
    };
  }

  #reply(id: number | undefined, error: unknown | null): void {
    const msg: StageMessage =
      error === null
        ? { type: "status", ...this.currentStatus(), ...(id === undefined ? {} : { id }) }
        : { type: "error", message: errorMessage(error), ...(id === undefined ? {} : { id }) };
    this.replies?.(msg);
  }

  #obsOrThrow(): ObsController {
    if (!this.#obs) throw new StageError("OBS control is disabled on the stage");
    return this.#obs;
  }

  #answer(id: number | undefined, work: () => Promise<unknown>): void {
    void work().then(
      () => this.#reply(id, null),
      (error: unknown) => this.#reply(id, error),
    );
  }

  handle(msg: CoreMessage): void {
    switch (msg.type) {
      case "emotion":
        this.#overlay.emotion(msg.name, msg.intensity);
        this.#avatar?.emotion(msg.name);
        return;
      case "subtitle": {
        this.#overlay.subtitle(msg.turn, msg.text, msg.final);
        if (this.#obs) void this.#obs.subtitle(msg.text, msg.final);
        return;
      }
      case "speaking":
        this.#overlay.speaking(msg.state);
        if (msg.state === "stopped") this.#levels.clear();
        this.#avatar?.speaking(msg.state === "started");
        return;
      case "gaze":
        this.#avatar?.gaze(msg.target);
        return;
      case "scene":
        this.#answer(msg.id, async () => this.#obsOrThrow().setScene(msg.name));
        return;
      case "stream":
        this.#answer(msg.id, async () => this.#obsOrThrow().stream(msg.action));
        return;
      case "avatar_hotkey":
        this.#answer(msg.id, async () => {
          const vts = this.#vtsClient();
          if (!vts) throw new StageError("VTube Studio is not connected");
          return vts.triggerHotkey(msg.name);
        });
        return;
      case "status_request":
        this.#reply(msg.id, null);
        return;
      case "welcome":
      case "ping":
      case "pong":
        return;
    }
  }

  /** Recomputes the status whenever VTS, OBS or the Core link change. */
  aggregateStatus(signal: AbortSignal): void {
    let lastCore: boolean | null = null;
    const update = () => {
      const status = this.currentStatus();
      const core = this.core.get();
      const changed = this.status.set(status);
      if (changed || lastCore !== core) {
        this.#overlay.status(status, core);
        lastCore = core;
      }
    };
    const unsubscribe = [
      this.#vts.subscribe(update),
      this.core.subscribe(update),
      this.#obs?.subscribe(update) ?? (() => {}),
    ];
    // A client that closes by itself does not change the watch; poll for that.
    const poll = setInterval(update, 1_000);
    update();
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(poll);
        for (const u of unsubscribe) u();
      },
      { once: true },
    );
  }
}

type SessionEnd = "stopped" | "lost" | "replaced";

class SessionError extends Error {
  override readonly name = "SessionError";

  constructor(
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
  }
}

async function coreLink(config: StageConfig, stage: Stage, signal: AbortSignal): Promise<void> {
  let backoffMs = 1_000;
  let failures = 0;
  for (;;) {
    let outcome: SessionEnd | SessionError;
    try {
      outcome = await session(config, stage, signal);
    } catch (error) {
      outcome =
        error instanceof SessionError ? error : new SessionError(errorMessage(error), false);
    }
    stage.replies = null;
    stage.core.set(false);
    if (outcome === "stopped") return;
    if (outcome === "lost") {
      log.warn("lost the connection to Core, reconnecting");
      backoffMs = 1_000;
      failures = 0;
    } else if (outcome === "replaced") {
      log.warn("another stage node connected to Core; retrying later");
      backoffMs = 30_000;
    } else if (outcome.fatal) {
      throw new StageError(outcome.message, { cause: outcome });
    } else {
      failures += 1;
      if (failures === 1 || failures % 20 === 0) {
        log.warn({ err: outcome.message, url: config.core_url }, "cannot reach Core");
      } else {
        log.debug({ err: outcome.message }, "cannot reach Core");
      }
    }
    try {
      await sleep(backoffMs, signal);
    } catch {
      return;
    }
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}

function capabilities(config: StageConfig): string[] {
  const caps = ["overlay"];
  if (config.vts.enabled) {
    caps.push("vts");
    if (config.avatar.lipsync === "inject") caps.push("lipsync");
  }
  if (config.obs.enabled) caps.push("obs");
  return caps;
}

/** One connection to Core, from connect to close. */
function session(config: StageConfig, stage: Stage, signal: AbortSignal): Promise<SessionEnd> {
  if (signal.aborted) return Promise.resolve("stopped");
  return new Promise<SessionEnd>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(config.core_url, {
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        maxPayload: 1 << 20,
      });
    } catch (error) {
      reject(new SessionError(errorMessage(error), false));
      return;
    }
    let settled = false;
    let opened = false;
    let welcomed = false;
    let peerTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeStatus = () => {};
    const finish = (outcome: SessionEnd | SessionError) => {
      if (settled) return;
      settled = true;
      clearTimeout(welcomeTimer);
      clearTimeout(peerTimer);
      unsubscribeStatus();
      signal.removeEventListener("abort", onAbort);
      if (stage.replies === send) stage.replies = null;
      if (ws.readyState !== WebSocket.CLOSED) {
        setTimeout(() => ws.terminate(), 2_000).unref();
      }
      if (outcome instanceof SessionError) reject(outcome);
      else resolve(outcome);
    };
    const send = (msg: StageMessage) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(encodeMessage(msg), (error) => {
        if (error) {
          ws.terminate();
          finish("lost");
        }
      });
    };
    const onAbort = () => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "stage stopping");
      else ws.terminate();
      finish("stopped");
    };
    signal.addEventListener("abort", onAbort, { once: true });

    // Welcome, or a close frame telling why not (the connect itself also counts).
    const welcomeTimer = setTimeout(() => {
      ws.terminate();
      finish(new SessionError(opened ? "no welcome from Core" : "connection timed out", false));
    }, CONNECT_TIMEOUT_MS * 2);

    const resetPeerTimer = () => {
      clearTimeout(peerTimer);
      peerTimer = setTimeout(
        () => {
          log.warn("Core stopped answering");
          ws.terminate();
          finish("lost");
        },
        Math.max(config.peer_timeout_ms, 1),
      );
    };

    ws.on("open", () => {
      opened = true;
      send({
        type: "hello",
        version: VERSION,
        token: config.token.trim(),
        node: config.node,
        capabilities: capabilities(config),
      });
    });
    ws.on("error", (error) => {
      if (!welcomed) finish(new SessionError(error.message, false));
      else finish("lost");
    });
    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf.toString();
      if (!welcomed) {
        const message =
          code === 1005 || code === 1006
            ? "Core closed the connection"
            : `Core closed the connection (${code}: ${reason})`;
        if (code === CLOSE.UNAUTHORIZED) {
          finish(new SessionError("Core rejected the stage token (check STAGE_LINK_TOKEN)", true));
        } else if (code === CLOSE.BAD_HELLO) {
          finish(new SessionError(message, true));
        } else {
          finish(new SessionError(message, false));
        }
        return;
      }
      finish(code === CLOSE.REPLACED ? "replaced" : "lost");
    });
    ws.on("ping", () => welcomed && resetPeerTimer());
    ws.on("pong", () => welcomed && resetPeerTimer());
    ws.on("message", (data, isBinary) => {
      if (settled) return;
      if (welcomed) resetPeerTimer();
      if (isBinary) return;
      let msg: CoreMessage;
      try {
        msg = parseCoreMessage(JSON.parse(data.toString()));
      } catch (error) {
        log.debug({ err: errorMessage(error) }, "unknown message from Core");
        return;
      }
      if (!welcomed) {
        if (msg.type !== "welcome") return;
        welcomed = true;
        clearTimeout(welcomeTimer);
        log.info({ session: msg.session }, "connected to Core");
        // Answers meant for an earlier connection are dropped with it.
        stage.replies = send;
        stage.core.set(true);
        send({ type: "status", ...stage.currentStatus() });
        unsubscribeStatus = stage.status.subscribe((status) => send({ type: "status", ...status }));
        resetPeerTimer();
        return;
      }
      if (msg.type === "ping") send({ type: "pong" });
      else stage.handle(msg);
    });
  });
}

/** Connects to VTube Studio and keeps the connection, reconnecting with backoff. */
async function vtsManager(
  config: StageConfig,
  watch: Watch<VtsClient | null>,
  signal: AbortSignal,
): Promise<void> {
  const plugin = pluginInfo(config.vts);
  const tokenFile = tokenPath(config.data_dir);
  const timeoutMs = Math.max(config.vts.request_timeout_ms, 1);
  const approvalMs = Math.max(config.vts.approval_timeout_ms, 1);
  let backoffMs = 2_000;
  let failures = 0;
  while (!signal.aborted) {
    let client: VtsClient | null = null;
    try {
      client = await VtsClient.connect(config.vts.url, timeoutMs);
      const c = client;
      const onAbort = () => c.close();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await c.authenticate(plugin, tokenFile, approvalMs);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      if (signal.aborted) {
        c.close();
        return;
      }
      failures = 0;
      backoffMs = 2_000;
      await checkModel(c, config.avatar);
      watch.set(c);
      const aborted = new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([c.closed(), aborted]);
      watch.set(null);
      if (signal.aborted) {
        c.close();
        return;
      }
      log.warn("lost the VTube Studio connection");
    } catch (error) {
      client?.close();
      if (signal.aborted) return;
      failures += 1;
      const denied =
        (error instanceof ApiError && error.id === ERROR_USER_DENIED) ||
        errorMessage(error).includes("denied");
      if (denied) backoffMs = 60_000;
      if (failures === 1 || denied || failures % 20 === 0) {
        log.warn({ err: errorMessage(error) }, "VTube Studio unavailable");
      } else {
        log.debug({ err: errorMessage(error) }, "VTube Studio unavailable");
      }
    }
    try {
      await sleep(backoffMs, signal);
    } catch {
      return;
    }
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }
}

/** Warns about a different model or mappings the model does not have. */
async function checkModel(client: VtsClient, avatar: AvatarProfile): Promise<void> {
  try {
    const model = await client.currentModel();
    if (!model.loaded) log.warn("no model loaded in VTube Studio");
    else {
      log.info({ model: model.name }, "VTube Studio model");
      const want = avatar.vtsModel;
      if (want !== null && model.name.toLowerCase() !== want.toLowerCase() && model.id !== want) {
        log.warn({ loaded: model.name, expected: want }, "a different VTS model is loaded");
      }
    }
  } catch (error) {
    log.debug({ err: errorMessage(error) }, "cannot read the current VTS model");
  }
  try {
    const files = new Set((await client.expressions()).map((e) => e.file.toLowerCase()));
    for (const [emotion, action] of avatar.emotions) {
      if (action.type === "expression" && !files.has(action.file.toLowerCase())) {
        log.warn({ emotion, file: action.file }, "the model has no such expression");
      }
    }
  } catch {
    // Reported by the request itself when it matters.
  }
  try {
    const hotkeys = await client.hotkeys();
    for (const [emotion, action] of avatar.emotions) {
      if (
        action.type === "hotkey" &&
        !hotkeys.some(
          (h) => h.id === action.name || h.name.toLowerCase() === action.name.toLowerCase(),
        )
      ) {
        log.warn({ emotion, hotkey: action.name }, "the model has no such hotkey");
      }
    }
  } catch {
    // As above.
  }
}

/** Emotion, lip sync and idle motion, injected at `inject_hz`. */
class AvatarLoop {
  readonly #config: StageConfig;
  readonly #levels: Levels;
  readonly #vts: Watch<VtsClient | null>;
  readonly #clock: Clock;
  readonly #emotion: EmotionController;
  readonly #mouth: MouthShaper;
  readonly #motion: IdleMotion;
  /** Expression / hotkey requests run in order. */
  readonly #commands = new SerialQueue();
  readonly #names: string[] = [];
  #known: Set<string> | null = null;

  constructor(config: StageConfig, levels: Levels, vts: Watch<VtsClient | null>, clock: Clock) {
    this.#config = config;
    this.#levels = levels;
    this.#vts = vts;
    this.#clock = clock;
    this.#emotion = new EmotionController(
      config.avatar,
      config.vts.emotion_hold_ms,
      config.vts.after_speech_ms,
    );
    this.#mouth = new MouthShaper(config.lipsync);
    this.#motion = new IdleMotion(config.gaze);
    if (config.avatar.lipsync === "inject") {
      this.#names.push(config.avatar.mouthOpen);
      if (config.avatar.mouthForm !== null) this.#names.push(config.avatar.mouthForm);
    }
    if (config.vts.idle_motion) this.#names.push(...MOTION_PARAMS);
  }

  emotion(name: string): void {
    this.#send(this.#emotion.onEmotion(name, this.#clock.now()));
  }

  speaking(speaking: boolean): void {
    this.#emotion.setSpeaking(speaking, this.#clock.now());
    if (!speaking) this.#mouth.reset();
  }

  gaze(target: GazeTarget): void {
    this.#motion.setTarget(target);
  }

  #send(commands: VtsCommand[]): void {
    const fade = this.#config.vts.expression_fade;
    for (const cmd of commands) {
      void this.#commands.run(async () => {
        const client = this.#vts.get();
        if (!client || client.isClosed()) return;
        try {
          if (cmd.type === "expression") await client.setExpression(cmd.file, cmd.active, fade);
          else await client.triggerHotkey(cmd.name);
        } catch (error) {
          log.warn({ err: errorMessage(error), cmd }, "VTube Studio request failed");
        }
      });
    }
  }

  #onClient(client: VtsClient | null): void {
    this.#known = null;
    if (!client) return;
    this.#send(this.#emotion.rest());
    const wanted = [...this.#names];
    void client.inputParameters().then(
      (params) => {
        for (const name of wanted) {
          if (!params.has(name)) {
            log.warn(
              { parameter: name },
              "VTube Studio has no such input parameter; not injecting it",
            );
          }
        }
        if (this.#vts.get() === client) this.#known = params;
      },
      (error: unknown) =>
        log.debug({ err: errorMessage(error) }, "cannot list VTS input parameters"),
    );
  }

  run(signal: AbortSignal): Promise<void> {
    const hz = Math.min(Math.max(this.#config.vts.inject_hz, 1), 120);
    const injectMouth = this.#config.avatar.lipsync === "inject";
    const hasForm = this.#config.avatar.mouthForm !== null;
    let last = this.#clock.now();
    const unsubscribe = this.#vts.subscribe((client) => this.#onClient(client));
    this.#onClient(this.#vts.get());
    const tick = () => {
      const now = this.#clock.now();
      const dt = Math.min(Math.max(now - last, 0), 200);
      last = now;
      this.#send(this.#emotion.tick(now));
      const values: number[] = [];
      if (injectMouth) {
        const m = this.#mouth.update(this.#levels.current(now), dt);
        values.push(m.open);
        if (hasForm) values.push(m.form);
      }
      if (this.#config.vts.idle_motion) values.push(...this.#motion.update(dt));
      const client = this.#vts.get();
      if (!client || client.isClosed()) return;
      const known = this.#known;
      const batch: [string, number][] = [];
      this.#names.forEach((name, i) => {
        const v = values[i];
        if (v !== undefined && (known === null || known.has(name))) batch.push([name, v]);
      });
      client.inject(batch, this.#config.vts.face_found);
    };
    const timer = setInterval(tick, 1000 / hz);
    return new Promise<void>((resolve) => {
      const stop = () => {
        clearInterval(timer);
        unsubscribe();
        resolve();
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
  }
}
