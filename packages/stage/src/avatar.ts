// The parts of a profile's `avatar.toml` the Stage uses.

import { readFileSync } from "node:fs";
import { errorMessage, getLogger } from "@miyoria/kernel";
import type { JsonObject } from "@miyoria/types";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const log = getLogger("stage.avatar");

/** What an emotion maps to in VTube Studio. */
export type AvatarAction =
  /** An expression file (`*.exp3.json`), toggled with `ExpressionActivationRequest`. */
  | { type: "expression"; file: string }
  /** A hotkey name or id, fired with `HotkeyTriggerRequest`. */
  | { type: "hotkey"; name: string };

/** `""` and template placeholders (`<...>`) map to nothing. */
export function parseAvatarAction(value: string): AvatarAction | null {
  const v = value.trim();
  if (v === "" || v.startsWith("<")) return null;
  return v.toLowerCase().endsWith(".exp3.json")
    ? { type: "expression", file: v }
    : { type: "hotkey", name: v };
}

/**
 * How the mouth is driven: `inject` from playback levels (injected as parameters), or `mic`
 * (VTube Studio does it from a virtual microphone; nothing is injected).
 */
export type LipSyncMode = "inject" | "mic";

export class AvatarProfileError extends Error {
  override readonly name = "AvatarProfileError";
}

const RawSchema = z.object({
  vts_model: z.string().nullish(),
  emotion: z.record(z.string(), z.string()).default({}),
  lipsync: z
    .object({
      mode: z.enum(["inject", "mic"]).default("inject"),
      mouth_open: z.string().nullish(),
      mouth_form: z.string().nullish(),
    })
    .prefault({}),
});

function nonEmpty(v: string | null | undefined): string | null {
  const s = v?.trim() ?? "";
  return s === "" ? null : s;
}

/** `avatar.toml`. */
export class AvatarProfile {
  /** Expected VTS model name or id (warned about when another is loaded). */
  vtsModel: string | null = null;
  /** Emotion (lowercase) → action, ordered by name. `neutral` is the resting state. */
  emotions = new Map<string, AvatarAction>();
  lipsync: LipSyncMode = "inject";
  /** Parameter for mouth opening. Default `MouthOpen`. */
  mouthOpen = "MouthOpen";
  /**
   * VTS tracking parameter for mouth shape (0..1). Default `MouthSmile`, which VTS maps to
   * `ParamMouthForm`; `MouthForm` itself is a Live2D parameter VTS won't take injections for.
   */
  mouthForm: string | null = "MouthSmile";

  /** Parses `avatar.toml` (`null` when the profile has none). */
  static parse(table: JsonObject | Record<string, unknown> | null): AvatarProfile {
    const p = new AvatarProfile();
    if (table === null) return p;
    const result = RawSchema.safeParse(table);
    if (!result.success) {
      throw new AvatarProfileError(`invalid avatar.toml: ${z.prettifyError(result.error)}`);
    }
    const raw = result.data;
    const emotions: [string, AvatarAction][] = [];
    for (const [name, value] of Object.entries(raw.emotion)) {
      const action = parseAvatarAction(value);
      if (action) emotions.push([name.trim().toLowerCase(), action]);
      else if (value.trim().startsWith("<")) {
        log.warn({ emotion: name }, "avatar.toml emotion is still a placeholder");
      }
    }
    emotions.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    p.emotions = new Map(emotions);
    const model = nonEmpty(raw.vts_model);
    p.vtsModel = model?.startsWith("<") ? null : model;
    p.lipsync = raw.lipsync.mode;
    p.mouthOpen = nonEmpty(raw.lipsync.mouth_open) ?? p.mouthOpen;
    if (raw.lipsync.mouth_form !== undefined && raw.lipsync.mouth_form !== null) {
      p.mouthForm = nonEmpty(raw.lipsync.mouth_form);
    }
    return p;
  }

  /** Reads and parses an `avatar.toml` file. */
  static load(path: string): AvatarProfile {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      throw new AvatarProfileError(`cannot read ${path}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    let table: Record<string, unknown>;
    try {
      table = parseToml(text) as Record<string, unknown>;
    } catch (error) {
      throw new AvatarProfileError(`invalid ${path}: ${errorMessage(error)}`, { cause: error });
    }
    return AvatarProfile.parse(table);
  }

  actionFor(emotion: string): AvatarAction | null {
    return this.emotions.get(emotion.trim().toLowerCase()) ?? null;
  }

  clone(): AvatarProfile {
    const p = new AvatarProfile();
    p.vtsModel = this.vtsModel;
    p.emotions = new Map(this.emotions);
    p.lipsync = this.lipsync;
    p.mouthOpen = this.mouthOpen;
    p.mouthForm = this.mouthForm;
    return p;
  }
}
