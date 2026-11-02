// The scene director: switches OBS to the scene of her current situation.
//
//   going live           → starting (for `starting_ms`), then chat
//   a game starts        → game;  the game stops → chat
//   live, nobody talking for `brb_after_ms`, or she left voice → brb (back when it ends)
//   the stream is ending → ending (held `ending_ms` before the stream stops, see `close`)
//
// It only reacts to changes (it never "corrects" the scene at boot), coalesces changes within
// `debounce_ms`, keeps `min_switch_ms` between switches and stays out of the way for
// `manual_hold_ms` after someone else switched (the owner in OBS, a command, the panel or her own
// `stage_scene`). Starting and ending are urgent: they skip the waits. Every switch is a
// `stage.scene` request through the gate (principal `director`), so pausing her autonomy also
// pauses the director.

import { getLogger, sleep } from "@miyoria/kernel";
import { type Clock, type StreamCurtain, systemClock } from "@miyoria/types";
import type { SceneRoles, ScenesConfig } from "./scenes.js";

const log = getLogger("stage.director");

/** `voice.golive` states. */
export type GoLiveState = "starting" | "live" | "stopped" | "failed";

/** Asks the gate to switch to `role`'s scene; resolves whether it switched. */
export type RoleSwitcher = (role: string, why: string) => Promise<boolean>;

export interface SceneDirectorDeps {
  config: ScenesConfig;
  roles: SceneRoles;
  switchRole: RoleSwitcher;
  clock?: Clock;
}

/** Why a role is wanted (for the log and the audit `why`). */
interface Want {
  role: string;
  why: string;
  /** Skips the debounce, the minimum interval and the manual hold. */
  urgent: boolean;
}

/** Roles that fall back to another one when they have no scene. */
const FALLBACK: Readonly<Record<string, string>> = { starting: "chat" };

export class SceneDirector implements StreamCurtain {
  readonly #config: ScenesConfig;
  readonly #roles: SceneRoles;
  readonly #switchRole: RoleSwitcher;
  readonly #clock: Clock;

  readonly #golive = new Map<string, GoLiveState>();
  #obsStreaming = false;
  #playing = false;
  readonly #voices = new Set<string>();
  /** She was in voice at some point of this live session. */
  #voiceThisLive = false;
  #lastActivity: number;
  #startingUntil = 0;
  /** The stream ended (or is ending): hold the ending scene until something new happens. */
  #ended = false;
  #endingUntil = 0;

  #scene: string | null = null;
  /** The scene of the switch in flight, to tell her own switches from manual ones. */
  #expect: string | null = null;
  #lastSwitch = Number.NEGATIVE_INFINITY;
  #manualUntil = 0;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #due: number | null = null;
  #urgent = false;
  #busy = false;
  #again = false;
  #closed = false;

  constructor(deps: SceneDirectorDeps) {
    this.#config = deps.config;
    this.#roles = deps.roles;
    this.#switchRole = deps.switchRole;
    this.#clock = deps.clock ?? systemClock;
    this.#lastActivity = this.#now();
  }

  #now(): number {
    return this.#clock.now();
  }

  /** Streaming in OBS or live on Discord (or about to be). */
  live(): boolean {
    if (this.#obsStreaming) return true;
    for (const state of this.#golive.values())
      if (state === "starting" || state === "live") return true;
    return false;
  }

  /** The role she should be in now, `null` = leave the scene alone. */
  desired(): Want | null {
    const now = this.#now();
    const live = this.live();
    if (this.#ended && (!live || now < this.#endingUntil)) {
      return { role: "ending", why: "直播結束", urgent: true };
    }
    if (!live && this.#config.only_while_live) return null;
    if (live && now < this.#startingUntil) return { role: "starting", why: "開台", urgent: true };
    if (this.#away(now))
      return { role: "brb", why: "暫時沒有人在講話或她離開了語音", urgent: false };
    if (this.#playing) return { role: "game", why: "開始玩遊戲", urgent: false };
    return { role: "chat", why: "回到聊天", urgent: false };
  }

  #away(now: number): boolean {
    if (!this.live() || this.#playing) return false;
    if (this.#config.brb_on_voice_leave && this.#voiceThisLive && this.#voices.size === 0)
      return true;
    const after = this.#config.brb_after_ms;
    return after > 0 && now - this.#lastActivity >= after;
  }

  // ----- inputs -----

  /** `voice.golive` for `guild`. */
  onGoLive(guild: string, state: GoLiveState): void {
    const was = this.live();
    if (state === "stopped" || state === "failed") this.#golive.delete(guild);
    else this.#golive.set(guild, state);
    this.#liveChanged(was);
  }

  /**
   * A stage status (`null`: the node is gone). Without OBS the streaming state is unknown, so it
   * is left as it was (a lost connection is not the end of the stream).
   */
  onStatus(status: { obs: boolean; streaming: boolean; scene: string | null } | null): void {
    if (status === null || !status.obs) {
      // The next scene seen after a reconnect is not a manual switch.
      this.#scene = null;
      return;
    }
    const was = this.live();
    this.#obsStreaming = status.streaming;
    this.#liveChanged(was);
    const scene = status.scene;
    if (scene === null || scene === this.#scene) {
      if (scene !== null && scene === this.#expect) this.#expect = null;
      return;
    }
    const first = this.#scene === null;
    this.#scene = scene;
    if (scene === this.#expect) {
      this.#expect = null;
    } else if (!first) {
      // Someone else switched: stay out of the way for a while.
      this.#manualUntil = this.#now() + this.#config.manual_hold_ms;
      log.debug({ scene }, "scene switched by someone else; holding");
    }
  }

  /** A game session started or stopped. */
  onGame(playing: boolean): void {
    if (this.#playing === playing) return;
    this.#playing = playing;
    this.#ended = false;
    this.#activity();
    this.#schedule(false);
  }

  /** Her voice node joined (`true`) or left (`false`) voice channel `id`. */
  onVoice(id: string, joined: boolean): void {
    const before = this.#voices.size;
    if (joined) this.#voices.add(id);
    else this.#voices.delete(id);
    if (joined && this.live()) this.#voiceThisLive = true;
    if ((before === 0) !== (this.#voices.size === 0)) {
      this.#activity();
      this.#schedule(false);
    }
  }

  /** Someone talked (her speech, an utterance, a finished turn). */
  onActivity(): void {
    const wasAway = this.#away(this.#now());
    this.#activity();
    if (wasAway) this.#schedule(false);
  }

  #activity(): void {
    this.#lastActivity = this.#now();
  }

  #liveChanged(was: boolean): void {
    const live = this.live();
    if (was === live) return;
    const now = this.#now();
    if (live) {
      log.info("stream went live");
      this.#ended = false;
      this.#startingUntil = now + this.#config.starting_ms;
      this.#manualUntil = 0;
      this.#voiceThisLive = this.#voices.size > 0;
      this.#activity();
      this.#schedule(true);
    } else {
      log.info("stream ended");
      if (!this.#ended) this.#endingUntil = now + this.#config.ending_ms;
      this.#ended = true;
      this.#startingUntil = 0;
      this.#schedule(true);
    }
  }

  // ----- the curtain -----

  /**
   * `StreamCurtain`: before the stream stops, switch to the ending scene and hold it for
   * `ending_ms`. Resolves at once when not live, without an ending scene or when the switch was
   * refused. Never throws.
   */
  async close(signal?: AbortSignal): Promise<void> {
    if (this.#closed || !this.live() || this.#ended) return;
    this.#ended = true;
    this.#endingUntil = this.#now() + this.#config.ending_ms;
    const scene = this.#roles.resolve("ending");
    if (scene === null || this.#config.ending_ms <= 0) return;
    let switched = scene === this.#scene;
    if (!switched) {
      this.#expect = scene;
      try {
        switched = await this.#switchRole("ending", "直播要結束了");
      } catch (error) {
        log.warn({ err: String(error) }, "cannot switch to the ending scene");
        switched = false;
      }
      if (!switched) this.#expect = null;
      else this.#lastSwitch = this.#now();
    }
    if (!switched) return;
    try {
      await sleep(this.#config.ending_ms, signal);
    } catch {
      // Aborted: stop now.
    }
  }

  // ----- evaluation -----

  /** Evaluates after the debounce (at once when `urgent`). */
  #schedule(urgent: boolean): void {
    if (this.#closed || !this.#config.director) return;
    this.#urgent ||= urgent;
    this.#wake(urgent ? 0 : this.#config.debounce_ms);
  }

  #wake(delayMs: number): void {
    const at = this.#now() + Math.max(delayMs, 0);
    if (this.#timer !== null && this.#due !== null && this.#due <= at) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#due = at;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#due = null;
        void this.#evaluate();
      },
      Math.max(delayMs, 0),
    );
    this.#timer.unref?.();
  }

  async #evaluate(): Promise<void> {
    if (this.#closed) return;
    if (this.#busy) {
      this.#again = true;
      return;
    }
    this.#busy = true;
    try {
      do {
        this.#again = false;
        await this.#step();
      } while (this.#again && !this.#closed);
    } finally {
      this.#busy = false;
      this.#planNext();
    }
  }

  async #step(): Promise<void> {
    const urgentRequest = this.#urgent;
    this.#urgent = false;
    const want = this.desired();
    if (want === null) return;
    let role = want.role;
    let scene = this.#roles.resolve(role);
    const fallback = FALLBACK[role];
    if (scene === null && fallback !== undefined) {
      role = fallback;
      scene = this.#roles.resolve(role);
    }
    if (scene === null || scene === this.#scene) return;
    const now = this.#now();
    const urgent = want.urgent && urgentRequest;
    if (!urgent && now < this.#manualUntil) {
      this.#wake(this.#manualUntil - now);
      return;
    }
    const gap = this.#lastSwitch + this.#config.min_switch_ms - now;
    if (!urgent && gap > 0) {
      this.#wake(gap);
      return;
    }
    this.#expect = scene;
    this.#lastSwitch = now;
    let switched = false;
    try {
      switched = await this.#switchRole(role, want.why);
    } catch (error) {
      log.warn({ err: String(error), role }, "scene switch failed");
    }
    if (switched) {
      log.info({ role, scene, why: want.why }, "switched the scene");
      this.#scene = scene;
    } else {
      this.#expect = null;
    }
  }

  /** Wakes up for the next time-based change (end of starting, silence → brb). */
  #planNext(): void {
    if (this.#closed || !this.#config.director || !this.live()) return;
    const now = this.#now();
    const times: number[] = [];
    if (this.#startingUntil > now) times.push(this.#startingUntil);
    if (this.#ended && this.#endingUntil > now) times.push(this.#endingUntil);
    const after = this.#config.brb_after_ms;
    if (after > 0 && !this.#playing && !this.#away(now)) times.push(this.#lastActivity + after);
    if (times.length === 0) return;
    this.#wake(Math.min(...times) - now);
  }

  /** Stops all timers (module stop). */
  stop(): void {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#due = null;
  }
}
