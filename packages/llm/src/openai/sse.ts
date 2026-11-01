// Minimal Server-Sent Events parser that only cares about `data:` fields.

const NEWLINE = 0x0a;
const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Incremental SSE parser. Bytes may be split anywhere (including inside UTF-8 sequences);
 * complete event payloads are returned as they finish.
 */
export class SseParser {
  #buf: Uint8Array = new Uint8Array(0);
  #data = "";
  #hasData = false;

  /** Feeds bytes and returns the data payloads of all completed events. */
  push(bytes: Uint8Array): string[] {
    const out: string[] = [];
    const buf = this.#buf.length === 0 ? bytes : concat(this.#buf, bytes);
    let start = 0;
    for (let pos = buf.indexOf(NEWLINE, start); pos !== -1; pos = buf.indexOf(NEWLINE, start)) {
      this.#line(buf.subarray(start, pos), out);
      start = pos + 1;
    }
    this.#buf = buf.slice(start);
    return out;
  }

  /** Flushes a trailing unterminated line / event at end of stream. */
  finish(): string[] {
    const out: string[] = [];
    const rest = this.#buf;
    this.#buf = new Uint8Array(0);
    if (rest.length > 0) this.#line(rest, out);
    this.#line(new Uint8Array(0), out);
    return out;
  }

  #line(raw: Uint8Array, out: string[]): void {
    const bytes = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, -1) : raw;
    if (bytes.length === 0) {
      if (this.#hasData) {
        out.push(this.#data);
        this.#data = "";
        this.#hasData = false;
      }
      return;
    }
    // Lines are split on `\n`, which never occurs inside a UTF-8 sequence.
    const line = decoder.decode(bytes);
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      if (this.#hasData) this.#data += "\n";
      this.#data += value;
      this.#hasData = true;
    }
    // Comments (`: keep-alive`), `event:`, `id:` and `retry:` are ignored.
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
