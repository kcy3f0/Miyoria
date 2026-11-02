// Her songs on the bus: the `sing` module publishes `SONG_TOPIC` custom events while she sings,
// the stage forwards them to the overlay (lyrics as subtitles) and the avatar (speaking).

import { isJsonObject, type JsonValue } from "./json.js";

/** Topic of `SongCue` custom events. */
export const SONG_TOPIC = "sing.cue";

/**
 * `started`: the song became audible. `line`: a lyrics line starts now (`text` may be empty: an
 * instrumental break). `ended`: the song finished, was stopped or failed.
 */
export type SongCue =
  | { state: "started"; song: string; title: string }
  | { state: "line"; song: string; index: number; text: string }
  | { state: "ended"; song: string; outcome: string };

/** A `SongCue` from an untyped payload, or `null`. */
export function parseSongCue(payload: JsonValue): SongCue | null {
  if (!isJsonObject(payload)) return null;
  const song = typeof payload.song === "string" ? payload.song : null;
  if (song === null) return null;
  switch (payload.state) {
    case "started":
      return {
        state: "started",
        song,
        title: typeof payload.title === "string" ? payload.title : "",
      };
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
