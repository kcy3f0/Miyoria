// On-demand VLM vision policy: captures a compressed JPEG only on explicit `inspect`
// (`forceNext`), recent task failure or stuck reflex, biome/dimension changes, moving >= 48
// blocks since the last capture, or newly spotted players / structures, gated by a cooldown.

import type { BridgeEvent } from "./bridge.js";
import type { Snapshot } from "./summary.js";

export interface CapturedScreenshot {
  mime: string;
  data: string;
  detail?: "low" | "auto" | "high";
  alt?: string;
}

export interface VisionOptions {
  enabled?: boolean;
  cooldownMs?: number;
  maxWidth?: number;
  quality?: number;
  moveDistance?: number;
  now?: () => number;
}

export interface CaptureDecision {
  capture: boolean;
  reason?: string;
  forced?: boolean;
}

const DEFAULT_COOLDOWN_MS = 15_000;
const DEFAULT_MAX_WIDTH = 512;
const DEFAULT_QUALITY = 0.65;
const DEFAULT_MOVE_DISTANCE = 48;

const STRUCTURE_BLOCKS = new Set([
  "chest",
  "trapped_chest",
  "barrel",
  "ender_chest",
  "spawner",
  "nether_portal",
  "end_portal",
  "end_portal_frame",
  "enchanting_table",
  "brewing_stand",
  "bell",
  "lectern",
  "beacon",
  "anvil",
  "respawn_anchor",
  "lodestone",
]);

const STUCK_OR_DANGER_REFLEXES = new Set([
  "unstuck",
  "suffocation",
  "lava",
  "falling_block",
  "retreat_pillar",
  "mlg_water",
]);

const FAILURE_EVENTS = new Set([
  "task_failed",
  "goal_failed",
  "craft_failed",
  "smelt_failed",
  "branch_failed",
  "hunt_failed",
  "sleep_failed",
  "chest_failed",
  "reflex_aborted",
]);

interface Pos {
  x: number;
  y: number;
  z: number;
}

function posOf(s: Snapshot): Pos | undefined {
  const p = s.block_position ?? s.position;
  if (!p) return undefined;
  return { x: p.x, y: p.y, z: p.z };
}

function distance(a: Pos, b: Pos): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class ScreenshotPolicy {
  readonly #enabled: boolean;
  readonly #cooldownMs: number;
  readonly #maxWidth: number;
  readonly #quality: number;
  readonly #moveDistance: number;
  readonly #now: () => number;

  #forceNext: { reason?: string } | null = null;
  #recentFailure: string | null = null;
  #lastCaptureAt: number | null = null;
  #anchorPos: Pos | undefined;
  #anchorBiome: string | undefined;
  #anchorDimension: string | undefined;
  #baselineSet = false;
  readonly #seenPlayers = new Set<string>();
  readonly #seenStructures = new Set<string>();

  constructor(opts: VisionOptions = {}) {
    this.#enabled = opts.enabled ?? true;
    this.#cooldownMs = Math.max(0, opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.#maxWidth = Math.min(1920, Math.max(64, Math.round(opts.maxWidth ?? DEFAULT_MAX_WIDTH)));
    this.#quality = Math.min(1, Math.max(0.1, opts.quality ?? DEFAULT_QUALITY));
    this.#moveDistance = Math.max(1, opts.moveDistance ?? DEFAULT_MOVE_DISTANCE);
    this.#now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Requests an immediate screenshot on the next `observe` (bypasses cooldown). */
  forceNext(reason?: string): void {
    this.#forceNext = { reason };
  }

  /** Records a recent task failure so the next eligible `observe` captures context. */
  noteFailure(reason: string): void {
    this.#recentFailure = reason;
  }

  /** Tracks mod events that indicate failure or a stuck/danger reflex. */
  noteEvent(e: BridgeEvent): void {
    if (FAILURE_EVENTS.has(e.name)) {
      this.#recentFailure = e.name;
      return;
    }
    if (e.name === "reflex") {
      const kind = typeof e.data.kind === "string" ? e.data.kind : "";
      if (STUCK_OR_DANGER_REFLEXES.has(kind)) this.#recentFailure = `reflex:${kind}`;
    }
  }

  /** Resets anchor & seen sets when reconnecting to a fresh session. */
  reset(): void {
    this.#forceNext = null;
    this.#recentFailure = null;
    this.#lastCaptureAt = null;
    this.#anchorPos = undefined;
    this.#anchorBiome = undefined;
    this.#anchorDimension = undefined;
    this.#baselineSet = false;
    this.#seenPlayers.clear();
    this.#seenStructures.clear();
  }

  /** Evaluates whether `snapshot` warrants capturing a screenshot right now. */
  evaluate(snapshot: Snapshot, capabilitySupported = true): CaptureDecision {
    if (!this.#enabled || !capabilitySupported) return { capture: false };

    const pos = posOf(snapshot);
    if (!this.#baselineSet) {
      this.#baselineSet = true;
      if (pos) this.#anchorPos = pos;
      if (snapshot.biome) this.#anchorBiome = snapshot.biome;
      if (snapshot.dimension) this.#anchorDimension = snapshot.dimension;
    }

    if (this.#forceNext !== null) {
      return { capture: true, reason: this.#forceNext.reason || "主動查看周圍畫面", forced: true };
    }

    const now = this.#now();
    if (this.#lastCaptureAt !== null && now - this.#lastCaptureAt < this.#cooldownMs) {
      return { capture: false };
    }

    if (this.#recentFailure) {
      return { capture: true, reason: `動作受阻或異常 (${this.#recentFailure})` };
    }

    if (snapshot.dimension && this.#anchorDimension && snapshot.dimension !== this.#anchorDimension) {
      return { capture: true, reason: `切換維度至 ${snapshot.dimension}` };
    }

    if (snapshot.biome && this.#anchorBiome && snapshot.biome !== this.#anchorBiome) {
      return { capture: true, reason: `進入新地形 ${snapshot.biome}` };
    }

    if (pos && this.#anchorPos && distance(pos, this.#anchorPos) >= this.#moveDistance) {
      return { capture: true, reason: `移動超過 ${this.#moveDistance} 格` };
    }

    const currentPlayers = new Set<string>();
    for (const e of snapshot.nearby_entities ?? []) {
      if (e.type === "player") currentPlayers.add(e.name ?? "__player__");
    }
    for (const p of [...this.#seenPlayers]) {
      if (!currentPlayers.has(p)) this.#seenPlayers.delete(p);
    }
    for (const p of currentPlayers) {
      if (!this.#seenPlayers.has(p)) {
        return { capture: true, reason: p === "__player__" ? "附近出現其他玩家" : `附近出現玩家 ${p}` };
      }
    }

    for (const b of snapshot.nearby_blocks ?? []) {
      if (!STRUCTURE_BLOCKS.has(b.block)) continue;
      const key = b.nearest
        ? `${b.block}@${Math.round(b.nearest.x)},${Math.round(b.nearest.y)},${Math.round(b.nearest.z)}`
        : b.block;
      if (!this.#seenStructures.has(key)) {
        return { capture: true, reason: `發現結構方塊 ${b.block}` };
      }
    }

    return { capture: false };
  }

  /** Marks observed players/structures and updates anchors after a capture attempt. */
  #commit(snapshot: Snapshot, captured: boolean): void {
    this.#forceNext = null;
    this.#lastCaptureAt = this.#now();
    this.#recentFailure = null;
    if (!captured) return;
    const pos = posOf(snapshot);
    if (pos) this.#anchorPos = pos;
    if (snapshot.biome) this.#anchorBiome = snapshot.biome;
    if (snapshot.dimension) this.#anchorDimension = snapshot.dimension;
    for (const e of snapshot.nearby_entities ?? []) {
      if (e.type === "player") this.#seenPlayers.add(e.name ?? "__player__");
    }
    for (const b of snapshot.nearby_blocks ?? []) {
      if (!STRUCTURE_BLOCKS.has(b.block)) continue;
      const key = b.nearest
        ? `${b.block}@${Math.round(b.nearest.x)},${Math.round(b.nearest.y)},${Math.round(b.nearest.z)}`
        : b.block;
      this.#seenStructures.add(key);
    }
  }

  /**
   * Captures a compressed JPEG via `request("screenshot", ...)` when policy triggers.
   * Falls back cleanly to `undefined` (text-only observation) on failure or unsupported mod.
   */
  async maybeCapture(
    snapshot: Snapshot,
    request: (type: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
    capabilitySupported = true,
  ): Promise<CapturedScreenshot | undefined> {
    const decision = this.evaluate(snapshot, capabilitySupported);
    if (!decision.capture) return undefined;
    try {
      const res = await request("screenshot", {
        max_width: this.#maxWidth,
        format: "jpeg",
        quality: this.#quality,
      });
      const data = typeof res.data_base64 === "string" ? res.data_base64 : "";
      if (!data) {
        this.#commit(snapshot, false);
        return undefined;
      }
      const mime = typeof res.mime === "string" && res.mime.startsWith("image/") ? res.mime : "image/jpeg";
      this.#commit(snapshot, true);
      return {
        mime,
        data,
        detail: decision.forced ? "high" : "low",
        ...(decision.reason ? { alt: decision.reason } : {}),
      };
    } catch {
      // Never fail `observe` because screenshot encoding or render thread failed.
      this.#commit(snapshot, false);
      return undefined;
    }
  }
}
