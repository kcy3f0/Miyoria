import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ClientError, FETCH_BLOCKED_PORTS } from "../../src/index.js";

/** Listens on a random 127.0.0.1 port that `fetch` may connect to; returns the port. */
export async function listenFetchable(server: Server): Promise<number> {
  for (;;) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export interface RawResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body, `null` when the body is empty or not JSON. */
  body: unknown;
  text: string;
}

export interface RawOptions {
  token?: string;
  headers?: Record<string, string>;
  json?: unknown;
}

/** One request without the client, redirects not followed. */
export async function raw(
  base: string,
  method: string,
  path: string,
  options: RawOptions = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { method, headers, body, redirect: "manual" });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

/** The HTTP status of a rejected client call. */
export async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClientError && error.status !== null) return error.status;
    throw new Error(`expected an API error, got ${String(error)}`);
  }
  throw new Error("expected an API error, got success");
}

/** The rejected client call's error. */
export async function errorOf(promise: Promise<unknown>): Promise<ClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClientError) return error;
    throw error;
  }
  throw new Error("expected an API error, got success");
}

/** Polls `check` every 20 ms until it returns a value, for up to 2 s. */
export async function waitFor<T>(
  check: () => T | null | undefined | Promise<T | null | undefined>,
): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met in time");
}
