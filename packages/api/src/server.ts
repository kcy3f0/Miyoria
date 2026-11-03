// Router, authentication and the fallback. The route groups live in sibling modules.

import { errorMessage, getLogger } from "@miyoria/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import { AuthorizerKey } from "@miyoria/types";
import { Hono } from "hono";
import { channelRoutes } from "./channels.js";
import { controlRoutes } from "./control.js";
import { coreRoutes } from "./core.js";
import { dataRoutes } from "./data.js";
import { ApiError, NO_SUCH_ENDPOINT } from "./errors.js";
import { innerRoutes } from "./inner.js";
import { learningRoutes } from "./learning.js";
import { memoryRoutes } from "./memory.js";
import { metricsRoutes } from "./metrics.js";
import { mindRoutes } from "./mind.js";
import * as oauth from "./oauth.js";
import { opsRoutes } from "./ops.js";
import { servePanel } from "./panel.js";
import { peopleRoutes } from "./people.js";
import { roleRoutes } from "./roles.js";
import { json, type Route } from "./route.js";
import { sandboxRoutes } from "./sandbox.js";
import {
  CSRF_HEADER,
  cookieToken,
  hasCsrfHeader,
  isSafeMethod,
  PANEL_WRITE,
  type Principal,
  tokenMatches,
} from "./session.js";
import type { ApiContext, ApiEnv, ApiState } from "./state.js";
import { telemetryRoutes } from "./telemetry.js";

const log = getLogger("api.server");

function unauthorized(message: string): ApiError {
  return new ApiError(401, message);
}

/**
 * Accepts the bearer token or (with Discord login configured) a session cookie. An
 * `Authorization` header, when present, must be the token; cookies are not consulted then.
 */
async function authenticate(state: ApiState, c: ApiContext): Promise<Principal> {
  const auth = state.auth;
  const header = c.req.header("authorization");
  if (header !== undefined) {
    const ok = header.startsWith("Bearer ") && tokenMatches(auth.token, header.slice(7));
    if (!ok) throw unauthorized("missing or invalid bearer token");
    return { kind: "token" };
  }
  const token = auth.oauth ? cookieToken(oauth.requestCookies(c)) : null;
  if (token === null) throw unauthorized("missing or invalid bearer token");
  // Sessions only count while Discord login is configured.
  const found = await auth.sessions.lookup(
    state.optional(SettingsStoreKey),
    state.optional(AuthorizerKey),
    token,
  );
  if (!found) throw unauthorized("session expired or invalid");
  if (!found.access.panel) throw unauthorized("this account no longer has panel access");
  if (!isSafeMethod(c.req.method)) {
    if (!hasCsrfHeader(c.req.header(CSRF_HEADER))) {
      throw new ApiError(403, `cookie-authenticated changes need the \`${CSRF_HEADER}: 1\` header`);
    }
    if (!found.access.write) {
      throw new ApiError(403, `this account may only look (changes need \`${PANEL_WRITE}\`)`);
    }
  }
  return { kind: "session", record: found.record, write: found.access.write };
}

function publicRoutes(state: ApiState): Route[] {
  const routes: Route[] = [
    { method: "GET", path: "/api/auth/methods", handler: () => json(oauth.methods(state)) },
    { method: "GET", path: "/api/auth/oauth/login", handler: (c) => oauth.login(state, c) },
    { method: "GET", path: "/api/auth/oauth/callback", handler: (c) => oauth.callback(state, c) },
    { method: "POST", path: "/api/auth/logout", handler: (c) => oauth.logout(state, c) },
  ];
  return routes.map((r) => ({ ...r, public: true }));
}

function sessionRoutes(): Route[] {
  return [{ method: "GET", path: "/api/auth/session", handler: (c) => json(oauth.session(c)) }];
}

export interface AppOptions {
  /** Serve `GET /metrics` without authentication (`metrics_public`). Default `false`. */
  metricsPublic?: boolean;
}

/** Every route of the API. */
export function routes(state: ApiState, options: AppOptions = {}): Route[] {
  return [
    ...coreRoutes(state),
    ...publicRoutes(state),
    ...sessionRoutes(),
    ...peopleRoutes(state),
    ...memoryRoutes(state),
    ...roleRoutes(state),
    ...opsRoutes(state),
    ...innerRoutes(state),
    ...channelRoutes(state),
    ...dataRoutes(state),
    ...sandboxRoutes(state),
    ...mindRoutes(state),
    ...learningRoutes(state),
    ...controlRoutes(state),
    ...telemetryRoutes(state),

    ...metricsRoutes(state, { public: options.metricsPublic ?? false }),
  ];
}

function toResponse(error: unknown): Response {
  if (error instanceof ApiError) return error.toResponse();
  log.warn({ error: errorMessage(error) }, "request failed");
  return ApiError.internal(error).toResponse();
}

/** Builds the API app for a running `api` module. */
export function createApp(state: ApiState, options: AppOptions = {}): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const all = routes(state, options);
  const byPath = new Map<string, Route[]>();
  for (const route of all) {
    const list = byPath.get(route.path) ?? [];
    list.push(route);
    byPath.set(route.path, list);
  }
  for (const [path, list] of byPath) {
    for (const route of list) {
      app.on(route.method, path, async (c) => {
        try {
          if (!route.public) c.set("principal", await authenticate(state, c));
          return await route.handler(c);
        } catch (error) {
          return toResponse(error);
        }
      });
    }
    // A known path with another method: 405, after authentication like the route itself.
    const allow = [
      ...new Set(list.flatMap((r) => (r.method === "GET" ? ["GET", "HEAD"] : [r.method]))),
    ];
    const isPublic = list.every((r) => r.public);
    app.all(path, async (c) => {
      try {
        if (!isPublic) await authenticate(state, c);
      } catch (error) {
        return toResponse(error);
      }
      return new Response(null, { status: 405, headers: { allow: allow.join(",") } });
    });
  }

  // Unknown `/api/*` routes get the JSON 404 the panel checks for; anything else is a panel file
  // when a panel directory is configured.
  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    const isApi = path === "/api" || path.startsWith("/api/");
    if (state.panelDir !== null && !isApi) return servePanel(state.panelDir, c.req.raw);
    return ApiError.notFound(NO_SUCH_ENDPOINT).toResponse();
  });
  app.onError((error) => toResponse(error));
  return app;
}
