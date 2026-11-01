// Go Live lifecycle: one stream at a time per self account (Discord allows one Go Live per user).
//
//   start() ─> starting ─(engine reports first video delivered)─> live ─> stopped | failed
//
// The manager is independent of Discord: the actual stream is an injected {@link StreamEngine} and
// the voice-channel side (make sure the voice session exists / hand it over) is an injected
// {@link GoLiveHost}. Both are faked in tests.
import type { GoLiveConfig } from "../config.js";
import type { Logger } from "../log.js";
import { noopLogger } from "../log.js";
import type { GoLiveStartMessage, GoLiveWireState } from "../protocol.js";
import { type RunProbe, resolveEncoder } from "./encoder.js";
import { type GoLivePlan, planGoLive, type ResolvedEncoder } from "./plan.js";

export interface GoLiveEvent {
  guild: string;
  state: GoLiveWireState;
  error?: string;
  reason?: string;
}

/** How the stream is attached to the Discord voice channel. */
export type Attach =
  | { kind: "hybrid"; guildId: string; channelId: string; sessionId: string }
  | { kind: "exclusive"; guildId: string; channelId: string };

export interface EngineHooks {
  /** The Go Live connection to Discord is up and video is flowing. */
  onLive(): void;
}

export interface StreamEngine {
  /**
   * Runs the stream until the source ends (resolves) or it fails (rejects). Must stop promptly when
   * `signal` aborts (the manager ignores the outcome in that case).
   */
  run(
    plan: GoLivePlan & { encoder: ResolvedEncoder },
    attach: Attach,
    hooks: EngineHooks,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface GoLiveHost {
  /** Gets the voice side ready for streaming `plan.guild` (joins the channel, or leaves it in exclusive mode). Throws a readable error. */
  attach(plan: GoLivePlan, signal: AbortSignal): Promise<Attach>;
  /** Called once the stream is over, whatever the outcome (e.g. rejoin voice in exclusive mode). */
  detach(guild: string, attach: Attach): Promise<void>;
}

export interface GoLiveManagerOptions {
  engine: StreamEngine;
  host: GoLiveHost;
  config: GoLiveConfig;
  emit: (ev: GoLiveEvent) => void;
  probeNvenc: RunProbe;
  log?: Logger;
}

interface Job {
  guild: string;
  abort: AbortController;
  state: GoLiveWireState;
  stopReason: string | undefined;
  timedOut: boolean;
  done: Promise<void>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class GoLiveManager {
  private readonly o: GoLiveManagerOptions;
  private readonly log: Logger;
  private job: Job | undefined;

  constructor(opts: GoLiveManagerOptions) {
    this.o = opts;
    this.log = opts.log ?? noopLogger;
  }

  /** The guild currently streaming (starting or live), if any. */
  get activeGuild(): string | undefined {
    return this.job?.guild;
  }

  isActive(guild: string): boolean {
    return this.job?.guild === guild;
  }

  /** The current state of the running job (for re-announcing to a reconnected Core). */
  snapshot(): GoLiveEvent | undefined {
    return this.job ? { guild: this.job.guild, state: this.job.state } : undefined;
  }

  /** Starts a stream. Never throws: problems are reported as a `failed` event. */
  start(req: GoLiveStartMessage): void {
    const { guild } = req;
    if (this.job) {
      if (this.job.guild === guild) {
        this.log.warn(`golive: already ${this.job.state} in guild ${guild}; ignoring start`);
        this.o.emit({ guild, state: this.job.state });
      } else {
        this.o.emit({ guild, state: "failed", error: `another Go Live is already running (guild ${this.job.guild}); stop it first` });
      }
      return;
    }
    const planned = planGoLive(req, this.o.config);
    if (!planned.ok) {
      this.o.emit({ guild, state: "failed", error: planned.error });
      return;
    }
    const job: Job = {
      guild,
      abort: new AbortController(),
      state: "starting",
      stopReason: undefined,
      timedOut: false,
      done: Promise.resolve(),
    };
    this.job = job;
    this.o.emit({ guild, state: "starting" });
    job.done = this.run(job, planned.plan);
  }

  /** Stops the stream in `guild` (no-op if there is none). */
  stop(guild: string, reason = "stop requested"): void {
    const job = this.job;
    if (!job || job.guild !== guild) {
      this.o.emit({ guild, state: "stopped", reason: "not streaming" });
      return;
    }
    if (job.stopReason === undefined) job.stopReason = reason;
    job.abort.abort();
  }

  /** Stops whatever runs and waits until it is fully torn down. */
  async stopAll(reason = "shutdown"): Promise<void> {
    const job = this.job;
    if (!job) return;
    if (job.stopReason === undefined) job.stopReason = reason;
    job.abort.abort();
    await job.done;
  }

  private async run(job: Job, plan: GoLivePlan): Promise<void> {
    const { signal } = job.abort;
    let attach: Attach | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let final: GoLiveEvent;
    try {
      attach = await this.o.host.attach(plan, signal);
      if (signal.aborted) throw new Error("aborted");

      const choice = await resolveEncoder(plan.encoder, this.o.probeNvenc);
      if (choice.note) this.log.warn(`golive: ${choice.note}`);
      this.log.info(
        `golive: ${plan.source} -> guild ${plan.guild} channel ${attach.channelId} ` +
          `(${attach.kind}, ${choice.encoder}, ${plan.fps} fps, ${plan.bitrateKbps} kbps)`,
      );
      if (signal.aborted) throw new Error("aborted");

      timer = setTimeout(() => {
        if (job.state === "starting") {
          job.timedOut = true;
          job.abort.abort();
        }
      }, this.o.config.startTimeoutS * 1000);
      timer.unref?.();

      await this.o.engine.run({ ...plan, encoder: choice.encoder }, attach, {
        onLive: () => {
          if (job.state !== "starting" || signal.aborted) return;
          job.state = "live";
          if (timer) clearTimeout(timer);
          this.o.emit({ guild: job.guild, state: "live" });
        },
      }, signal);

      if (signal.aborted) throw new Error("aborted");
      final =
        job.state === "live"
          ? { guild: job.guild, state: "stopped", reason: "source ended" }
          : { guild: job.guild, state: "failed", error: "the source ended before any video arrived" };
    } catch (e) {
      if (job.timedOut) {
        final = {
          guild: job.guild,
          state: "failed",
          error: `no video from the source within ${this.o.config.startTimeoutS} s`,
        };
      } else if (signal.aborted) {
        final = { guild: job.guild, state: "stopped", reason: job.stopReason ?? "stopped" };
      } else {
        const error = errMsg(e);
        this.log.warn(`golive: failed: ${error}`);
        final = { guild: job.guild, state: "failed", error };
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    job.state = final.state;
    this.job = undefined;
    this.o.emit(final);
    if (attach) {
      try {
        await this.o.host.detach(job.guild, attach);
      } catch (e) {
        this.log.warn(`golive: detach failed: ${errMsg(e)}`);
      }
    }
  }
}
