// Her songs on the bus: the `sing` module publishes `SONG_TOPIC` custom events while she sings,
// the stage forwards them to the overlay (lyrics as subtitles), the avatar (speaking) and OBS
// (the song's original video, muted, while she sings).

import { isJsonObject, type JsonValue } from "./json.js";

/** Topic of `SongCue` custom events. */
export const SONG_TOPIC = "sing.cue";

/** Longest video path a cue carries. */
const MAX_PATH = 1024;

/**
 * `started`: the song became audible; `video` is the absolute path of its original video on the
 * streaming PC (inside the song worker's data dir) when it has one, and `offset_ms` how far into
 * the song it already was when the cue was sent. `line`: a lyrics line starts now (`text` may be
 * empty: an instrumental break). `ended`: the song finished, was stopped or failed.
 */
export type SongCue =
  | { state: "started"; song: string; title: string; video?: string; offset_ms?: number }
  | { state: "line"; song: string; index: number; text: string }
  | { state: "ended"; song: string; outcome: string };

/** A `SongCue` from an untyped payload, or `null`. */
export function parseSongCue(payload: JsonValue): SongCue | null {
  if (!isJsonObject(payload)) return null;
  const song = typeof payload.song === "string" ? payload.song : null;
  if (song === null) return null;
  switch (payload.state) {
    case "started": {
      const cue: SongCue = {
        state: "started",
        song,
        title: typeof payload.title === "string" ? payload.title : "",
      };
      const { video, offset_ms: offset } = payload;
      if (typeof video === "string" && video !== "" && video.length <= MAX_PATH) {
        cue.video = video;
        cue.offset_ms =
          typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, offset) : 0;
      }
      return cue;
    }
    case "line":
      return {
        state: "line",
        song,
        index: typeof payload.index === "number" ? payload.index : 0,
        text: typeof payload.text === "string" ? payload.text : "",
      };
    case "ended":
      return {
        state: "ended",
        song,
        outcome: typeof payload.outcome === "string" ? payload.outcome : "",
      };
    default:
      return null;
  }
}
