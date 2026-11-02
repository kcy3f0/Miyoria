// Her thought as the model wrote it: JSON validated with zod, field by field and item by item,
// so one malformed part never costs the rest. Everything is bounded here (lengths, counts,
// drive nudges, levels, durations); references to people, places and agenda items are still
// the prompt's short refs (`u1`, `p1`, `g1`) and are resolved against the snapshot later.

import { extractJsonObject } from "@miyoria/llm";
import { DRIVE_NAMES, type DriveName, type JsonObject, type JsonValue } from "@miyoria/types";
import { z } from "zod";

export class MindReplyError extends Error {
  override readonly name = "MindReplyError";
}

/** Longest thought kept. */
export const MAX_THOUGHT = 600;
/** Largest drive (and boredom) change one thought may make. */
export const MAX_DRIVE_NUDGE = 0.2;
export const MAX_FEELINGS = 3;
export const MAX_FEELING_NOTE = 300;
export const MAX_TALKATIVENESS = 3;
export const MAX_AGENDA_ADD = 3;
export const MAX_DOCUMENTS = 3;
/** Talkativeness settings last 5 minutes to a day. */
export const MIN_TALK_MINUTES = 5;
export const MAX_TALK_MINUTES = 24 * 60;
/** Intents expire after 15 seconds to 15 minutes (default 2 minutes). */
export const MIN_INTENT_SECS = 15;
export const MAX_INTENT_SECS = 900;
export const DEFAULT_INTENT_SECS = 120;
/** Agenda items expire after at most a week (default a day). */
export const MAX_AGENDA_MINUTES = 7 * 24 * 60;
export const DEFAULT_AGENDA_MINUTES = 24 * 60;

export type AffinityHint = "+" | "-" | "0";

export interface FeelingChange {
  /** Person ref (`u1`). */
  person: string;
  /** Her new description (replaces the old one); `null` = unchanged. */
  note: string | null;
  hint: AffinityHint | null;
}

export interface TalkChange {
  /** Place ref, `here`, `server`, `voice`, `text` or `*`. */
  scope: string;
  level: number;
  minutes: number;
  why: string;
}

export interface AgendaAdd {
  text: string;
  why: string;
  person: string | null;
  place: string | null;
  dueInMin: number | null;
  expiresInMin: number;
}

export interface IntentDraft {
  action: string;
  place: string | null;
  person: string | null;
  args: JsonObject;
  why: string;
  opening: string | null;
  expiresInS: number;
  /** The agenda item (`g1`) it is for, if she said. */
  agenda: string | null;
}

/** A change of her documents (refs still unresolved; the knowledge base re-validates it). */
export interface DocDraft {
  type: "create" | "patch" | "retitle" | "delete" | "merge";
  subject: string | null;
  kind: string | null;
  title: string | null;
  content: JsonObject;
  doc: string | null;
  into: string | null;
  path: string;
  ops: JsonValue[];
  why: string;
}

export interface MindReply {
  thought: string;
  feelings: FeelingChange[];
  drives: Partial<Record<DriveName | "boredom", number>>;
  talkativeness: TalkChange[];
  initiative: { level: number; why: string } | null;
  agendaAdd: AgendaAdd[];
  agendaDone: string[];
  agendaDrop: string[];
  intents: IntentDraft[];
  documents: DocDraft[];
}

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const text = (max: number) => z.string().transform((s) => cut(s, max));
const optText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((s) => (s === null || s === undefined || s.trim() === "" ? null : cut(s, max)));
const ref = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) =>
    v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim(),
  );
const num = z.coerce.number().refine(Number.isFinite);
const optNum = z
  .unknown()
  .optional()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });

const Feeling = z
  .object({
    person: ref.refine((v) => v !== null),
    note: optText(MAX_FEELING_NOTE),
    affinity_hint: z
      .unknown()
      .optional()
      .transform((h): AffinityHint | null => {
        const v = typeof h === "string" ? h.trim() : "";
        return v === "+" || v === "-" || v === "0" ? v : null;
      }),
  })
  // Nothing to change: not an item.
  .refine((f) => f.note !== null || f.affinity_hint !== null);

const Talk = z.object({
  scope: ref.refine((v) => v !== null),
  level: num.transform((v) => clamp(v, 0, 1)),
  for_min: optNum,
  why: optText(200),
});

const Initiative = z.object({ level: num.transform((v) => clamp(v, 0, 1)), why: optText(200) });

const Agenda = z.object({
  text: text(200).refine((t) => t !== ""),
  why: optText(200),
  person: ref,
  place: ref,
  due_in_min: optNum,
  expires_in_min: optNum,
});

const Intent = z.object({
  action: z.string().trim().min(1).max(64),
  place: ref,
  person: ref,
  args: z.unknown().optional(),
  why: optText(200),
  opening: optText(200),
  expires_in_s: optNum,
  agenda: ref,
});

const Doc = z.object({
  type: z.enum(["create", "patch", "retitle", "delete", "merge"]),
  subject: ref,
  kind: optText(40),
  title: optText(80),
  content: z.record(z.string(), z.json()).optional(),
  doc: ref,
  into: ref,
  path: z.string().optional(),
  ops: z.array(z.json()).max(30).optional(),
  why: optText(200),
});

/** Each item of `value` that parses; the rest are dropped. */
function items<T>(value: unknown, schema: z.ZodType<T>, max: number): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    if (out.length >= max) break;
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function refs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => (typeof v === "string" || typeof v === "number" ? [String(v)] : []));
}

/** Extracts and validates her reply (tolerates text around the JSON object). */
export function parseMindReply(raw: string, maxIntents: number): MindReply {
  // Whole text, fenced blocks or a balanced object in prose (models without a JSON mode).
  const value = extractJsonObject(raw);
  if (value === null) throw new MindReplyError("no JSON object in her thought");
  const obj = value as Record<string, unknown>;

  const thought = typeof obj.thought === "string" ? cut(obj.thought, MAX_THOUGHT) : "";

  const drives: MindReply["drives"] = {};
  if (isRecord(obj.drives)) {
    const d = obj.drives as Record<string, unknown>;
    for (const key of [...DRIVE_NAMES, "boredom"] as const) {
      const v = Number(d[key]);
      if (d[key] !== undefined && d[key] !== null && Number.isFinite(v) && v !== 0) {
        drives[key] = clamp(v, -MAX_DRIVE_NUDGE, MAX_DRIVE_NUDGE);
      }
    }
  }

  const policy = isRecord(obj.policy) ? (obj.policy as Record<string, unknown>) : {};
  const talkativeness = items(policy.talkativeness, Talk, MAX_TALKATIVENESS).map((t) => ({
    scope: t.scope as string,
    level: t.level,
    minutes: clamp(Math.round(t.for_min ?? 60), MIN_TALK_MINUTES, MAX_TALK_MINUTES),
    why: t.why ?? "",
  }));
  const init = Initiative.safeParse(policy.initiative);
  const initiative = init.success ? { level: init.data.level, why: init.data.why ?? "" } : null;

  const agenda = isRecord(obj.agenda) ? (obj.agenda as Record<string, unknown>) : {};
  const agendaAdd = items(agenda.add, Agenda, MAX_AGENDA_ADD).map((a) => ({
    text: a.text,
    why: a.why ?? "",
    person: a.person,
    place: a.place,
    dueInMin: a.due_in_min === null ? null : clamp(a.due_in_min, 0, MAX_AGENDA_MINUTES),
    expiresInMin: clamp(a.expires_in_min ?? DEFAULT_AGENDA_MINUTES, 5, MAX_AGENDA_MINUTES),
  }));

  const feelings = items(obj.feelings, Feeling, MAX_FEELINGS).map((f) => ({
    person: f.person as string,
    note: f.note,
    hint: f.affinity_hint,
  }));

  const intents = items(obj.intents, Intent, Math.max(maxIntents, 0)).map((i) => ({
    action: i.action,
    place: i.place,
    person: i.person,
    args: isRecord(i.args) ? { ...(i.args as JsonObject) } : {},
    why: i.why ?? "",
    opening: i.opening,
    expiresInS: clamp(
      Math.round(i.expires_in_s ?? DEFAULT_INTENT_SECS),
      MIN_INTENT_SECS,
      MAX_INTENT_SECS,
    ),
    agenda: i.agenda,
  }));

  const documents = items(obj.documents, Doc, MAX_DOCUMENTS).map((d) => ({
    type: d.type,
    subject: d.subject,
    kind: d.kind,
    title: d.title,
    content: (d.content ?? {}) as JsonObject,
    doc: d.doc,
    into: d.into,
    path: d.path ?? "",
    ops: (d.ops ?? []) as JsonValue[],
    why: d.why ?? "",
  }));

  return {
    thought,
    feelings,
    drives,
    talkativeness,
    initiative,
    agendaAdd,
    agendaDone: refs(agenda.complete),
    agendaDrop: refs(agenda.drop),
    intents,
    documents,
  };
}
