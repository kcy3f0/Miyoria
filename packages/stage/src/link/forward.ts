// Turns bus events into Core → Stage messages.

import {
  type Event,
  isJsonObject,
  type JsonValue,
  type PlaybackState,
  parseSongCue,
  SONG_TOPIC,
  type TurnId,
} from "@miyoria/types";
import type { CoreMessage } from "../protocol.js";

/** Topic of the agent's emotion markers. */
export const EMOTION_TOPIC = "agent.emotion";

/** Turns whose subtitles are tracked at once. */
const MAX_TURNS = 16;

interface TurnSubtitle {
  turn: TurnId;
  /** Text of the playbacks started so far. */
  spoken: string;
  /** Playbacks started and not yet ended. */
  active: number;
  completed: boolean;
  finalized: boolean;
}

/** An emotion marker of a voice turn, waiting for its sentence to play. */
interface PendingEmotion {
  name: string;
  intensity: number;
}

interface TurnEmotions {
  /** Emotion → intensity of its latest marker. */
  byName: Map<string, number>;
  latest: PendingEmotion;
}

export interface ForwarderOptions {
  /** The scene a song's video plays in (the `sing` scene the director switches to), if any. */
  singScene?: () => string | null;
  /** Clock of `resumeSongVideo` (ms). */
  now?: () => number;
}

/** The song video playing: its `play` message, and when that was sent. */
interface SongVideo {
  msg: Extract<CoreMessage, { type: "song_video" }>;
  sentAt: number;
}

const clampIntensity = (i: unknown): number =>
  typeof i === "number" && Number.isFinite(i) ? Math.min(Math.max(i, 0), 1) : 1;

/**
 * Subscribed topics → messages, with the subtitle bookkeeping.
 *
 * Subtitles follow her speech: every started playback appends its text and sends a non-final
 * `subtitle`; once the turn completed and no playback of it is running, the text is sent again
 * with `final: true`. Turns outside voice contexts produce one final subtitle when `textTurns`
 * is set.
 *
 * Emotions of voice turns are sent when the sentence spoken with them starts playing (the
 * marker is parsed a sentence or more ahead of the audio): `voice.playback` `started` carries
 * the sentence's emotion, and the marker's intensity is remembered until then. Playbacks from
 * older voice modules (no `emotion` field) show the turn's latest marker instead. Emotions of
 * other turns are sent at once.
 *
 * Songs (`SONG_TOPIC`) with a video also send `song_video` `play` when they start and `stop`
 * when they end; a node that connects mid-song gets the `play` again (`resumeSongVideo`).
 */
export class Forwarder {
  readonly #textTurns: boolean;
  readonly #turns: TurnSubtitle[] = [];
  readonly #emotions = new Map<TurnId, TurnEmotions>();
  readonly #singScene: () => string | null;
  readonly #now: () => number;
  #video: SongVideo | null = null;

  constructor(textTurns: boolean, options: ForwarderOptions = {}) {
    this.#textTurns = textTurns;
    this.#singScene = options.singScene ?? (() => null);
    this.#now = options.now ?? Date.now;
  }

  /** The `play` of the song video still playing, for a node that just connected. */
  resumeSongVideo(): CoreMessage | null {
    const v = this.#video;
    if (v === null) return null;
    const offset = (v.msg.offset_ms ?? 0) + Math.max(this.#now() - v.sentAt, 0);
    return { ...v.msg, offset_ms: Math.round(offset) };
  }

  #entry(turn: TurnId): TurnSubtitle {
    const found = this.#turns.find((t) => t.turn === turn);
    if (found) return found;
    if (this.#turns.length >= MAX_TURNS) this.#turns.shift();
    const e: TurnSubtitle = { turn, spoken: "", active: 0, completed: false, finalized: false };
    this.#turns.push(e);
    return e;
  }

  #onEmotion(payload: JsonValue): CoreMessage[] {
    const p = isJsonObject(payload) ? payload : {};
    const raw = p.emotion ?? p.name;
    const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (name === "") return [];
    const intensity = clampIntensity(p.intensity);
    const context = isJsonObject(p.context) ? p.context : null;
    const turn = typeof p.turn === "string" && p.turn !== "" ? p.turn : null;
    if (context?.kind !== "voice" || turn === null) return [{ type: "emotion", name, intensity }];
    // A voice turn: wait for the sentence to play.
    let e = this.#emotions.get(turn);
    if (!e) {
      if (this.#emotions.size >= MAX_TURNS) {
        const oldest = this.#emotions.keys().next().value;
        if (oldest !== undefined) this.#emotions.delete(oldest);
      }
      e = { byName: new Map(), latest: { name, intensity } };
      this.#emotions.set(turn, e);
    }
    e.byName.set(name, intensity);
    e.latest = { name, intensity };
    return [];
  }

  /** The emotion to show when a playback of `turn` starts. */
  #playbackEmotion(turn: TurnId | null, emotion: string | null | undefined): CoreMessage[] {
    const pending = turn === null ? undefined : this.#emotions.get(turn);
    if (emotion === undefined) {
      // An older voice module: the turn's latest marker, once.
      if (!pending || turn === null) return [];
      this.#emotions.delete(turn);
      return [{ type: "emotion", ...pending.latest }];
    }
    const name = emotion?.trim().toLowerCase() ?? "";
    if (name === "") return [];
    return [{ type: "emotion", name, intensity: pending?.byName.get(name) ?? 1 }];
  }

  onEvent(event: Event): CoreMessage[] {
    switch (event.type) {
      case "custom":
        if (event.data.topic === SONG_TOPIC) return this.#onSong(event.data.payload);
        return event.data.topic === EMOTION_TOPIC ? this.#onEmotion(event.data.payload) : [];
      case "voice_playback": {
        const { turn, state, text, emotion } = event.data;
        const out = this.#onPlayback(turn, state, text);
        if (state === "started") out.push(...this.#playbackEmotion(turn, emotion));
        return out;
      }
      case "agent_turn_completed": {
        const { turn, context, text } = event.data;
        const voice = context.kind === "voice";
        const e = this.#entry(turn);
        e.completed = true;
        if (voice || e.spoken !== "") {
          if (e.active === 0 && e.spoken !== "" && !e.finalized) {
            e.finalized = true;
            return [subtitle(turn, e.spoken, true)];
          }
        } else if (this.#textTurns && text.trim() !== "" && !e.finalized) {
          e.finalized = true;
          return [subtitle(turn, text.trim(), true)];
        }
        return [];
      }
      default:
        return [];
    }
  }

  #onPlayback(turn: TurnId | null, state: PlaybackState, rawText: string): CoreMessage[] {
    const text = rawText.trim();
    if (state === "started") {
      const out: CoreMessage[] = [{ type: "speaking", state: "started" }];
      if (turn !== null) {
        const e = this.#entry(turn);
        e.active += 1;
        e.finalized = false;
        e.spoken = append(e.spoken, text);
        if (e.spoken !== "") out.push(subtitle(turn, e.spoken, false));
      } else if (text !== "") {
        out.push({ type: "subtitle", turn: "", text, final: false });
      }
      return out;
    }
    const out: CoreMessage[] = [{ type: "speaking", state: "stopped" }];
    if (turn !== null) {
      const e = this.#entry(turn);
      // `failed` without `started` (TTS failed) has nothing running.
      if (state !== "failed" || e.active > 0) e.active = Math.max(e.active - 1, 0);
      if (e.completed && e.active === 0 && e.spoken !== "" && !e.finalized) {
        e.finalized = true;
        out.push(subtitle(turn, e.spoken, true));
      }
    } else if (text !== "" && state !== "failed") {
      out.push({ type: "subtitle", turn: "", text, final: true });
    }
    return out;
  }

  /**
   * A song she sings: she is speaking while it plays, each lyrics line is its own final
   * subtitle (an empty line clears it), the end clears it; its video plays from start to end.
   */
  #onSong(payload: JsonValue): CoreMessage[] {
    const cue = parseSongCue(payload);
    if (cue === null) return [];
    switch (cue.state) {
      case "started": {
        const out: CoreMessage[] = [{ type: "speaking", state: "started" }];
        this.#video = null;
        if (cue.video !== undefined) {
          const scene = this.#singScene();
          const msg: SongVideo["msg"] = {
            type: "song_video",
            action: "play",
            song: cue.song,
            path: cue.video,
            offset_ms: cue.offset_ms ?? 0,
            ...(scene === null ? {} : { scene }),
          };
          this.#video = { msg, sentAt: this.#now() };
          out.push(msg);
        }
        return out;
      }
      case "line":
        return [subtitle(`song:${cue.song}:${cue.index}`, cue.text.trim(), true)];
      case "ended": {
        const out: CoreMessage[] = [
          { type: "speaking", state: "stopped" },
          subtitle(`song:${cue.song}:end`, "", true),
        ];
        if (this.#video?.msg.song === cue.song) {
          this.#video = null;
          out.push({ type: "song_video", action: "stop", song: cue.song });
        }
        return out;
      }
    }
  }
}

function subtitle(turn: TurnId, text: string, final: boolean): CoreMessage {
  return { type: "subtitle", turn, text, final };
}

const ASCII_ALNUM = /^[A-Za-z0-9]$/;

/** Appends a speech segment, with a space between two Latin words. */
function append(spoken: string, text: string): string {
  if (text === "") return spoken;
  const last = spoken.at(-1);
  const first = text[0] ?? "";
  const needsSpace =
    last !== undefined &&
    (ASCII_ALNUM.test(last) || last === "," || last === ".") &&
    ASCII_ALNUM.test(first);
  return needsSpace ? `${spoken} ${text}` : spoken + text;
}
