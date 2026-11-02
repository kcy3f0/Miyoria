// Playing one song: fetch the worker's 48 kHz mix and converted vocal, stream them to the voice
// node close to real time (the vocal as the levels track her mouth follows), and send the lyrics
// lines as cues while it plays.

import type { Clock, PlaybackState, PlayChunk, SongCue, VoicePlayer } from "@miyoria/types";
import type { SingWorker, SongMeta } from "./client.js";

export interface PlayerDeps {
  worker: SingWorker;
  voice: VoicePlayer;
  clock: Clock;
  cue: (cue: SongCue) => void;
  leadMs: number;
  fadeMs: number;
  lyrics: boolean;
  lipSyncVocals: boolean;
}

/** How long to wait for the node to report a started playback before giving up on lyrics. */
const START_WAIT_MS = 60_000;
const POLL_MS = 50;

/** Resolves after `ms`, or when `signal` aborts (never rejects). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** `mix` in 100 ms chunks, each sent `leadMs` before it is due. */
export async function* paced(
  mix: Int16Array,
  vocals: Int16Array | null,
  rate: number,
  leadMs: number,
  clock: Clock,
  signal: AbortSignal,
): AsyncGenerator<PlayChunk> {
  const step = Math.max(1, Math.floor(rate / 10));
  const t0 = clock.now();
  for (let at = 0; at < mix.length; at += step) {
    if (signal.aborted) return;
    const due = t0 + (at / rate) * 1000 - leadMs;
    const wait = due - clock.now();
    if (wait > 0) await sleep(wait, signal);
    if (signal.aborted) return;
    const samples = mix.subarray(at, at + step);
    if (vocals === null) yield { samples };
    else {
      const levels = new Int16Array(samples.length);
      levels.set(vocals.subarray(at, Math.min(at + step, vocals.length)));
      yield { samples, levels };
    }
  }
}

/**
 * Sings `song` in `guild`'s voice channel and resolves with how it ended. Aborting `signal`
 * fades it out (a skip or stop). Throws when the audio cannot be fetched or played.
 */
export async function singSong(
  d: PlayerDeps,
  song: SongMeta,
  guild: string,
  signal: AbortSignal,
): Promise<PlaybackState> {
  const rate = song.play.sample_rate;
  const [mix, vocals] = await Promise.all([
    d.worker.audio(song.id, "play_mix.pcm", signal),
    d.lipSyncVocals ? d.worker.audio(song.id, "play_vocals.pcm", signal) : Promise.resolve(null),
  ]);
  if (signal.aborted) return "interrupted";
  const streaming = new AbortController();
  const handle = await d.voice.play(
    guild,
    rate,
    paced(mix, vocals, rate, d.leadMs, d.clock, AbortSignal.any([signal, streaming.signal])),
    { levels: vocals !== null },
  );
  const onAbort = () => handle.stop(d.fadeMs);
  signal.addEventListener("abort", onAbort, { once: true });
  const lyricsDone = new AbortController();
  const lyrics = cueLyrics(d, song, handle, AbortSignal.any([signal, lyricsDone.signal]));
  try {
    return await handle.wait();
  } finally {
    signal.removeEventListener("abort", onAbort);
    streaming.abort();
    lyricsDone.abort();
    await lyrics;
  }
}

/** Waits for the playback to start, then publishes `started` and each lyrics line on time. */
async function cueLyrics(
  d: PlayerDeps,
  song: SongMeta,
  handle: { state(): PlaybackState | null },
  signal: AbortSignal,
): Promise<void> {
  const waitUntil = d.clock.now() + START_WAIT_MS;
  while (handle.state() === null && !signal.aborted && d.clock.now() < waitUntil) {
    await sleep(POLL_MS, signal);
  }
  if (signal.aborted || handle.state() !== "started") return;
  const startedAt = d.clock.now();
  d.cue({ state: "started", song: song.id, title: song.title });
  const lines = d.lyrics && song.lyrics?.synced ? song.lyrics.lines : [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    await sleep(startedAt + line.t * 1000 - d.clock.now(), signal);
    if (signal.aborted) return;
    d.cue({ state: "line", song: song.id, index: i, text: line.text });
  }
}
