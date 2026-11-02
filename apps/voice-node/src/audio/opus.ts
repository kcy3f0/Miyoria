// Opus encoder / decoder on opusscript's WebAssembly build, without its JS wrapper.
//
// The native handler moves PCM as one byte per 16-bit slot. opusscript's index.js (0.0.8 and
// 0.1.x alike) mallocs only one byte per slot and then views the buffer through `HEAPU16`
// indexed by the *byte* pointer, i.e. at twice the allocated address, so every encode / decode
// writes into memory it does not own. That tramples the WASM heap: later `new OpusScript()`
// fails with "memory access out of bounds". Here the PCM slots are allocated at full size and
// addressed at their real offset.
//
// The module has a fixed 16 MiB heap (no memory growth), so always `delete()` when done.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** 60 ms at 48 kHz, the largest Opus frame. */
const MAX_FRAME_SIZE = 2880;
/** Largest packet opusscript's handler writes. */
const MAX_PACKET_SIZE = 1276 * 3;
const OPUS_SET_BITRATE = 4002;

export const OpusApplication = { VOIP: 2048, AUDIO: 2049, RESTRICTED_LOWDELAY: 2051 } as const;

interface Handler {
  _encode(pcm: number, length: number, opus: number, frameSize: number): number;
  _decode(opus: number, length: number, pcm: number): number;
  _encoder_ctl(ctl: number, arg: number): number;
}

interface WasmModule {
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  OpusScriptHandler: {
    new (rate: number, channels: number, application: number): Handler;
    destroy_handler(handler: Handler): void;
  };
}

let wasm: WasmModule | undefined;

function module(): WasmModule {
  wasm ??= (require("opusscript/build/opusscript_native_wasm.js") as () => WasmModule)();
  return wasm;
}

export class OpusCodec {
  private readonly m = module();
  private readonly handler: Handler;
  private readonly pcmPtr: number;
  private readonly pcmBytes: number;
  private readonly opusPtr: number;
  private deleted = false;

  constructor(
    readonly rate: number,
    readonly channels: number,
    application: number = OpusApplication.AUDIO,
  ) {
    this.handler = new this.m.OpusScriptHandler(rate, channels, application);
    this.pcmBytes = MAX_FRAME_SIZE * channels * 2;
    // One 16-bit slot per PCM byte.
    this.pcmPtr = this.m._malloc(this.pcmBytes * 2);
    this.opusPtr = this.m._malloc(MAX_PACKET_SIZE);
    if (this.pcmPtr === 0 || this.opusPtr === 0) {
      this.delete();
      throw new Error("opus: out of WASM memory");
    }
  }

  /** Interleaved s16le PCM (`frameSize` samples per channel) -> one Opus packet (a copy). */
  encode(pcm: Uint8Array, frameSize: number): Buffer {
    this.check();
    const bytes = frameSize * this.channels * 2;
    if (pcm.byteLength < bytes || bytes > this.pcmBytes) {
      throw new RangeError(`opus encode: need ${bytes} bytes of PCM, got ${pcm.byteLength}`);
    }
    // Element-wise copy: each PCM byte into its own 16-bit slot.
    this.m.HEAPU16.set(pcm.subarray(0, bytes), this.pcmPtr >> 1);
    const len = this.handler._encode(this.pcmPtr, bytes, this.opusPtr, frameSize);
    if (len < 0) throw new Error(`opus encode error ${len}`);
    return Buffer.from(this.m.HEAPU8.subarray(this.opusPtr, this.opusPtr + len));
  }

  /** One Opus packet -> interleaved s16le PCM (a copy). */
  decode(packet: Uint8Array): Buffer {
    this.check();
    if (packet.byteLength > MAX_PACKET_SIZE) {
      throw new RangeError(`opus decode: packet of ${packet.byteLength} bytes is too large`);
    }
    this.m.HEAPU8.set(packet, this.opusPtr);
    const samples = this.handler._decode(this.opusPtr, packet.byteLength, this.pcmPtr);
    if (samples < 0) throw new Error(`opus decode error ${samples}`);
    const bytes = samples * this.channels * 2;
    const slots = this.pcmPtr >> 1;
    // Buffer.from on a Uint16Array keeps the low byte of each slot, which is the PCM byte.
    return Buffer.from(this.m.HEAPU16.subarray(slots, slots + bytes));
  }

  setBitrate(bitrate: number): void {
    this.check();
    const r = this.handler._encoder_ctl(OPUS_SET_BITRATE, bitrate);
    if (r < 0) throw new Error(`opus set bitrate error ${r}`);
  }

  delete(): void {
    if (this.deleted) return;
    this.deleted = true;
    this.m.OpusScriptHandler.destroy_handler(this.handler);
    if (this.pcmPtr) this.m._free(this.pcmPtr);
    if (this.opusPtr) this.m._free(this.opusPtr);
  }

  private check(): void {
    if (this.deleted) throw new Error("opus codec was deleted");
  }
}
