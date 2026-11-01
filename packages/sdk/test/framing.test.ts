import { describe, expect, it } from "vitest";
import { FrameDecoder, FramingError, encodeFrame } from "../src/framing.js";

describe("framing", () => {
  it("round-trips across arbitrary chunk boundaries", () => {
    const a = encodeFrame({ text: "哈囉 🎲" });
    const b = encodeFrame([1, 2, 3]);
    const bytes = Buffer.concat([a, b]);
    const decoder = new FrameDecoder();
    const out: unknown[] = [];
    for (const byte of bytes) out.push(...decoder.push(Buffer.from([byte])));
    expect(out).toEqual([{ text: "哈囉 🎲" }, [1, 2, 3]]);
    expect(decoder.pending).toBe(0);
  });

  it("counts Content-Length in bytes, not characters", () => {
    const frame = encodeFrame("骰子").toString("utf8");
    expect(frame.startsWith(`Content-Length: ${Buffer.byteLength('"骰子"')}\r\n\r\n`)).toBe(true);
  });

  it("decodes several frames from one chunk and keeps the remainder", () => {
    const decoder = new FrameDecoder();
    const two = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]);
    const partial = encodeFrame({ c: 3 }).subarray(0, 10);
    expect(decoder.push(Buffer.concat([two, partial]))).toEqual([{ a: 1 }, { b: 2 }]);
    expect(decoder.pending).toBe(10);
  });

  it("accepts extra headers in any case", () => {
    const body = '{"x":1}';
    const decoder = new FrameDecoder();
    const raw = `content-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`;
    expect(decoder.push(raw)).toEqual([{ x: 1 }]);
  });

  it("rejects malformed headers", () => {
    expect(() => new FrameDecoder().push("Content-Type: x\r\n\r\n{}")).toThrow(FramingError);
    expect(() => new FrameDecoder().push("Content-Length: abc\r\n\r\n")).toThrow(FramingError);
    expect(() => new FrameDecoder().push("garbage\r\n\r\n")).toThrow(FramingError);
    expect(() => new FrameDecoder().push("Content-Length: 99999999999\r\n\r\n")).toThrow(
      FramingError,
    );
  });
});
