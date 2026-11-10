// The live page's routes (docs/design/v4-plan.md §9.2). The `live` module decides what of her is
// public and counts the pats; this file only carries them.
//
// * `GET /api/public/live`: Server-Sent Events, for anyone. `event:` is the `LiveEvent`'s `type`
//   and `data:` the whole event as JSON, starting with `hello` (the full snapshot). A plain
//   `EventSource` can follow it: it needs no header, and the cookie is not read.
// * `POST /api/member/live/pat` `{}`: a head-pat from the logged-in person, as themselves only.
//
// Both go away with `[modules.api.public] enabled = false`, and answer 503 while the `live` module
// is not running.

import { errorMessage, getLogger } from "@miyoria/kernel";
import { type LiveEvent, type LiveFeed, LiveFeedKey } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { readJson } from "./extract.js";
import { clientKey, tooMany } from "./public.js";
import { json, type Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";

const log = getLogger("api.live");

/** Keep-alive comment interval: proxies close a stream that says nothing for long. */
export const LIVE_KEEP_ALIVE_MS = 15_000;
/** How long a page waits before it reconnects (SSE `retry:`). */
export const LIVE_RETRY_MS = 5_000;
/** Streams one client may hold open at once: a few tabs, not a crowd from one address. */
export const LIVE_STREAMS_PER_CLIENT = 4;
/** Events a stream may fall behind by before it is closed: a reader that stopped reading. */
const MAX_BEHIND = 256;

const NOT_RUNNING = "live page is not available";
export const PATS_CLOSED = "摸頭還沒開放";

/** Open streams per client, per running `api` module. */
const streams = new WeakMap<ApiState, Map<string, number>>();

function openStreams(state: ApiState): Map<string, number> {
  let map = streams.get(state);
  if (!map) {
    map = new Map();
    streams.set(state, map);
  }
  return map;
}

function feedOf(state: ApiState): LiveFeed {
  const feed = state.optional(LiveFeedKey);
  if (!feed) throw ApiError.unavailable(NOT_RUNNING);
  return feed;
}

/** One SSE message. */
export function sseMessage(event: LiveEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  // nginx and the like buffer a response unless told otherwise; a feed must not be buffered.
  "x-accel-buffering": "no",
};

/** `GET /api/public/live`. */
function liveStream(state: ApiState, c: ApiContext): Response {
  const feed = feedOf(state);
  const client = clientKey(c);
  const wait = state.publicSide.admit(client);
  if (wait !== null) return tooMany(wait);
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers: STREAM_HEADERS });
  const open = openStreams(state);
  if ((open.get(client) ?? 0) >= LIVE_STREAMS_PER_CLIENT) return tooMany(LIVE_RETRY_MS);

  const encoder = new TextEncoder();
  const requestSignal = c.req.raw.signal;
  let unfollow: (() => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    unfollow?.();
    clearInterval(keepAlive);
    requestSignal.removeEventListener("abort", finish);
    const left = (open.get(client) ?? 1) - 1;
    if (left <= 0) open.delete(client);
    else open.set(client, left);
  };
  let full = false;
  const stream = new ReadableStream<Uint8Array>({
    // Runs inside the constructor, so `full` is known before the response is.
    start(controller) {
      const push = (text: string) => {
        if (done) return;
        if ((controller.desiredSize ?? 0) < -MAX_BEHIND) {
          finish();
          controller.close();
          return;
        }
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          finish();
        }
      };
      unfollow = feed.follow((event) => push(sseMessage(event)));
      if (unfollow === null) {
        full = true;
        return;
      }
      open.set(client, (open.get(client) ?? 0) + 1);
      push(`retry: ${LIVE_RETRY_MS}\n\n`);
      push(sseMessage({ type: "hello", snapshot: feed.snapshot() }));
      keepAlive = setInterval(() => push(":\n\n"), LIVE_KEEP_ALIVE_MS);
      requestSignal.addEventListener("abort", finish, { once: true });
    },
    cancel() {
      finish();
    },
  });
  if (full) {
    void stream.cancel().catch(() => undefined);
    return new ApiError(503, "too many people are watching; try again soon").toResponse();
  }
  return new Response(stream, { status: 200, headers: STREAM_HEADERS });
}

/** An empty body: the session says who pats, nothing in the request can. */
const PatSchema = z.object({}).strict();

/** `POST /api/member/live/pat`. */
async function pat(state: ApiState, c: ApiContext): Promise<Response> {
  const session = c.get("member");
  await readJson(c, PatSchema);
  const feed = feedOf(state);
  let outcome: Awaited<ReturnType<LiveFeed["pat"]>>;
  try {
    outcome = await feed.pat({ account: session.account, name: session.name });
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "a pat failed");
    throw ApiError.unavailable(NOT_RUNNING);
  }
  if (outcome.status === "closed") throw new ApiError(403, PATS_CLOSED);
  if (outcome.status === "too_many") return tooMany(outcome.wait_ms);
  return json({ pats: outcome.pats });
}

/** The live page's routes; none when `[modules.api.public] enabled` is off. */
export function liveRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  return [
    {
      method: "GET",
      path: "/api/public/live",
      public: true,
      handler: (c) => liveStream(state, c),
    },
    { method: "POST", path: "/api/member/live/pat", member: true, handler: (c) => pat(state, c) },
  ];
}
