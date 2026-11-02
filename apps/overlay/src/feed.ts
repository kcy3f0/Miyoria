// The overlay feed: message parsing and the reducer that folds messages into display state.
// Everything here is pure (no DOM, no timers), so it is unit tested.
//
// Wire format (crates/miyoria-stage/src/overlay.rs):
//   {"type":"subtitle","turn":"…","text":"…","final":bool}
//   {"type":"emotion","name":"happy","intensity":0..1}
//   {"type":"speaking","state":"started"|"stopped"}
//   {"type":"status","core":bool,"vts":bool,"obs":bool,"scene":"…"|null,"streaming":bool}
//   {"type":"queue","items":[…]}
//   {"type":"levels","rms":0..1,"bands":[…]?}   her voice level, once per avatar frame (~60/s)

export interface Subtitle {
  turn: string;
  text: string;
  final: boolean;
}

export interface Emotion {
  name: string;
  /** 0..1 */
  intensity: number;
}

export interface Status {
  core: boolean;
  vts: boolean;
  obs: boolean;
  scene: string | null;
  streaming: boolean;
}

export interface QueueItem {
  /** What is queued (song / game request / topic). */
  title: string;
  /** Who asked for it. */
  by: string | null;
}

export interface OverlayState {
  /** The WebSocket to the Stage is up. */
  connected: boolean;
  /** Her voice is playing right now. */
  speaking: boolean;
  /** Bumped on every accepted subtitle message; lets the view tell "same text again" from "nothing new". */
  subtitleSeq: number;
  /** null = nothing to show (never received, or cleared by an empty final). */
  subtitle: Subtitle | null;
  emotion: Emotion | null;
  status: Status | null;
  queue: QueueItem[];
}

export type FeedMessage =
  | { type: "subtitle"; turn: string; text: string; final: boolean }
  | { type: "emotion"; name: string; intensity: number }
  | { type: "speaking"; state: "started" | "stopped" }
  | { type: "status"; status: Status }
  | { type: "queue"; items: QueueItem[] }
  /** High-rate audio level: drawn by the waveform, never part of the reduced state. */
  | { type: "levels"; rms: number; bands: number[] | null };

/** Everything the reducer accepts: feed messages plus the connection state, which the transport reports. */
export type Action = FeedMessage | { type: "connection"; connected: boolean };

export const MAX_QUEUE_ITEMS = 12;
const MAX_TEXT = 2000;
const MAX_TITLE = 160;

export function initialState(): OverlayState {
  return {
    connected: false,
    speaking: false,
    subtitleSeq: 0,
    subtitle: null,
    emotion: null,
    status: null,
    queue: [],
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function nonEmpty(v: unknown): string | null {
  const s = str(v)?.trim();
  return s ? s : null;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : Math.min(n, 1);
}

/** First non-empty string among `keys` of `o`. */
function pick(o: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const s = nonEmpty(o[k]);
    if (s) return s;
  }
  return null;
}

/** The queue is described loosely ("items":[…]); accept plain strings or objects with the usual field names. */
export function parseQueueItem(raw: unknown): QueueItem | null {
  if (typeof raw === "string") {
    const title = raw.trim();
    return title ? { title: title.slice(0, MAX_TITLE), by: null } : null;
  }
  if (!isRecord(raw)) return null;
  const title = pick(raw, ["title", "text", "name", "song", "request", "goal", "label", "query"]);
  if (!title) return null;
  const by = pick(raw, ["by", "user", "requester", "requested_by", "author", "display_name", "from"]);
  return { title: title.slice(0, MAX_TITLE), by: by ? by.slice(0, 48) : null };
}

/** Parses one text frame. Unknown or malformed frames give null (the overlay must never throw on the feed). */
export function parseMessage(text: string): FeedMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case "subtitle": {
      const body = str(raw.text);
      if (body === null) return null;
      const turn = typeof raw.turn === "string" || typeof raw.turn === "number" ? String(raw.turn) : "";
      return { type: "subtitle", turn, text: body.slice(0, MAX_TEXT), final: raw.final === true };
    }
    case "emotion": {
      const name = nonEmpty(raw.name);
      if (!name) return null;
      const i = raw.intensity;
      return {
        type: "emotion",
        name: name.toLowerCase().slice(0, 32),
        intensity: typeof i === "number" && Number.isFinite(i) ? clamp01(i) : 1,
      };
    }
    case "speaking": {
      const state = raw.state;
      return state === "started" || state === "stopped" ? { type: "speaking", state } : null;
    }
    case "status":
      return {
        type: "status",
        status: {
          core: raw.core === true,
          vts: raw.vts === true,
          obs: raw.obs === true,
          scene: nonEmpty(raw.scene),
          streaming: raw.streaming === true,
        },
      };
    case "queue": {
      const items = raw.items;
      if (!Array.isArray(items)) return null;
      const out: QueueItem[] = [];
      for (const it of items) {
        const q = parseQueueItem(it);
        if (q) out.push(q);
        if (out.length >= MAX_QUEUE_ITEMS) break;
      }
      return { type: "queue", items: out };
    }
    case "levels": {
      const rms = raw.rms;
      if (typeof rms !== "number" || !Number.isFinite(rms)) return null;
      const b = raw.bands;
      const bands =
        Array.isArray(b) && b.length > 0 && b.length <= 16 && b.every((x) => typeof x === "number" && Number.isFinite(x))
          ? (b as number[]).map((x) => Math.max(x, 0))
          : null;
      return { type: "levels", rms: clamp01(rms), bands };
    }
    default:
      return null;
  }
}

export function reduce(state: OverlayState, action: Action): OverlayState {
  switch (action.type) {
    case "connection":
      // A dropped feed means nobody is driving the overlay: stop claiming she is talking.
      return action.connected
        ? { ...state, connected: true }
        : { ...state, connected: false, speaking: false };
    case "speaking":
      return { ...state, speaking: action.state === "started" };
    case "emotion":
      return { ...state, emotion: { name: action.name, intensity: action.intensity } };
    case "status":
      return { ...state, status: action.status };
    case "queue":
      return { ...state, queue: action.items };
    case "subtitle":
      return reduceSubtitle(state, action);
    case "levels":
      return state;
  }
}

function reduceSubtitle(state: OverlayState, m: Extract<FeedMessage, { type: "subtitle" }>): OverlayState {
  const cur = state.subtitle;
  const same = cur !== null && cur.turn === m.turn;
  // A late partial of a turn that already ended must not reopen it.
  if (same && cur.final && !m.final) return state;
  // Nothing changed (the Stage re-sends the latest subtitle to a new client, and may repeat finals).
  if (same && cur.text === m.text && cur.final === m.final) return state;
  const subtitle: Subtitle | null = m.text.trim() === "" && m.final ? null : { turn: m.turn, text: m.text, final: m.final };
  return { ...state, subtitle, subtitleSeq: state.subtitleSeq + 1 };
}
