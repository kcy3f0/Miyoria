// Chunked FIFO of Int16 samples. Appending is O(1); taking copies only what is taken.
export class SampleFifo {
  private chunks: Int16Array[] = [];
  private offset = 0; // read offset into chunks[0]
  private count = 0;

  get length(): number {
    return this.count;
  }

  push(samples: Int16Array): void {
    if (samples.length === 0) return;
    this.chunks.push(samples);
    this.count += samples.length;
  }

  /** Removes and returns up to `n` samples. */
  take(n: number): Int16Array {
    const want = Math.min(n, this.count);
    const out = new Int16Array(want);
    let written = 0;
    while (written < want) {
      const head = this.chunks[0] as Int16Array;
      const avail = head.length - this.offset;
      const k = Math.min(avail, want - written);
      out.set(head.subarray(this.offset, this.offset + k), written);
      written += k;
      this.offset += k;
      if (this.offset >= head.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    this.count -= want;
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.offset = 0;
    this.count = 0;
  }
}
