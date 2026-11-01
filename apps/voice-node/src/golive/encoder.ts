// NVENC detection. `ffmpeg -encoders` lists h264_nvenc even on machines without an NVIDIA GPU, so the
// probe really opens the encoder on one tiny frame; exit code 0 means it works.
import { execFile } from "node:child_process";
import type { GoLivePlan, ResolvedEncoder } from "./plan.js";

export type RunProbe = () => Promise<boolean>;

const PROBE_ARGS = [
  "-hide_banner",
  "-loglevel", "error",
  "-f", "lavfi",
  "-i", "color=c=black:s=256x256:d=0.2",
  "-frames:v", "1",
  "-c:v", "h264_nvenc",
  "-f", "null",
  "-",
];

export const runFfmpegNvencProbe: RunProbe = () =>
  new Promise((resolve) => {
    execFile("ffmpeg", PROBE_ARGS, { timeout: 15_000, windowsHide: true }, (err) => resolve(!err));
  });

/** Caches the probe result for the life of the process (a GPU does not appear mid-run). */
export function cachedProbe(run: RunProbe = runFfmpegNvencProbe): RunProbe {
  let cached: Promise<boolean> | undefined;
  return () => (cached ??= run());
}

export interface EncoderChoice {
  encoder: ResolvedEncoder;
  /** Set when the choice differs from what was asked for. */
  note?: string;
}

/** auto -> NVENC when it works, else x264. `nvenc` that does not work falls back to software (with a note). */
export async function resolveEncoder(pref: GoLivePlan["encoder"], probe: RunProbe): Promise<EncoderChoice> {
  if (pref === "software") return { encoder: "software" };
  const ok = await probe();
  if (ok) return { encoder: "nvenc" };
  return pref === "nvenc"
    ? { encoder: "software", note: "NVENC was requested but h264_nvenc cannot be opened; using the software encoder" }
    : { encoder: "software", note: "NVENC is not available; using the software encoder" };
}
