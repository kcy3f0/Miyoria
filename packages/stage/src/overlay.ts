// Overlay HTTP server: `GET /overlay/ws` streams subtitle / emotion / speaking / status JSON,
// `/overlay/` serves the overlay web app.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { getLogger } from "@miyoria/kernel";
import { closeOnAbort, type ServeResult } from "./lipsync.js";
import { formatAddress, HttpServer } from "./net.js";
import type { SpeakingState, StageStatus } from "./protocol.js";

const log = getLogger("stage.overlay");

/** Messages an overlay client may lag behind before it is dropped (like a broadcast of 256). */
const MAX_BUFFERED = 1 << 20;

interface Snapshot {
  status: string | null;
  subtitle: string | null;
  emotion: string | null;
}

/** Fan-out of overlay messages. New clients first get the latest status, subtitle and emotion. */
export class OverlayHub {
  readonly #listeners = new Set<(text: string) => void>();
  readonly #snapshot: Snapshot = { status: null, subtitle: null, emotion: null };

  #send(text: string): void {
    for (const listener of [...this.#listeners]) listener(text);
  }

  subtitle(turn: string, text: string, isFinal: boolean): void {
    const v = JSON.stringify({ type: "subtitle", turn, text, final: isFinal });
    this.#snapshot.subtitle = v;
    this.#send(v);
  }

  emotion(name: string, intensity: number): void {
    const v = JSON.stringify({ type: "emotion", name, intensity });
    this.#snapshot.emotion = v;
    this.#send(v);
  }

  speaking(state: SpeakingState): void {
    this.#send(JSON.stringify({ type: "speaking", state }));
  }

  /** `core`: the Stage is connected to Core. */
  status(status: StageStatus, core: boolean): void {
    const v = JSON.stringify({
      type: "status",
      core,
      vts: status.vts,
      obs: status.obs,
      scene: status.scene,
      streaming: status.streaming,
    });
    this.#snapshot.status = v;
    this.#send(v);
  }

  /** The snapshot for a new client: status, emotion, subtitle (those that exist). */
  initial(): string[] {
    const s = this.#snapshot;
    return [s.status, s.emotion, s.subtitle].filter((v): v is string => v !== null);
  }

  /** Receives every message from now on; returns the unsubscribe function. */
  listen(listener: (text: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
}

/** `/overlay/<rest>` → a file under `root` (with `index.html` for directories). */
async function serveFile(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
  if (rawPath === "/overlay") {
    res.writeHead(308, { location: "/overlay/" }).end();
    return;
  }
  if (!rawPath.startsWith("/overlay/")) return notFound(res);
  let rel: string;
  try {
    rel = decodeURIComponent(rawPath.slice("/overlay/".length));
  } catch {
    return notFound(res);
  }
  if (rel.includes("\0")) return notFound(res);
  let path = resolve(root, normalize(rel));
  if (path !== root && !path.startsWith(root + sep)) return notFound(res);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
    if (info.isDirectory()) {
      path = join(path, "index.html");
      info = await stat(path);
    }
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(info.size),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(path)
    .on("error", () => res.destroy())
    .pipe(res);
}

/** Serves the overlay on `bind` until `signal` aborts. */
export async function serveOverlay(
  bind: string,
  dir: string,
  hub: OverlayHub,
  signal: AbortSignal,
): Promise<ServeResult> {
  const root = resolve(dir);
  if (!(await isDir(root))) {
    log.warn({ dir }, "overlay directory not found; only /overlay/ws is served");
  }
  const server = await HttpServer.listen(bind, "the overlay server", {
    onRequest(req, res) {
      serveFile(root, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
    },
    ws: [
      {
        path: "/overlay/ws",
        onConnection(ws) {
          for (const text of hub.initial()) ws.send(text);
          const unsubscribe = hub.listen((text) => {
            if (ws.bufferedAmount > MAX_BUFFERED) {
              log.debug("overlay client lagged");
              return;
            }
            ws.send(text);
          });
          ws.on("close", unsubscribe);
          ws.on("error", unsubscribe);
        },
      },
    ],
  });
  log.info(`overlay at http://${formatAddress(server.address)}/overlay/`);
  return { addr: server.address, done: closeOnAbort(server, signal) };
}
