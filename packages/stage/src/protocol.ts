// Stage Link v1 wire format (`docs/protocols/stage-link.md`).

import { z } from "zod";

export const VERSION = 1;

/** Close codes used by Core. */
export const CLOSE = {
  /** Malformed hello, unsupported version or no hello in time. */
  BAD_HELLO: 4400,
  /** Wrong token. */
  UNAUTHORIZED: 4401,
  /** Dead peer (no traffic within the heartbeat timeout). */
  TIMEOUT: 4408,
  /** A newer Stage connection replaced this one. */
  REPLACED: 4409,
  /** Core is shutting down. */
  GOING_AWAY: 1001,
} as const;

/** `stream` actions. */
export type StreamAction = "start" | "stop";
export const StreamActionSchema = z.enum(["start", "stop"]);

/** Where she looks. Default `camera`. */
export type GazeTarget = "chat" | "game" | "camera";
export const GazeTargetSchema = z.enum(["chat", "game", "camera"]);

export function parseGazeTarget(s: string): GazeTarget | null {
  const v = s.trim().toLowerCase();
  return v === "chat" || v === "game" || v === "camera" ? v : null;
}

/** `speaking` states. */
export type SpeakingState = "started" | "stopped";
export const SpeakingStateSchema = z.enum(["started", "stopped"]);

/** What the Stage node reports in `status`. */
export interface StageStatus {
  /** Connected and authenticated to VTube Studio. */
  vts: boolean;
  /** Connected to OBS. */
  obs: boolean;
  /** Current OBS program scene. */
  scene: string | null;
  /** OBS is streaming. */
  streaming: boolean;
  /** OBS scene names, top of OBS's scene list first. */
  scenes: string[];
  /** Hotkey names of the model loaded in VTube Studio. */
  hotkeys: string[];
  /** URL of the node's overlay page (an OBS browser source), if it serves one. */
  overlay_url: string | null;
}

export function defaultStageStatus(): StageStatus {
  return {
    vts: false,
    obs: false,
    scene: null,
    streaming: false,
    scenes: [],
    hotkeys: [],
    overlay_url: null,
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function sameStatus(a: StageStatus | null, b: StageStatus | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.vts === b.vts &&
    a.obs === b.obs &&
    a.scene === b.scene &&
    a.streaming === b.streaming &&
    a.overlay_url === b.overlay_url &&
    sameList(a.scenes, b.scenes) &&
    sameList(a.hotkeys, b.hotkeys)
  );
}

const requestId = z
  .number()
  .int()
  .nonnegative()
  .max(0xffff_ffff)
  .nullish()
  .transform((v) => v ?? undefined);

const StageStatusFields = {
  vts: z.boolean().default(false),
  obs: z.boolean().default(false),
  scene: z.string().nullable().default(null),
  streaming: z.boolean().default(false),
  // Added after v1 shipped; older nodes leave them out.
  scenes: z.array(z.string()).default([]),
  hotkeys: z.array(z.string()).default([]),
  overlay_url: z.string().nullable().default(null),
};

/** Text frames sent by the Stage node. `id` answers a Core request. */
export type StageMessage =
  | { type: "hello"; version: number; token: string; node: string; capabilities: string[] }
  | ({ type: "status"; id?: number } & StageStatus)
  | { type: "error"; message: string; id?: number }
  | { type: "ping" }
  | { type: "pong" };

const StageMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    version: z.number().int().nonnegative(),
    token: z.string(),
    node: z.string().default(""),
    capabilities: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal("status"), ...StageStatusFields, id: requestId }),
  z.object({ type: z.literal("error"), message: z.string(), id: requestId }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);

/** Text frames sent by Core. */
export type CoreMessage =
  | { type: "welcome"; session: string }
  | { type: "emotion"; name: string; intensity: number }
  | { type: "subtitle"; turn: string; text: string; final: boolean }
  | { type: "speaking"; state: SpeakingState }
  | { type: "scene"; name: string; id?: number }
  | { type: "stream"; action: StreamAction; id?: number }
  | { type: "avatar_hotkey"; name: string; id?: number }
  | { type: "gaze"; target: GazeTarget }
  /** Asks for a `status` (with the same `id`). */
  | { type: "status_request"; id?: number }
  | { type: "ping" }
  | { type: "pong" };

const CoreMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), session: z.string() }),
  z.object({ type: z.literal("emotion"), name: z.string(), intensity: z.number() }),
  z.object({ type: z.literal("subtitle"), turn: z.string(), text: z.string(), final: z.boolean() }),
  z.object({ type: z.literal("speaking"), state: SpeakingStateSchema }),
  z.object({ type: z.literal("scene"), name: z.string(), id: requestId }),
  z.object({ type: z.literal("stream"), action: StreamActionSchema, id: requestId }),
  z.object({ type: z.literal("avatar_hotkey"), name: z.string(), id: requestId }),
  z.object({ type: z.literal("gaze"), target: GazeTargetSchema }),
  z.object({ type: z.literal("status_request"), id: requestId }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);

/** Drops a missing `id` key, like serde's `skip_serializing_if = "Option::is_none"`. */
function dropMissingId<T extends object>(msg: T): T {
  if ("id" in msg && msg.id === undefined) delete msg.id;
  return msg;
}

/** Parses a value as a Stage message; throws a `ZodError`. */
export function parseStageMessage(value: unknown): StageMessage {
  return dropMissingId(StageMessageSchema.parse(value));
}

/** Parses a value as a Core message; throws a `ZodError`. */
export function parseCoreMessage(value: unknown): CoreMessage {
  return dropMissingId(CoreMessageSchema.parse(value));
}

/** JSON text of a message (a missing `id` is left out). */
export function encodeMessage(msg: StageMessage | CoreMessage): string {
  return JSON.stringify(msg);
}

/** Status without the message fields. */
export function statusOf(msg: StageStatus): StageStatus {
  return {
    vts: msg.vts,
    obs: msg.obs,
    scene: msg.scene,
    streaming: msg.streaming,
    scenes: [...msg.scenes],
    hotkeys: [...msg.hotkeys],
    overlay_url: msg.overlay_url,
  };
}

/**
 * One playback level sample, sent by the voice node to the Stage lip-sync endpoint
 * (`ws://127.0.0.1:7883/levels`).
 */
export interface LevelFrame {
  /**
   * Playback position in milliseconds (start of the window, 0 at the start of each playback).
   * Frames without it are placed by arrival time.
   */
  t?: number;
  /** RMS of the audio being played, 0..1. */
  rms: number;
  /** RMS per analysis band, lowest first (vowel shapes); optional. */
  bands?: number[];
}

const LevelFrameSchema = z.object({
  t: z.number().optional(),
  rms: z.number(),
  bands: z.array(z.number()).max(32).optional(),
});

export function parseLevelFrame(value: unknown): LevelFrame {
  const f = LevelFrameSchema.parse(value);
  const out: LevelFrame = { rms: f.rms };
  if (f.t !== undefined) out.t = f.t;
  if (f.bands !== undefined) out.bands = f.bands;
  return out;
}
