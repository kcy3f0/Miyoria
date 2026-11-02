// Reflection and learning (docs/design/autonomy.md §19, phase G): what she organizes herself.
//
// * Conversation states (`ConversationStatesKey`, module `conversation`): her running notes on
//   each conversation, folded in continuously from the message log. A fixed envelope (context,
//   when, which line was folded last, a short recap kept for prompts) around free-form notes
//   whose shape she decides.
// * Knowledge (`KnowledgeKey`, module `knowledge`): documents she keeps about people, servers,
//   herself and topics she names. The envelope (subject, kind label, title, per-field sources
//   with confidence, versions, size caps) is fixed; the content is schema-free JSON she
//   structures, restructures, merges and splits with JSON-patch-like operations.
// * Lessons (`LessonsKey`) and her reflections (`ReflectionKey`, module `reflect`).
// * `MemoryCuratorKey` (module `memory`): what reflection may do to her long-term memory.
//
// Everything here may be derived from what other people said: prompts show it as untrusted
// data blocks, never in the system role.

import type { PersonId, PlatformId } from "./ids.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

// ---- conversation state -------------------------------------------------------------------

/** Published after a stretch of a conversation was folded into its state. */
export const CONVERSATION_FOLDED_TOPIC = "conversation.folded";

/** The last message-log line folded into a state. */
export interface FoldMark {
  /** Log entry id (ULID). */
  id: string;
  ts: Timestamp;
}

/** Her running notes on one conversation context. */
export interface ConversationState {
  context: ContextKey;
  updated_at: Timestamp;
  /** Everything up to and including this line is folded in; `null` before the first fold. */
  folded_up_to: FoldMark | null;
  /** How many folds and lines went into it. */
  folds: number;
  lines: number;
  /** A short narrative recap (always kept; what prompts show first). */
  recap: string;
  /** Her own structured notes: free-form JSON she organizes (topics, threads, plans, ...). */
  notes: JsonObject;
  /**
   * When each thread of the notes (a top-level scalar, list item or object member, by an id of
   * path and content) last appeared or changed. Threads untouched for `stale_thread_mins` are
   * stale: prompts leave them out. Missing in old states.
   */
  touched?: Record<string, Timestamp>;
}

/** `conversation.folded` payload. */
export interface ConversationFolded {
  context: ContextKey;
  folded_up_to: FoldMark;
  /** Lines folded this time. */
  lines: number;
  /** Total lines folded since the context went quiet last (a long session). */
  session_lines: number;
}

/** Provided by the `conversation` module; answers from memory (safe on the voice hot path). */
export interface ConversationStates {
  get(context: ContextKey): ConversationState | null;
  /** Most recently updated first. */
  list(): ConversationState[];
}

export const ConversationStatesKey = serviceKey<ConversationStates>("ConversationStates");

// ---- knowledge ----------------------------------------------------------------------------

/** What a document is about. */
export type KnowledgeSubject =
  | { type: "person"; person: PersonId }
  | { type: "guild"; platform: PlatformId; guild: string }
  | { type: "self" }
  /** Anything she names herself ("Minecraft 建築計畫", "大家的生日"). */
  | { type: "topic"; name: string };

/** `person:<id>`, `guild:<platform>:<guild>`, `self`, `topic:<name>`. */
export function subjectKey(subject: KnowledgeSubject): string {
  switch (subject.type) {
    case "person":
      return `person:${subject.person}`;
    case "guild":
      return `guild:${subject.platform}:${subject.guild}`;
    case "self":
      return "self";
    case "topic":
      return `topic:${subject.name.trim().toLowerCase()}`;
  }
}

/**
 * Who wrote something: `self` (her own judgment: her mind loop, her reflection), `inferred`
 * (she concluded it from a conversation, which others can influence), `said` (attributed to
 * the person who said it), `panel` (the owner).
 */
export type SourceKind = "self" | "inferred" | "said" | "panel";

/** Where a field came from. Applies to the path and everything below it (unless overridden). */
export interface FieldSource {
  kind: SourceKind;
  /** Who said it (`said`). */
  account: AccountRef | null;
  name: string | null;
  /**
   * Where it was learned (privacy): `dm:<platform>:<account>` for a DM, `<platform>:<guild>`
   * for a server, `null` for her own thoughts and the panel. Fields are only shown where their
   * origin is visible (a DM's only in that DM, a server's only in that server).
   */
  origin: string | null;
  /** 0..1 */
  confidence: number;
  at: Timestamp;
}

/** One change of a document (bounded history). */
export interface KnowledgeVersion {
  version: number;
  at: Timestamp;
  by: SourceKind;
  /** Display name of who it is attributed to, if anyone. */
  name: string | null;
  why: string;
  /** What changed, in short (`replace /likes`, `created`, `merged d3`). */
  ops: string[];
}

/** One of her documents. */
export interface KnowledgeDoc {
  /** ULID. */
  id: string;
  subject: KnowledgeSubject;
  /** Her own label of the kind of document ("人物卡", "內梗", "建築計畫", ...). */
  kind: string;
  title: string;
  /** Schema-free: whatever structure she chose. */
  content: JsonObject;
  /** JSON pointer (`""` = the document, `/likes/0`) → its source. */
  sources: Record<string, FieldSource>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: number;
  history: KnowledgeVersion[];
}

/** JSON-patch-like operations (RFC 6902 subset; paths are JSON pointers, `-` appends). */
export type PatchOp =
  | { op: "add"; path: string; value: JsonValue }
  | { op: "replace"; path: string; value: JsonValue }
  | { op: "remove"; path: string }
  | { op: "move"; from: string; path: string };

/** Who is changing a document (checked against the fields' sources). */
export interface KnowledgeWriter {
  kind: SourceKind;
  /** `said`: the speaker. */
  account: AccountRef | null;
  person: PersonId | null;
  name: string | null;
  /** Where the change comes from (privacy origin of what it writes). */
  context: ContextKey | null;
}

export type KnowledgeChange =
  | {
      type: "create";
      subject: KnowledgeSubject;
      kind: string;
      title: string;
      content: JsonObject;
      why: string;
      confidence?: number;
    }
  | { type: "patch"; doc: string; ops: PatchOp[]; why: string; confidence?: number }
  | { type: "retitle"; doc: string; kind: string | null; title: string | null; why: string }
  | { type: "delete"; doc: string; why: string }
  /** Moves all of `doc` under `path` of `into` and deletes `doc`. */
  | { type: "merge"; doc: string; into: string; path: string; why: string };

export type KnowledgeResult = { ok: true; doc: KnowledgeDoc | null } | { ok: false; error: string };

export interface KnowledgeRenderOptions {
  /** Fields are shown only where their origin is visible from here. */
  context: ContextKey | null;
  maxChars: number;
  /** Short refs (`d1`) to show next to documents, by document id. */
  refs?: ReadonlyMap<string, string>;
}

/** Provided by the `knowledge` module. Reads answer from memory. */
export interface KnowledgeBase {
  /** Every document (optionally of one subject), most recently updated first. */
  docs(subject?: KnowledgeSubject): KnowledgeDoc[];
  get(id: string): KnowledgeDoc | null;
  /** Applies one change atomically (all ops or none); refused changes leave nothing behind. */
  apply(change: KnowledgeChange, writer: KnowledgeWriter): Promise<KnowledgeResult>;
  /** Compact text of the documents of `subjects` visible in `options.context` (data). */
  render(subjects: readonly KnowledgeSubject[], options: KnowledgeRenderOptions): string;
}

export const KnowledgeKey = serviceKey<KnowledgeBase>("KnowledgeBase");

// ---- lessons ------------------------------------------------------------------------------

/** Something she learned about how to behave ("阿明不喜歡被打斷"). */
export interface Lesson {
  id: string;
  /** In her words. */
  text: string;
  /** About this person (applies while they are part of the conversation). */
  person: PersonId | null;
  /**
   * Where it applies: a talkativeness-style scope (`contextKeyString`, `<platform>:<guild>`,
   * `voice`, `text`, `*`); `null` = wherever the person is (or everywhere without a person).
   */
  scope: string | null;
  /** Nudges her ambient talkativeness there (-1 = much quieter … 1 = chattier); `null` = none. */
  talk: number | null;
  created_at: Timestamp;
  expires_at: Timestamp | null;
  /** `daily`, `light`, `panel`. */
  source: string;
}

/** Provided by the `reflect` module; answers from memory. */
export interface Lessons {
  all(): Lesson[];
  /** Lessons for this context and these people. */
  applicable(context: ContextKey | null, people: readonly PersonId[]): Lesson[];
  /** Sum of the applicable lessons' `talk`, scaled and clamped to ±0.4 (a talkativeness shift). */
  talkShift(context: ContextKey | null, people: readonly PersonId[]): number;
}

export const LessonsKey = serviceKey<Lessons>("Lessons");

// ---- feedback and reflection --------------------------------------------------------------

/** Feedback signals about her, per person or context, over some days. */
export interface FeedbackTally {
  /** `person:<id>` or a context string. */
  subject: string;
  /** Display name or place. */
  label: string;
  /** Reactions on her messages (positive / negative emoji). */
  reactions_pos: number;
  reactions_neg: number;
  /** Replies to her within the reply window. */
  replies: number;
  /** Conversations she started: answered / ignored. */
  started: number;
  answered: number;
  ignored: number;
  /** Explicit phrases about her ("好可愛" / "閉嘴", "好吵"). */
  positive: number;
  negative: number;
  /** Her autonomous actions the gate (or an owner) refused. */
  denied: number;
  /** A few short examples (untrusted text). */
  examples: string[];
}

/** One of her reflections. */
export interface ReflectionRun {
  id: string;
  at: Timestamp;
  /** `daily` (the day) or `light` (after a long session). */
  kind: "daily" | "light";
  context: ContextKey | null;
  /** Her summary, in her words. */
  summary: string;
  insights: number;
  superseded: number;
  lessons: string[];
  goals: string[];
  /** Documents changed (titles). */
  documents: string[];
  feelings: string[];
  error: string | null;
  tokens: number | null;
  ms: number;
}

export interface ReflectionStats {
  calls_today: number;
  max_calls_per_day: number;
  last_daily_at: Timestamp | null;
  last_light_at: Timestamp | null;
  /** Why she is not reflecting right now, if not. */
  idle_reason: string | null;
}

/** Provided by the `reflect` module. */
export interface Reflection {
  /** Newest first. */
  runs(limit?: number): ReflectionRun[];
  feedback(days?: number): FeedbackTally[];
  stats(): ReflectionStats;
}

export const ReflectionKey = serviceKey<Reflection>("Reflection");

// ---- memory curation ----------------------------------------------------------------------

/** A long-term memory as reflection sees it (never from a DM). */
export interface CuratedNote {
  id: string;
  kind: "episode" | "fact" | "self_note" | "followup";
  content: string;
  subjects: PersonId[];
  /** Privacy scope label (`global`, `guild:<id>`, `channel:<ctx>`, `person`). */
  scope: string;
  importance: number;
  confidence: number;
  created_at: Timestamp;
  /** Who told her (`remember`), if anyone. */
  said_by: string | null;
}

export interface InsightInput {
  /** The higher-level memory, in her words. */
  content: string;
  kind: "fact" | "self_note";
  /** Notes it is drawn from (all of one scope); they are superseded by it. */
  from: string[];
  importance: number;
}

/** Provided by the `memory` module. */
export interface MemoryCurator {
  /** Notes updated since `since`, newest first, excluding DMs, superseded and done ones. */
  notes(since: Timestamp, limit: number, signal?: AbortSignal): Promise<CuratedNote[]>;
  /**
   * Stores an insight merged from `from` (same privacy scope, subjects united) and supersedes
   * them. Returns its id; throws when the notes are unknown or of different scopes.
   */
  insight(input: InsightInput, now: Timestamp, signal?: AbortSignal): Promise<string>;
  /** Marks `old` as outdated by the newer note `by` (same scope). */
  supersede(old: string, by: string, now: Timestamp): Promise<boolean>;
}

export const MemoryCuratorKey = serviceKey<MemoryCurator>("MemoryCurator");

/** Published for reactions on messages (`platform.reaction`). */
export const REACTION_TOPIC = "platform.reaction";

/** `platform.reaction` payload. */
export interface ReactionEvent {
  message: { context: ContextKey; id: string };
  account: AccountRef;
  display_name: string | null;
  emoji: string;
  added: boolean;
  at: Timestamp;
}
