import type { ApiContext } from "./state.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Handler = (c: ApiContext) => Response | Promise<Response>;

/** One route. Protected routes need the bearer token or a panel session. */
export interface Route {
  method: Method;
  path: string;
  handler: Handler;
  public?: boolean;
}

/** A JSON response (`axum::Json`). */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `204 No Content`. */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** A path parameter (Hono decodes it). */
export function param(c: ApiContext, name: string): string {
  return c.req.param(name) ?? "";
}
