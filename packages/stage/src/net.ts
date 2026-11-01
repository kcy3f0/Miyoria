// HTTP / WebSocket server plumbing shared by the stage link, the levels endpoint and the overlay.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";

export class BindError extends Error {
  override readonly name = "BindError";
}

/** A bound address. */
export interface BoundAddress {
  host: string;
  port: number;
}

export function formatAddress(addr: BoundAddress): string {
  return addr.host.includes(":") ? `[${addr.host}]:${addr.port}` : `${addr.host}:${addr.port}`;
}

/** Splits `host:port` / `[v6]:port`. */
export function parseBind(bind: string): BoundAddress {
  const s = bind.trim();
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) ?? /^([^:]+):(\d+)$/.exec(s);
  const port = Number(m?.[2]);
  if (!m?.[1] || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new BindError(`invalid address \`${bind}\``);
  }
  return { host: m[1], port };
}

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export interface WsRoute {
  path: string;
  maxPayload?: number;
  onConnection(ws: WebSocket, request: IncomingMessage): void;
}

export interface HttpServerOptions {
  /** Plain HTTP requests (WebSocket routes are handled first). Default: 404. */
  onRequest?: (req: IncomingMessage, res: ServerResponse) => void;
  ws: WsRoute[];
}

/** A listening HTTP server with WebSocket routes. */
export class HttpServer {
  readonly server: Server;
  readonly address: BoundAddress;
  readonly #wss: WebSocketServer[];
  #closed: Promise<void> | null = null;

  private constructor(server: Server, address: BoundAddress, wss: WebSocketServer[]) {
    this.server = server;
    this.address = address;
    this.#wss = wss;
  }

  /** Binds `bind` (`host:port`); rejects with `what` in the message when it cannot. */
  static async listen(bind: string, what: string, options: HttpServerOptions): Promise<HttpServer> {
    const { host, port } = (() => {
      try {
        return parseBind(bind);
      } catch (error) {
        throw new BindError(`cannot bind ${what} to \`${bind}\``, { cause: error });
      }
    })();
    const routes = options.ws.map((route) => ({
      route,
      wss: new WebSocketServer({
        noServer: true,
        maxPayload: route.maxPayload ?? 100 * 1024 * 1024,
      }),
    }));
    const server = createServer((req, res) => {
      if (options.onRequest) options.onRequest(req, res);
      else {
        res.writeHead(404).end();
      }
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? "/").split("?")[0];
      const match = routes.find((r) => r.route.path === path);
      if (!match) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      match.wss.handleUpgrade(req, socket, head, (ws) => match.route.onConnection(ws, req));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        reject(
          new BindError(`cannot bind ${what} to \`${bind}\`: ${error.message}`, { cause: error }),
        );
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    const info = server.address() as AddressInfo;
    return new HttpServer(
      server,
      { host: info.address, port: info.port },
      routes.map((r) => r.wss),
    );
  }

  /**
   * Stops accepting, gives WebSocket clients up to `graceMs` to finish their close handshake,
   * then terminates them and closes every connection.
   */
  close(graceMs = 0): Promise<void> {
    this.#closed ??= (async () => {
      const closing = new Promise<void>((resolve) => this.server.close(() => resolve()));
      const clients = this.#wss.flatMap((wss) => [...wss.clients]);
      if (graceMs > 0 && clients.length > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(
            clients.map(
              (c) =>
                new Promise<void>((resolve) => {
                  if (c.readyState === c.CLOSED) resolve();
                  else c.once("close", () => resolve());
                }),
            ),
          ),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, graceMs);
          }),
        ]);
        clearTimeout(timer);
      }
      for (const wss of this.#wss) {
        for (const client of wss.clients) client.terminate();
        wss.close();
      }
      this.server.closeAllConnections();
      await closing;
    })();
    return this.#closed;
  }
}
