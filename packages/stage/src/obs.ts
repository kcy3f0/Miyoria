// OBS control (obs-websocket v5 via `obs-websocket-js`), behind `Obs` so it can be faked in
// tests.

import { errorMessage, getLogger, sleep } from "@miyoria/kernel";
import OBSWebSocket from "obs-websocket-js/json";
import { z } from "zod";
import type { StreamAction } from "./protocol.js";
import { Watch } from "./watch.js";

const log = getLogger("stage.obs");

/** `[obs]` section of the Stage config. */
export const ObsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65_535).default(4455),
  /** obs-websocket password (empty when authentication is off). */
  password: z.string().default(""),
  /** Text source that shows her subtitles (none by default). */
  subtitle_source: z.string().nullable().default(null),
  /** Clear the subtitle source this long after the final text; 0 keeps it. */
  subtitle_clear_ms: z.number().int().nonnegative().default(6_000),
  /** Status poll interval. */
  poll_ms: z.number().int().nonnegative().default(2_000),
  /** How long `stream start / stop` waits for OBS to change state. */
  stream_wait_ms: z.number().int().nonnegative().default(15_000),
});
export type ObsConfig = z.output<typeof ObsConfigSchema>;

/** The OBS operations the Stage needs. */
export interface Obs {
  currentScene(): Promise<string>;
  setScene(name: string): Promise<void>;
  streaming(): Promise<boolean>;
  startStream(): Promise<void>;
  stopStream(): Promise<void>;
  /** Sets the `text` setting of a text source. */
  setText(source: string, text: string): Promise<void>;
  /** Drops the connection (optional). */
  close?(): Promise<void>;
}

/** Opens `Obs` connections. */
export interface ObsConnector {
  connect(): Promise<Obs>;
}

export class ObsError extends Error {
  override readonly name = "ObsError";
}

/** Connects with `obs-websocket-js`. */
export class ObsWebSocketConnector implements ObsConnector {
  readonly host: string;
  readonly port: number;
  readonly #password: string | null;

  constructor(options: { host: string; port: number; password?: string | null }) {
    this.host = options.host;
    this.port = options.port;
    this.#password = options.password ? options.password : null;
  }

  static fromConfig(config: ObsConfig): ObsWebSocketConnector {
    return new ObsWebSocketConnector(config);
  }

  async connect(): Promise<Obs> {
    const client = new OBSWebSocket();
    // Without a listener EventEmitter3 drops errors anyway; keep them out of the log noise.
    client.on("ConnectionError", () => {});
    try {
      await client.connect(`ws://${this.host}:${this.port}`, this.#password ?? undefined);
    } catch (error) {
      throw new ObsError(
        `cannot connect to OBS at ${this.host}:${this.port}: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    return new ObsWebSocketObs(client);
  }

  toJSON(): { host: string; port: number } {
    // Never the password.
    return { host: this.host, port: this.port };
  }
}

class ObsWebSocketObs implements Obs {
  readonly #client: OBSWebSocket;

  constructor(client: OBSWebSocket) {
    this.#client = client;
  }

  async currentScene(): Promise<string> {
    const r = await this.#client.call("GetCurrentProgramScene");
    return r.sceneName ?? r.currentProgramSceneName;
  }

  async setScene(name: string): Promise<void> {
    await this.#client.call("SetCurrentProgramScene", { sceneName: name });
  }

  async streaming(): Promise<boolean> {
    return (await this.#client.call("GetStreamStatus")).outputActive;
  }

  async startStream(): Promise<void> {
    await this.#client.call("StartStream");
  }

  async stopStream(): Promise<void> {
    await this.#client.call("StopStream");
  }

  async setText(source: string, text: string): Promise<void> {
    await this.#client.call("SetInputSettings", {
      inputName: source,
      inputSettings: { text },
      overlay: true,
    });
  }

  async close(): Promise<void> {
    await this.#client.disconnect();
  }
}

/** What the Stage knows about OBS. */
export interface ObsState {
  connected: boolean;
  scene: string | null;
  streaming: boolean;
}

export function defaultObsState(): ObsState {
  return { connected: false, scene: null, streaming: false };
}

function sameObsState(a: ObsState, b: ObsState): boolean {
  return a.connected === b.connected && a.scene === b.scene && a.streaming === b.streaming;
}

/** Keeps one OBS connection (reconnecting with backoff), polls its state and runs commands. */
export class ObsController {
  readonly #connector: ObsConnector;
  readonly #config: ObsConfig;
  #current: Obs | null = null;
  readonly #state = new Watch<ObsState>(defaultObsState(), sameObsState);
  #subtitleGeneration = 0;
  readonly #clearTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(connector: ObsConnector, config: ObsConfig) {
    this.#connector = connector;
    this.#config = config;
  }

  state(): ObsState {
    return this.#state.get();
  }

  /** Calls `listener` whenever the state changes; returns the unsubscribe function. */
  subscribe(listener: (state: ObsState) => void): () => void {
    return this.#state.subscribe(listener);
  }

  #obs(): Obs {
    if (!this.#current) throw new ObsError("OBS is not connected");
    return this.#current;
  }

  /** Connection loop; returns when `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    let backoffMs = 1_000;
    const pollMs = Math.max(this.#config.poll_ms, 100);
    try {
      while (!signal.aborted) {
        let obs: Obs | null = null;
        try {
          obs = await this.#connector.connect();
        } catch (error) {
          log.debug({ err: errorMessage(error) }, "OBS not reachable");
        }
        if (obs) {
          log.info("connected to OBS");
          backoffMs = 1_000;
          this.#current = obs;
          while (!signal.aborted) {
            try {
              await this.refresh();
            } catch (error) {
              log.warn({ err: errorMessage(error) }, "lost the OBS connection");
              break;
            }
            if (!(await pause(pollMs, signal))) break;
          }
          this.#current = null;
          this.#state.set(defaultObsState());
          await obs.close?.().catch(() => undefined);
        }
        if (!(await pause(backoffMs, signal))) return;
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    } finally {
      for (const timer of this.#clearTimers) clearTimeout(timer);
      this.#clearTimers.clear();
    }
  }

  /** Reads scene and streaming state. */
  async refresh(): Promise<ObsState> {
    const obs = this.#obs();
    const scene = await obs.currentScene();
    const streaming = await obs.streaming();
    const state: ObsState = { connected: true, scene, streaming };
    this.#state.set(state);
    return state;
  }

  async setScene(name: string): Promise<ObsState> {
    await this.#obs().setScene(name);
    return this.refresh();
  }

  /** Starts / stops streaming and waits (up to `stream_wait_ms`) for OBS to report it. */
  async stream(action: StreamAction): Promise<ObsState> {
    const obs = this.#obs();
    const want = action === "start";
    if ((await obs.streaming()) !== want) {
      if (want) await obs.startStream();
      else await obs.stopStream();
    }
    const deadline = Date.now() + Math.max(this.#config.stream_wait_ms, 1);
    for (;;) {
      const state = await this.refresh();
      if (state.streaming === want || Date.now() >= deadline) return state;
      await sleep(250);
    }
  }

  /**
   * Shows `text` in the subtitle source (when configured); a final text is cleared after
   * `subtitle_clear_ms`.
   */
  async subtitle(text: string, isFinal: boolean): Promise<void> {
    const source = this.#config.subtitle_source;
    if (source === null) return;
    const generation = ++this.#subtitleGeneration;
    const obs = this.#current;
    if (!obs) return;
    try {
      await obs.setText(source, text);
    } catch (error) {
      log.warn({ err: errorMessage(error), source }, "cannot update the subtitle source");
      return;
    }
    if (isFinal && this.#config.subtitle_clear_ms > 0) {
      const timer = setTimeout(() => {
        this.#clearTimers.delete(timer);
        if (this.#subtitleGeneration !== generation) return;
        const current = this.#current;
        if (current) void current.setText(source, "").catch(() => undefined);
      }, this.#config.subtitle_clear_ms);
      this.#clearTimers.add(timer);
    }
  }
}

/** Sleeps `ms`; false when `signal` aborted. */
async function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await sleep(ms, signal);
    return true;
  } catch {
    return false;
  }
}
