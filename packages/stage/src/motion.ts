// Idle head and eye motion: gentle noise around a pose that follows the gaze target.

import { z } from "zod";
import type { GazeTarget } from "./protocol.js";

/** Head angles (degrees, VTS range -30..30) and eye direction (-1..1). */
export const GazePoseSchema = z.object({
  face_x: z.number().default(0),
  face_y: z.number().default(0),
  face_z: z.number().default(0),
  eye_x: z.number().default(0),
  eye_y: z.number().default(0),
});
export type GazePose = z.output<typeof GazePoseSchema>;

const CHAT_POSE: GazePose = { face_x: -12, face_y: -6, face_z: 2, eye_x: -0.6, eye_y: -0.3 };
const GAME_POSE: GazePose = { face_x: 8, face_y: -10, face_z: 0, eye_x: 0.3, eye_y: -0.5 };
const CAMERA_POSE: GazePose = { face_x: 0, face_y: 0, face_z: 0, eye_x: 0, eye_y: 0 };

/** `[gaze]` section of the Stage config: one pose per target. */
export const GazeConfigSchema = z.object({
  chat: GazePoseSchema.default(CHAT_POSE),
  game: GazePoseSchema.default(GAME_POSE),
  camera: GazePoseSchema.default(CAMERA_POSE),
  /** Scale of the idle noise; 0 disables it. */
  idle_amount: z.number().default(1.0),
  /** Time constant for turning towards a new target (ms). */
  turn_ms: z.number().default(600),
});
export type GazeConfig = z.output<typeof GazeConfigSchema>;

export function gazePose(config: GazeConfig, target: GazeTarget): GazePose {
  return config[target];
}

/** VTS input parameters driven by `IdleMotion`. */
export const MOTION_PARAMS = [
  "FaceAngleX",
  "FaceAngleY",
  "FaceAngleZ",
  "EyeLeftX",
  "EyeLeftY",
  "EyeRightX",
  "EyeRightY",
] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export class IdleMotion {
  readonly #config: GazeConfig;
  #target: GazeTarget = "camera";
  readonly #pose: GazePose;
  #t = 0;

  constructor(config: GazeConfig) {
    this.#config = config;
    this.#pose = { ...config.camera };
  }

  target(): GazeTarget {
    return this.#target;
  }

  setTarget(target: GazeTarget): void {
    this.#target = target;
  }

  /** Advances by `dtMs`; returns values for `MOTION_PARAMS`, in order. */
  update(dtMs: number): number[] {
    const dt = dtMs / 1000;
    this.#t += dt;
    const goal = gazePose(this.#config, this.#target);
    const a = 1 - Math.exp(-dt / (Math.max(this.#config.turn_ms, 1) / 1000));
    const p = this.#pose;
    p.face_x += (goal.face_x - p.face_x) * a;
    p.face_y += (goal.face_y - p.face_y) * a;
    p.face_z += (goal.face_z - p.face_z) * a;
    p.eye_x += (goal.eye_x - p.eye_x) * a;
    p.eye_y += (goal.eye_y - p.eye_y) * a;

    // Sums of slow sines with unrelated periods look like drifting.
    const t = this.#t;
    const k = Math.max(this.#config.idle_amount, 0);
    const nx = 3 * Math.sin(0.31 * t) + 1.5 * Math.sin(0.73 * t + 1);
    const ny = 2 * Math.sin(0.23 * t + 2) + 1 * Math.sin(0.61 * t);
    const nz = 2 * Math.sin(0.17 * t + 0.5) + 0.7 * Math.sin(0.47 * t + 3);
    const ex = 0.08 * Math.sin(0.9 * t + 0.3) + 0.04 * Math.sin(2.3 * t);
    const ey = 0.05 * Math.sin(0.7 * t + 1.2);

    const faceX = clamp(p.face_x + k * nx, -30, 30);
    const faceY = clamp(p.face_y + k * ny, -30, 30);
    const faceZ = clamp(p.face_z + k * nz, -30, 30);
    const eyeX = clamp(p.eye_x + k * ex, -1, 1);
    const eyeY = clamp(p.eye_y + k * ey, -1, 1);
    return [faceX, faceY, faceZ, eyeX, eyeY, eyeX, eyeY];
  }
}
