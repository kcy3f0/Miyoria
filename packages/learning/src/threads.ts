// Which parts of her conversation notes are still alive. Her notes are free-form JSON, so the
// unit of "a thread" is structural: a top-level scalar, one item of a top-level list or one
// member of a top-level object. Each fold records when every unit was last touched (its content
// appeared or changed); a unit nobody touched for `stale_thread_mins` is stale: turns no longer
// see it (so an old open question does not keep resurfacing) and the next fold is asked to drop
// it if it is over.

import type { JsonObject, JsonValue, Timestamp } from "@miyoria/types";

/** One thread of her notes: where it is (JSON Pointer), its parent's pointer and identity. */
export interface NoteUnit {
  pointer: string;
  /** Pointer of the top-level member it belongs to (itself for a top-level scalar). */
  parent: string;
  /** Path plus a hash of the content: the same text keeps the same id across folds. */
  id: string;
}

const token = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/** FNV-1a, base 36: short and stable, only for telling contents apart. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const isObject = (v: JsonValue): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function noteUnits(notes: JsonObject): NoteUnit[] {
  const out: NoteUnit[] = [];
  for (const [key, value] of Object.entries(notes)) {
    const parent = `/${token(key)}`;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        out.push({
          pointer: `${parent}/${i}`,
          parent,
          id: `${key}[]${hash(JSON.stringify(item))}`,
        });
      });
    } else if (isObject(value)) {
      for (const [child, v] of Object.entries(value)) {
        out.push({
          pointer: `${parent}/${token(child)}`,
          parent,
          id: `${key}/${child}=${hash(JSON.stringify(v))}`,
        });
      }
    } else {
      out.push({ pointer: parent, parent, id: `${key}=${hash(JSON.stringify(value))}` });
    }
  }
  return out;
}

/**
 * When each unit of `notes` was last touched: unchanged units keep their time, new or changed
 * ones get `now`. Old states without a record count their unchanged units as touched at
 * `fallback` (the previous update).
 */
export function touchUnits(
  previous: { notes: JsonObject; touched?: Record<string, Timestamp> | undefined } | null,
  notes: JsonObject,
  now: Timestamp,
  fallback: Timestamp | null,
): Record<string, Timestamp> {
  const before = previous?.touched;
  const legacy =
    previous !== null && before === undefined
      ? new Set(noteUnits(previous.notes).map((u) => u.id))
      : null;
  const out: Record<string, Timestamp> = {};
  for (const unit of noteUnits(notes)) {
    const kept = before?.[unit.id];
    out[unit.id] = kept ?? (legacy?.has(unit.id) === true && fallback !== null ? fallback : now);
  }
  return out;
}

export interface Staleness {
  /** Pointers of stale units. */
  stale: Set<string>;
  /** What a prompt hides: stale units, and top-level members with nothing else left. */
  hidden: Set<string>;
}

/** The units of `notes` untouched for `staleMs` (none when `staleMs` is 0). */
export function staleness(
  notes: JsonObject,
  touched: Record<string, Timestamp> | undefined,
  fallback: Timestamp,
  now: number,
  staleMs: number,
): Staleness {
  const stale = new Set<string>();
  const hidden = new Set<string>();
  if (staleMs <= 0) return { stale, hidden };
  const units = noteUnits(notes);
  const live = new Set<string>();
  for (const unit of units) {
    const at = Date.parse(touched?.[unit.id] ?? fallback);
    const old = !Number.isNaN(at) && now - at >= staleMs;
    if (old) {
      stale.add(unit.pointer);
      hidden.add(unit.pointer);
    } else {
      live.add(unit.parent);
    }
  }
  for (const unit of units) if (!live.has(unit.parent)) hidden.add(unit.parent);
  return { stale, hidden };
}
