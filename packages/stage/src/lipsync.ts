// Lip sync: playback levels from the voice node → `MouthOpen` / `MouthSmile`.
//
// Both are VTube Studio tracking parameters in 0..1; VTS maps them to the model's
// `ParamMouthOpenY` / `ParamMouthForm` (where 0.5 is a neutral mouth).
//
// The voice node streams `{"t": <ms>, "rms": 0..1}` to `ws://127.0.0.1:7883/levels` while she
// speaks. `Levels` keeps the most recent samples (optionally delayed to line up with audio
// latency) and `MouthShaper` turns them into smoothed mouth parameters.

import { errorMessage, getLogger } from "@miyoria/kernel";
import { type Clock, systemClock } from "@miyoria/types";
import { z } from "zod";
import { type BoundAddress, formatAddress, HttpServer } from "./net.js";
import { parseLevelFrame } from "./protocol.js";

const log = getLogger("stage.lipsync");

/** `[lipsync]` section of the Stage config. */
export const LipSyncConfigSchema = z.object({
  /** Levels endpoint address. */
  bind: z.string().default("127.0.0.1:7883"),
  /** RMS below this counts as silence. */
  gate: z.number().default(0.015),
  /** Mouth opening per unit of RMS above the gate. */
  gain: z.number().default(5.0),
  /** Opening time constant (ms). */
  attack_ms: z.number().default(35),
  /** Closing time constant (ms). */
  release_ms: z.number().default(110),
  /** Largest opening (0..1). */
  max_open: z.number().default(1.0),
  /** Resting mouth shape (0..1, 0.5 = neutral). */
  form_base: z.number().default(0.5),
  /** How far the mouth shape wanders while talking. */
  form_variation: z.number().default(0.175),
  /** Delay applied to incoming levels (audio output latency). */
  latency_ms: z.number().int().nonnegative().default(0),
  /** Without new levels for this long the mouth closes. */
  stale_ms: z.number().int().nonnegative().default(150),
});
export type LipSyncConfig = z.output<typeof LipSyncConfigSchema>;

export function defaultLipSyncConfig(): LipSyncConfig {
  return LipSyncConfigSchema.parse({});
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Attack / release smoothing with a noise gate and gain. */
export class Envelope {
  readonly #gate: number;
  readonly #gain: number;
  readonly #max: number;
  readonly #attack: number;
  readonly #release: number;
  #value = 0;

  constructor(config: LipSyncConfig) {
    this.#gate = Math.max(config.gate, 0);
    this.#gain = Math.max(config.gain, 0);
    this.#max = clamp(config.max_open, 0, 1);
    this.#attack = Math.max(config.attack_ms, 1) / 1000;
    this.#release = Math.max(config.release_ms, 1) / 1000;
  }

  /** Target opening for one RMS value, before smoothing. */
  target(rms: number): number {
    if (!Number.isFinite(rms) || rms <= this.#gate) return 0;
    return clamp((rms - this.#gate) * this.#gain, 0, this.#max);
  }

  /** Advances by `dtMs` towards the target of `rms`. */
  update(rms: number, dtMs: number): number {
    const target = this.target(rms);
    const tau = target > this.#value ? this.#attack : this.#release;
    const a = 1 - Math.exp(-dtMs / 1000 / tau);
    this.#value += (target - this.#value) * a;
    if (this.#value < 1e-3) this.#value = 0;
    return this.#value;
  }

  value(): number {
    return this.#value;
  }

  reset(): void {
    this.#value = 0;
  }
}

/** Mouth parameters for one frame. */
export interface Mouth {
  open: number;
  form: number;
}

/**
 * `Envelope` for the opening plus a slow wander of the mouth shape that follows how open the
 * mouth is.
 */
export class MouthShaper {
  readonly #envelope: Envelope;
  readonly #formBase: number;
  readonly #formVariation: number;
  #phase = 0;

  constructor(config: LipSyncConfig) {
    this.#envelope = new Envelope(config);
    this.#formBase = clamp(config.form_base, 0, 1);
    this.#formVariation = clamp(config.form_variation, 0, 1);
  }

  update(rms: number, dtMs: number): Mouth {
    const open = this.#envelope.update(rms, dtMs);
    // The shape changes faster while the mouth moves a lot.
    this.#phase += (dtMs / 1000) * (1.5 + 6 * open);
    const wander = 0.6 * Math.sin(this.#phase * 1.7) + 0.4 * Math.sin(this.#phase * 4.3 + 1);
    const form = clamp(this.#formBase + this.#formVariation * wander * Math.min(open, 1), 0, 1);
    return { open, form };
  }

  reset(): Mouth {
    this.#envelope.reset();
    return { open: 0, form: this.#formBase };
  }
}

/** Recent level samples, shared between the levels endpoint and the injection loop. */
export class Levels {
  readonly #delayMs: number;
  readonly #staleMs: number;
  /** `[due, rms]`, oldest first. */
  #queue: [number, number][] = [];
  #last: [number, number] | null = null;

  constructor(config: LipSyncConfig) {
    this.#delayMs = config.latency_ms;
    this.#staleMs = Math.max(config.stale_ms, 1);
  }

  /** Records one sample received at `now` (clock ms). */
  push(rms: number, now: number): void {
    const v = Number.isFinite(rms) ? clamp(rms, 0, 1) : 0;
    this.#queue.push([now + this.#delayMs, v]);
    // About 2 s at 10 ms per sample.
    if (this.#queue.length > 200) this.#queue.splice(0, this.#queue.length - 200);
  }

  /** Forgets everything (playback stopped). */
  clear(): void {
    this.#queue = [];
    this.#last = null;
  }

  /** The level to show at `now`: the newest due sample, or 0 once stale. */
  current(now: number): number {
    let i = 0;
    while (i < this.#queue.length) {
      const sample = this.#queue[i] as [number, number];
      if (sample[0] > now) break;
      this.#last = sample;
      i++;
    }
    if (i > 0) this.#queue.splice(0, i);
    const last = this.#last;
    return last && Math.max(now - last[0], 0) <= this.#staleMs ? last[1] : 0;
  }
}

export interface ServeResult {
  addr: BoundAddress;
  /** Settles once the server stopped (after `signal` aborted). */
  done: Promise<void>;
}

/** Serves `GET /levels` (WebSocket) on `bind` until `signal` aborts. */
export async function serveLevels(
  bind: string,
  levels: Levels,
  signal: AbortSignal,
  clock: Clock = systemClock,
): Promise<ServeResult> {
  const server = await HttpServer.listen(bind, "the lip-sync levels endpoint", {
    ws: [
      {
        path: "/levels",
        maxPayload: 1 << 16,
        onConnection(ws) {
          log.debug("levels client connected");
          ws.on("message", (data, isBinary) => {
            if (isBinary) return;
            try {
              const frame = parseLevelFrame(JSON.parse(data.toString()));
              levels.push(frame.rms, clock.now());
            } catch (error) {
              log.debug({ err: errorMessage(error) }, "invalid level frame");
            }
          });
          ws.on("close", () => log.debug("levels client disconnected"));
          ws.on("error", () => {});
        },
      },
    ],
  });
  log.info({ addr: formatAddress(server.address) }, "lip-sync levels endpoint listening");
  return { addr: server.address, done: closeOnAbort(server, signal) };
}

/** Closes `server` once `signal` aborts. */
export function closeOnAbort(server: HttpServer, signal: AbortSignal, graceMs = 0): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = () => {
      void server.close(graceMs).then(resolve);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}
