// Writes 16-bit little-endian PCM as a canonical 44-byte-header WAV file.
import { writeFile } from "node:fs/promises";

export async function writeWav(
  path: string,
  pcm: Buffer,
  sampleRate: number,
  channels: number,
): Promise<void> {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  await writeFile(path, Buffer.concat([header, pcm]));
}

/** Interleaved stereo s16le -> mono s16le (average of L and R). */
export function stereoToMono(stereo: Buffer): Buffer {
  const frames = Math.floor(stereo.length / 4);
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = stereo.readInt16LE(i * 4);
    const r = stereo.readInt16LE(i * 4 + 2);
    mono.writeInt16LE((l + r) >> 1, i * 2);
  }
  return mono;
}
