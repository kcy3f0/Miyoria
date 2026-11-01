import type { JsonValue, ModuleId } from "@miyoria/types";
import { z } from "zod";
import type { ModuleContext } from "./context.js";

export interface ModuleManifest {
  /** Stable id, identical to legacy (e.g. `"platform.discord.bot"`); also `[modules.<id>]`. */
  readonly id: ModuleId;
  readonly name: string;
  readonly description: string;
  /** Must be running for this module to start. Disabling one of these stops this module too. */
  readonly requires: readonly ModuleId[];
  /** Started first when present, but their absence only degrades this module. */
  readonly optional: readonly ModuleId[];
  /** Schema of `[modules.<id>]` (without `enabled`), for docs and the panel's settings form. */
  readonly configSchema?: z.ZodType;
}

export interface ManifestOptions {
  description?: string;
  requires?: readonly ModuleId[];
  optional?: readonly ModuleId[];
  configSchema?: z.ZodType;
}

export function defineManifest(
  id: ModuleId,
  name: string,
  options: ManifestOptions = {},
): ModuleManifest {
  return {
    id,
    name,
    description: options.description ?? "",
    requires: options.requires ?? [],
    optional: options.optional ?? [],
    ...(options.configSchema ? { configSchema: options.configSchema } : {}),
  };
}

/** Legacy JSON form of a manifest (`config_schema` is a JSON Schema of the config input). */
export interface ModuleManifestJson {
  id: ModuleId;
  name: string;
  description: string;
  requires: ModuleId[];
  optional: ModuleId[];
  config_schema: JsonValue | null;
}

export function manifestJson(manifest: ModuleManifest): ModuleManifestJson {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    requires: [...manifest.requires],
    optional: [...manifest.optional],
    config_schema: manifest.configSchema
      ? (z.toJSONSchema(manifest.configSchema, {
          io: "input",
          unrepresentable: "any",
        }) as JsonValue)
      : null,
  };
}

/** Serialized like Rust `#[serde(tag = "status", content = "reason")]`. */
export type Health =
  | { status: "healthy" }
  | { status: "degraded"; reason: string }
  | { status: "unhealthy"; reason: string };

export const HEALTHY: Health = { status: "healthy" };

/**
 * A subsystem managed by the supervisor.
 *
 * `start` must return quickly: long-running work goes into tasks started with `ctx.spawn`,
 * which the supervisor tracks and cancels (aborts their signal) on stop. A spawned task that
 * rejects marks the module as failed and triggers a restart with backoff; so does a rejected
 * `start`.
 *
 * Never call back into the `Supervisor` from inside `start` / `stop` (it serializes lifecycle
 * operations and would deadlock); doing so from spawned tasks is fine.
 */
export interface Module {
  readonly manifest: ModuleManifest;
  start(ctx: ModuleContext): Promise<void>;
  /** Called before the module's tasks are cancelled. */
  stop?(): Promise<void>;
  health?(): Promise<Health>;
}
