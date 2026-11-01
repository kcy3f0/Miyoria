// LSP-style `Content-Length` framing.

const SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
/** Largest accepted frame body, as on the host. */
export const MAX_FRAME = 16 * 1024 * 1024;

export class FramingError extends Error {
  override name = "FramingError";
}

/** Encodes one JSON message as a frame. */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Incremental decoder: feed chunks, get complete parsed messages back. */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  /** Appends a chunk and returns every message it completes. */
  push(chunk: Buffer | Uint8Array | string): unknown[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.#buffer = this.#buffer.length === 0 ? bytes : Buffer.concat([this.#buffer, bytes]);
    const out: unknown[] = [];
    for (;;) {
      const end = this.#buffer.indexOf(SEPARATOR);
      if (end < 0) {
        if (this.#buffer.length > 8192) throw new FramingError("header too long");
        return out;
      }
      const length = parseLength(this.#buffer.subarray(0, end).toString("ascii"));
      const start = end + SEPARATOR.length;
      if (this.#buffer.length < start + length) return out;
      const body = this.#buffer.subarray(start, start + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(start + length);
      out.push(JSON.parse(body));
    }
  }

  /** Bytes buffered but not yet part of a complete frame. */
  get pending(): number {
    return this.#buffer.length;
  }
}

function parseLength(headers: string): number {
  let length: number | undefined;
  for (const line of headers.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) throw new FramingError(`malformed header "${line}"`);
    if (line.slice(0, colon).trim().toLowerCase() === "content-length") {
      const value = line.slice(colon + 1).trim();
      if (!/^\d+$/.test(value)) throw new FramingError(`bad Content-Length "${value}"`);
      length = Number(value);
    }
  }
  if (length === undefined) throw new FramingError("missing Content-Length");
  if (length > MAX_FRAME) throw new FramingError(`frame of ${length} bytes is too large`);
  return length;
}
