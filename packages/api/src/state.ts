// Shared state of a running `api` module and the helpers every route group uses. Every service
// is looked up per request, because the modules providing them may be stopped or restarted at
// any time.

import { errorMessage, getLogger, type ModuleContext } from "@miyoria/kernel";
import { type AuditEntry, AuditLogKey } from "@miyoria/store";
import {
  type JsonValue,
  newId,
  type ProfileId,
  type ServiceKey,
  toTimestamp,
} from "@miyoria/types";
import type { Context } from "hono";
import { ApiError } from "./errors.js";
import type { Monitor } from "./monitor.js";
import type { OAuth } from "./oauth.js";
import { ActiveProfileKey } from "./services.js";
import { type Principal, principalActor, type Sessions } from "./session.js";

const log = getLogger("api.server");

/** Splits text into search tokens (the memory module's `tokenize`). */
export type Tokenizer = (text: string) => string[];

/** Hono environment of the API app. */
export interface ApiEnv {
  Variables: { principal: Principal };
}

export type ApiContext = Context<ApiEnv>;

/** Everything the auth middleware and the login routes share. */
export interface PanelAuth {
  /** The configured bearer token. */
  token: Buffer;
  sessions: Sessions;
  oauth: OAuth | null;
  cookieSecure: boolean;
}

export class ApiState {
  constructor(
    readonly ctx: ModuleContext,
    readonly auth: PanelAuth,
    readonly monitor: Monitor,
    readonly panelDir: string | null,
    readonly tokenize: Tokenizer,
  ) {}

  /** The service, or a 503 naming `what`. */
  service<T>(key: ServiceKey<T>, what: string): T {
    const service = this.ctx.services.get(key);
    if (service === undefined) throw ApiError.unavailable(`${what} is not available`);
    return service;
  }

  optional<T>(key: ServiceKey<T>): T | undefined {
    return this.ctx.services.get(key);
  }

  profile(): ProfileId {
    return this.service(ActiveProfileKey, "active profile id");
  }

  now(): number {
    return this.ctx.clock.now();
  }

  /**
   * Records a change in the audit log, when there is one, as made by the request's actor.
   * Failures to write are logged, never returned.
   */
  audit(c: ApiContext, action: string, target: string, detail: JsonValue, ok: boolean) {
    return this.auditAs(actorOf(c), action, target, detail, ok);
  }

  async auditAs(
    actor: string,
    action: string,
    target: string,
    detail: JsonValue,
    ok: boolean,
  ): Promise<void> {
    const auditLog = this.optional(AuditLogKey);
    if (!auditLog) return;
    const entry: AuditEntry = {
      id: newId(),
      at: toTimestamp(this.now()),
      actor,
      action,
      target,
      detail,
      ok,
    };
    try {
      await auditLog.append(entry);
    } catch (error) {
      log.warn({ action, error: errorMessage(error) }, "cannot write audit entry");
    }
  }
}

/** Actor of the request: `"api"` for the bearer token, `discord:<id>` for a session. */
export function actorOf(c: ApiContext): string {
  return principalActor(c.get("principal"));
}

/** Drops `undefined` fields, like serde's `skip_serializing_if = "Option::is_none"`. */
export function toJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
