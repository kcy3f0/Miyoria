// `MemoryEngine`: storing with dedupe, hybrid recall, consolidation, forgetting and followups.
// Provided as the service `MemoryEngineKey` (and as `FollowupSourceKey`).

import { errorMessage, getLogger } from "@miyoria/kernel";
import {
  type ChatRequest,
  contextHash,
  type LlmRouter,
  sessionId,
  systemMessage,
  userMessage,
} from "@miyoria/llm";
import type {
  LogEntry,
  MemoryFilter,
  MemoryKind,
  MemoryRecord,
  MemoryRecordStore,
  MemoryScope,
  MessageLog,
  PeopleStore,
  SettingsStore,
} from "@miyoria/store";
import {
  type AccountRef,
  type Clock,
  type ContextKey,
  contextKeyString,
  type Followup,
  type FollowupSource,
  isJsonObject,
  isUlid,
  type JsonValue,
  newId,
  type PersonId,
  type ProfileId,
  sameAccount,
  serviceKey,
  systemClock,
  type Timestamp,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import type { MemoryConfig } from "./config.js";
import { cosine, type Embedder, NoEmbedder } from "./embed.js";
import { type Extraction, parseExtraction, systemPrompt, transcript } from "./extract.js";
import { hasScope, isPrivate, scopeEquals, scopeForNew } from "./scope.js";
import { finalScore, signals, tokenOverlap } from "./score.js";
import { textSimilarity, tokenize, tokenString } from "./tokenize.js";

const log = getLogger("memory");

/** Settings key prefix of consolidation watermarks (`memory_watermark:<context>`). */
export const WATERMARK_PREFIX = "memory_watermark:";
/** Settings key of the last maintenance run. */
export const MAINTENANCE_KEY = "memory_maintenance_last";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export class MemoryError extends Error {
  override readonly name = "MemoryError";
}

/** The last log line already consolidated in a context (persisted as JSON). */
export interface Watermark {
  context: ContextKey;
  ts: Timestamp;
  /** ULID of the log entry. */
  id: string;
}

/** A memory to store. Field names mirror `MemoryRecord`. */
export interface NewMemory {
  kind: MemoryKind;
  scope: MemoryScope;
  subjects: PersonId[];
  content: string;
  importance: number;
  confidence: number;
  source_context: ContextKey | null;
  due: Timestamp | null;
}

/** What `MemoryEngine.store` did. */
export type Stored =
  | { type: "inserted"; id: string }
  /** A near-identical record was updated in place (confidence raised). */
  | { type: "reinforced"; id: string }
  /** A similar record was replaced by a new one. */
  | { type: "superseded"; old: string; new: string };

/** The id of the record that now holds the memory. */
export function storedId(stored: Stored): string {
  return stored.type === "superseded" ? stored.new : stored.id;
}

/** A recalled record with its final score. */
export interface Recalled {
  record: MemoryRecord;
  score: number;
}

/** A search result (`MemoryEngine.search`): the final score and the match scores behind it. */
export interface Searched extends Recalled {
  /** The backend's full-text relevance, 0 when it did not match the text. */
  text_score: number;
  /** Cosine similarity, `null` when no vectors were compared. */
  vector_score: number | null;
}

/** Candidate selection and ranking options shared by `recall` and `search`. */
interface RankOptions {
  /** Keep followups already brought up. */
  includeDone: boolean;
  /** Drop records scoring below this; `null` keeps every candidate. */
  minScore: number | null;
}

export interface ConsolidationReport {
  /** New log lines read. */
  lines: number;
  inserted: number;
  reinforced: number;
  superseded: number;
  /** Extracted items dropped (malformed or trivial). */
  skipped: number;
  /** The summarizer's answer was not usable JSON (lines are skipped). */
  malformed: boolean;
}

export interface MaintenanceReport {
  pruned: number;
  decayed: number;
  forgotten: number;
}

/** Someone who spoke in the lines being consolidated. */
interface Speaker {
  account: AccountRef;
  names: string[];
  person: PersonId | null;
}

export interface MemoryEngineOptions {
  embedder?: Embedder;
  people?: PeopleStore | null;
  messages?: MessageLog | null;
  settings?: SettingsStore | null;
  router?: LlmRouter | null;
  /** Source of "now" for writes without an explicit time (`markDone`). */
  clock?: Clock;
}

/** A `MemoryFilter` with everything unset except `limit` and the given fields. */
export function memoryFilter(limit: number, fields: Partial<MemoryFilter> = {}): MemoryFilter {
  return {
    subject: null,
    scope: null,
    kind: null,
    before: null,
    include_superseded: false,
    ...fields,
    limit,
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ms = timestampMs;

function sortedUnique(ids: readonly PersonId[]): PersonId[] {
  return [...new Set(ids)].sort();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Long-term memory of one profile. */
export class MemoryEngine implements FollowupSource {
  readonly profile: ProfileId;
  readonly config: MemoryConfig;
  readonly records: MemoryRecordStore;
  readonly embedder: Embedder;
  readonly #people: PeopleStore | null;
  readonly #messages: MessageLog | null;
  readonly #settings: SettingsStore | null;
  readonly #router: LlmRouter | null;
  readonly #clock: Clock;
  readonly #watermarks = new Map<string, Watermark>();
  #lastMaintenance: Timestamp | null = null;

  constructor(
    profile: ProfileId,
    config: MemoryConfig,
    records: MemoryRecordStore,
    options: MemoryEngineOptions = {},
  ) {
    this.profile = profile;
    this.config = config;
    this.records = records;
    this.embedder = options.embedder ?? new NoEmbedder();
    this.#people = options.people ?? null;
    this.#messages = options.messages ?? null;
    this.#settings = options.settings ?? null;
    this.#router = options.router ?? null;
    this.#clock = options.clock ?? systemClock;
  }

  /** Whether consolidation can run (message log and LLM router present). */
  get canConsolidate(): boolean {
    return this.#messages !== null && this.#router !== null;
  }

  /** The person an account belongs to, when a people store is available. */
  async personOf(account: AccountRef): Promise<PersonId | null> {
    if (!this.#people) return null;
    try {
      return (await this.#people.personByAccount(account))?.id ?? null;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "person lookup failed");
      return null;
    }
  }

  async #embedOne(text: string, signal?: AbortSignal): Promise<number[] | null> {
    if (!this.embedder.enabled || text.trim() === "") return null;
    try {
      const v = await this.embedder.embed([text], signal);
      const first = v.length === 1 ? v[0] : undefined;
      return first && first.length > 0 ? first : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn({ embedder: this.embedder.name, error: errorMessage(error) }, "embedding failed");
      return null;
    }
  }

  /**
   * Stores a memory, merging it with a near-identical or very similar existing record of the
   * same kind, scope and subjects.
   */
  async store(memory: NewMemory, now: Timestamp, signal?: AbortSignal): Promise<Stored> {
    const content = memory.content.trim();
    if (content === "") throw new MemoryError("empty memory");
    const tokens = tokenString(content);
    const embedding = await this.#embedOne(content, signal);
    const subjects = sortedUnique(memory.subjects);

    const queryTokens = tokens.split(" ").filter((t) => t !== "");
    const hits =
      queryTokens.length === 0 && embedding === null
        ? []
        : await this.records.search({
            profile: this.profile,
            scopes: [memory.scope],
            kinds: [memory.kind],
            tokens: queryTokens,
            embedding,
            limit: 10,
          });

    const dedupe = this.config.dedupe;
    let identical: [number, MemoryRecord] | null = null;
    let similar: [number, MemoryRecord] | null = null;
    for (const hit of hits) {
      const record = hit.record;
      if (
        !sameList(sortedUnique(record.subjects), subjects) ||
        !scopeEquals(record.scope, memory.scope) ||
        record.superseded_by !== null ||
        record.done
      ) {
        continue;
      }
      const textSim = textSimilarity(record.content, content);
      const vecSim =
        hit.vector_score ??
        (embedding !== null && record.embedding !== null ? cosine(embedding, record.embedding) : 0);
      if (textSim >= dedupe.text_similarity) {
        if (identical === null || textSim > identical[0]) identical = [textSim, record];
      } else if (vecSim >= dedupe.vector_similarity && (similar === null || vecSim > similar[0])) {
        similar = [vecSim, record];
      }
    }

    if (identical !== null) {
      const old = { ...identical[1] };
      old.content = content;
      old.tokens = tokens;
      if (embedding !== null) old.embedding = embedding;
      if (old.kind !== "followup") {
        old.confidence = clamp01(Math.max(old.confidence, memory.confidence) + dedupe.reinforce);
      }
      old.importance = clamp01(Math.max(old.importance, memory.importance));
      old.updated_at = now;
      await this.records.upsert(old);
      return { type: "reinforced", id: old.id };
    }

    const record: MemoryRecord = {
      id: newId(),
      profile: this.profile,
      kind: memory.kind,
      scope: memory.scope,
      subjects,
      content,
      tokens,
      embedding,
      importance: clamp01(memory.importance),
      confidence: clamp01(memory.confidence),
      created_at: now,
      updated_at: now,
      last_accessed: null,
      access_count: 0,
      source_context: memory.source_context,
      due: memory.due,
      done: false,
      superseded_by: null,
    };
    if (similar !== null) {
      const old = { ...similar[1] };
      record.confidence = Math.max(record.confidence, old.confidence);
      record.importance = Math.max(record.importance, old.importance);
      record.access_count = old.access_count;
      record.last_accessed = old.last_accessed;
      await this.records.upsert(record);
      old.superseded_by = record.id;
      await this.records.upsert(old);
      return { type: "superseded", old: old.id, new: record.id };
    }
    await this.records.upsert(record);
    return { type: "inserted", id: record.id };
  }

  /**
   * Hybrid recall among records in `scopes`. Records about `present` people are candidates
   * even without a text or vector match. Recalled records are touched.
   */
  async recall(
    scopes: readonly MemoryScope[],
    present: readonly PersonId[],
    query: string,
    kinds: readonly MemoryKind[],
    limit: number,
    now: Timestamp,
    signal?: AbortSignal,
  ): Promise<Recalled[]> {
    const ranked = await this.#rank(
      scopes,
      present,
      query,
      kinds,
      limit,
      now,
      { includeDone: false, minScore: this.config.min_score },
      signal,
    );
    if (ranked.length > 0) {
      try {
        await this.records.touch(
          ranked.map((r) => r.record.id),
          now,
        );
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "touching recalled memories failed");
      }
    }
    return ranked.map(({ record, score }) => ({ record, score }));
  }

  /**
   * Hybrid search for browsing (the admin API): the candidates and score of `recall` with
   * nobody present, but records are not touched, followups already brought up are kept and
   * there is no score threshold. Only records matching the text or the vector are returned.
   */
  async search(
    scopes: readonly MemoryScope[],
    query: string,
    kinds: readonly MemoryKind[],
    limit: number,
    now: Timestamp,
    signal?: AbortSignal,
  ): Promise<Searched[]> {
    return this.#rank(
      scopes,
      [],
      query,
      kinds,
      limit,
      now,
      { includeDone: true, minScore: null },
      signal,
    );
  }

  async #rank(
    scopes: readonly MemoryScope[],
    present: readonly PersonId[],
    query: string,
    kinds: readonly MemoryKind[],
    limit: number,
    now: Timestamp,
    options: RankOptions,
    signal?: AbortSignal,
  ): Promise<Searched[]> {
    if (limit === 0 || scopes.length === 0) return [];
    const tokens = tokenize(query);
    const embedding = await this.#embedOne(query, signal);
    const wanted = (r: MemoryRecord) =>
      hasScope(scopes, r.scope) &&
      kinds.includes(r.kind) &&
      r.superseded_by === null &&
      (options.includeDone || !r.done);
    const fetch = Math.max(this.config.candidate_limit, limit);

    // id -> (record, backend text score, vector score)
    const candidates = new Map<string, [MemoryRecord, number, number | null]>();
    if (tokens.length > 0 || embedding !== null) {
      const hits = await this.records.search({
        profile: this.profile,
        scopes: [...scopes],
        kinds: [...kinds],
        tokens,
        embedding,
        limit: fetch,
      });
      for (const hit of hits) {
        if (wanted(hit.record)) {
          candidates.set(hit.record.id, [hit.record, hit.text_score, hit.vector_score]);
        }
      }
    }
    for (const person of present.slice(0, 16)) {
      const records = await this.records.list(
        this.profile,
        memoryFilter(fetch, { subject: person }),
      );
      for (const record of records) {
        if (wanted(record) && !candidates.has(record.id)) {
          candidates.set(record.id, [record, 0, null]);
        }
      }
    }

    let maxText = 0;
    for (const [, t] of candidates.values()) maxText = Math.max(maxText, t);
    const ranked: Searched[] = [];
    for (const [record, text, vectorScore] of candidates.values()) {
      const vector =
        vectorScore ??
        (embedding !== null && record.embedding !== null
          ? cosine(embedding, record.embedding)
          : null);
      const backend = maxText > 0 ? text / maxText : 0;
      const t = Math.max(backend, tokenOverlap(tokens, record.tokens));
      const s = signals(this.config, record, vector, t, present, now);
      const score = finalScore(this.config, record, s);
      if (options.minScore === null || score >= options.minScore) {
        ranked.push({ record, score, text_score: text, vector_score: vector });
      }
    }
    ranked.sort((a, b) => b.score - a.score || ms(b.record.updated_at) - ms(a.record.updated_at));
    ranked.length = Math.min(ranked.length, limit);
    return ranked;
  }

  static watermarkKey(context: ContextKey): string {
    return `${WATERMARK_PREFIX}${contextKeyString(context)}`;
  }

  /** The consolidation watermark of a context. */
  async watermark(context: ContextKey): Promise<Watermark | null> {
    const key = MemoryEngine.watermarkKey(context);
    const cached = this.#watermarks.get(key);
    if (cached) return structuredClone(cached);
    if (!this.#settings) return null;
    let value: JsonValue | null;
    try {
      value = await this.#settings.get(this.profile, key);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "reading memory watermark failed");
      return null;
    }
    const w = parseWatermark(value);
    if (!w) return null;
    this.#watermarks.set(key, w);
    return structuredClone(w);
  }

  async #setWatermark(watermark: Watermark): Promise<void> {
    const key = MemoryEngine.watermarkKey(watermark.context);
    this.#watermarks.set(key, structuredClone(watermark));
    if (!this.#settings) return;
    try {
      await this.#settings.set(this.profile, key, watermarkJson(watermark));
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "persisting memory watermark failed");
    }
  }

  /** Contexts with a persisted watermark (checked for new lines on start). */
  async watermarkedContexts(): Promise<ContextKey[]> {
    if (!this.#settings) return [];
    try {
      const map = await this.#settings.list(this.profile, WATERMARK_PREFIX);
      const out: ContextKey[] = [];
      for (const v of map.values()) {
        const w = parseWatermark(v);
        if (w) out.push(w.context);
      }
      return out;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "listing memory watermarks failed");
      return [];
    }
  }

  /**
   * Consolidates the lines of `context` written after its watermark.
   *
   * LLM failures are thrown (the watermark stays, so it is retried); malformed answers are
   * logged and the lines skipped.
   */
  async consolidate(
    context: ContextKey,
    now: Timestamp,
    signal?: AbortSignal,
  ): Promise<ConsolidationReport> {
    const messages = this.#messages;
    const router = this.#router;
    if (!messages || !router) {
      throw new MemoryError("consolidation needs a message log and the LLM router");
    }
    const report: ConsolidationReport = {
      lines: 0,
      inserted: 0,
      reinforced: 0,
      superseded: 0,
      skipped: 0,
      malformed: false,
    };
    const mark = await this.watermark(context);
    const lines = (
      await messages.recent(this.profile, context, Math.max(1, this.config.max_lines_per_batch))
    ).filter((e) => mark === null || afterMark(e, mark));
    const last = lines[lines.length - 1];
    if (!last) return report;
    report.lines = lines.length;
    const nextMark: Watermark = { context, ts: last.ts, id: last.id };
    if (lines.every((e) => e.is_self || e.text.trim() === "")) {
      await this.#setWatermark(nextMark);
      return report;
    }

    const speakers = await this.#speakers(lines);
    const priv = isPrivate(context);
    const request: ChatRequest = {
      messages: [
        systemMessage(systemPrompt(this.config.self_label)),
        userMessage(
          transcript(lines, this.config.self_label, priv, this.config.utc_offset_minutes),
        ),
      ],
      temperature: 0.2,
      max_tokens: 4000,
      json_mode: true,
      session: sessionId(this.profile, `memory-${contextHash(context)}`),
    };
    const response = await router.complete(this.config.purpose, request, signal);
    let extraction: Extraction;
    try {
      extraction = parseExtraction(response.text);
    } catch (error) {
      log.warn(
        { context: contextKeyString(context), error: errorMessage(error) },
        "unusable consolidation output, skipping lines",
      );
      report.malformed = true;
      await this.#setWatermark(nextMark);
      return report;
    }
    const first = speakers[0];
    const dmPartner = priv && speakers.length === 1 && first ? first.account : null;
    await this.#apply(extraction, context, dmPartner, speakers, now, report, signal);
    await this.#setWatermark(nextMark);
    log.debug({ context: contextKeyString(context), report }, "consolidated");
    return report;
  }

  async #speakers(lines: readonly LogEntry[]): Promise<Speaker[]> {
    const out: Speaker[] = [];
    for (const entry of lines) {
      if (entry.is_self) continue;
      const s = out.find((x) => sameAccount(x.account, entry.author));
      if (s) {
        if (!s.names.includes(entry.author_name)) s.names.push(entry.author_name);
      } else {
        out.push({ account: entry.author, names: [entry.author_name], person: null });
      }
    }
    if (this.#people) {
      for (const speaker of out) {
        try {
          const person = await this.#people.personByAccount(speaker.account);
          if (!person) continue;
          speaker.person = person.id;
          const names = [person.display_name, ...person.accounts.map((a) => a.display_name)];
          for (const name of names) {
            if (name !== "" && !speaker.names.includes(name)) speaker.names.push(name);
          }
        } catch (error) {
          log.warn({ error: errorMessage(error) }, "person lookup failed");
        }
      }
    }
    return out;
  }

  async #apply(
    x: Extraction,
    context: ContextKey,
    dmPartner: AccountRef | null,
    speakers: readonly Speaker[],
    now: Timestamp,
    report: ConsolidationReport,
    signal?: AbortSignal,
  ): Promise<void> {
    const min = this.config.min_importance;
    report.skipped += x.skipped;
    const everyone = speakers.flatMap((s) => (s.person !== null ? [s.person] : []));
    const scope = (kind: MemoryKind, global: PersonId | null) =>
      scopeForNew(this.config, context, dmPartner, kind, global);
    const items: NewMemory[] = [];
    const base = { source_context: context, due: null };

    if (x.episode) {
      const ep = x.episode;
      if (ep.importance >= min) {
        const emotion = ep.emotion?.trim() ?? "";
        items.push({
          ...base,
          kind: "episode",
          scope: scope("episode", null),
          subjects: [...everyone],
          content: emotion !== "" ? `${ep.summary}(當時我的心情:${emotion})` : ep.summary,
          importance: ep.importance,
          confidence: 1,
        });
      } else {
        report.skipped += 1;
      }
    }

    for (const fact of x.facts) {
      if (fact.importance < min) {
        report.skipped += 1;
        continue;
      }
      let kind: MemoryKind = "fact";
      let subjects: PersonId[];
      switch (fact.subject.type) {
        case "myself":
          kind = "self_note";
          subjects = [];
          break;
        case "named":
          subjects = optional(resolveName(fact.subject.name, speakers));
          break;
        case "unknown":
          subjects = mentioned(fact.statement, speakers);
          break;
      }
      const global = fact.subject.type === "named" && fact.global ? (subjects[0] ?? null) : null;
      items.push({
        ...base,
        kind,
        scope: scope(kind, global),
        subjects,
        content: fact.statement,
        importance: fact.importance,
        confidence: fact.confidence,
      });
    }

    for (const note of x.self_notes) {
      if (note.importance < min) {
        report.skipped += 1;
        continue;
      }
      items.push({
        ...base,
        kind: "self_note",
        scope: scope("self_note", null),
        subjects: mentioned(note.note, speakers),
        content: note.note,
        importance: note.importance,
        confidence: 1,
      });
    }

    for (const f of x.followups) {
      let subjects: PersonId[];
      switch (f.subject.type) {
        case "named":
          subjects = optional(resolveName(f.subject.name, speakers));
          break;
        case "myself":
          subjects = [];
          break;
        case "unknown":
          subjects = mentioned(f.about, speakers);
          break;
      }
      const minutes = Math.round(f.due_in_hours * 60);
      items.push({
        kind: "followup",
        scope: scope("followup", null),
        subjects,
        content: f.about,
        importance: 0.5,
        confidence: 1,
        source_context: context,
        due: toTimestamp(ms(now) + minutes * MINUTE_MS),
      });
    }

    for (const item of items) {
      const stored = await this.store(item, now, signal);
      if (stored.type === "inserted") report.inserted += 1;
      else if (stored.type === "reinforced") report.reinforced += 1;
      else report.superseded += 1;
    }
  }

  /**
   * Daily forgetting: prunes stale unimportant episodes and decays the confidence of facts not
   * reinforced recently (deleting the faintest).
   */
  async maintain(now: Timestamp): Promise<MaintenanceReport> {
    const f = this.config.forgetting;
    const nowMs = ms(now);
    const report: MaintenanceReport = {
      pruned: await this.records.prune(this.profile, {
        created_before: toTimestamp(nowMs - f.episode_max_age_days * DAY_MS),
        max_importance: f.episode_max_importance,
        not_accessed_since: toTimestamp(nowMs - f.episode_not_accessed_days * DAY_MS),
      }),
      decayed: 0,
      forgotten: 0,
    };

    const last = await this.lastMaintenanceRun();
    const elapsedDays =
      last === null ? 1 : Math.min(30, Math.max(0, Math.trunc((nowMs - ms(last)) / 1000)) / 86_400);
    const factor = Math.min(1, Math.max(0, f.decay_per_day)) ** elapsedDays;
    const staleBefore = nowMs - f.decay_after_days * DAY_MS;
    let before: Timestamp | null = null;
    for (;;) {
      const page = await this.records.list(
        this.profile,
        memoryFilter(500, { kind: "fact", before }),
      );
      const oldest = page[page.length - 1];
      if (!oldest) break;
      const nextBefore = oldest.created_at;
      const full = page.length === 500;
      for (const record of page) {
        if (ms(record.updated_at) >= staleBefore) continue;
        const confidence = record.confidence * factor;
        if (confidence < f.forget_below_confidence) {
          if (await this.records.delete(record.id)) report.forgotten += 1;
        } else if (confidence < record.confidence) {
          await this.records.upsert({ ...record, confidence });
          report.decayed += 1;
        }
      }
      if (!full || (before !== null && ms(before) === ms(nextBefore))) break;
      before = nextBefore;
    }
    await this.#setLastMaintenance(now);
    return report;
  }

  /** When maintenance last ran (memory first, then settings). */
  async lastMaintenanceRun(): Promise<Timestamp | null> {
    if (this.#lastMaintenance !== null) return this.#lastMaintenance;
    if (!this.#settings) return null;
    let value: JsonValue | null;
    try {
      value = await this.#settings.get(this.profile, MAINTENANCE_KEY);
    } catch {
      return null;
    }
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
    this.#lastMaintenance = value;
    return value;
  }

  async #setLastMaintenance(at: Timestamp): Promise<void> {
    this.#lastMaintenance = at;
    if (!this.#settings) return;
    try {
      await this.#settings.set(this.profile, MAINTENANCE_KEY, at);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "persisting maintenance time failed");
    }
  }

  /** Every record about this person or from the DM with this account, newest first. */
  async memoriesOf(
    person: PersonId | null,
    account: AccountRef,
    includeSuperseded: boolean,
  ): Promise<MemoryRecord[]> {
    const out: MemoryRecord[] = [];
    const filters: MemoryFilter[] = [
      memoryFilter(10_000, {
        scope: { type: "dm", account },
        include_superseded: includeSuperseded,
      }),
    ];
    if (person !== null) {
      filters.push(
        memoryFilter(10_000, { subject: person, include_superseded: includeSuperseded }),
        memoryFilter(10_000, {
          scope: { type: "person", person },
          include_superseded: includeSuperseded,
        }),
      );
    }
    const seen = new Set<string>();
    for (const filter of filters) {
      for (const record of await this.records.list(this.profile, filter)) {
        if (!seen.has(record.id)) {
          seen.add(record.id);
          out.push(record);
        }
      }
    }
    out.sort(
      (a, b) => ms(b.created_at) - ms(a.created_at) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0),
    );
    return out;
  }

  /**
   * Forgets this person's memories: those matching `keyword`, or all of them (`null`).
   * Returns how many records were deleted.
   */
  async forget(
    person: PersonId | null,
    account: AccountRef,
    keyword: string | null,
  ): Promise<number> {
    let deleted = 0;
    const records = await this.memoriesOf(person, account, true);
    for (const record of records) {
      if (keyword !== null && !matchesKeyword(record, keyword)) continue;
      if (await this.records.delete(record.id)) deleted += 1;
    }
    if (keyword === null && person !== null) {
      deleted += await this.records.deleteBySubject(this.profile, person);
    }
    return deleted;
  }

  // ---- FollowupSource ------------------------------------------------------------------

  async due(profile: ProfileId, now: Timestamp): Promise<Followup[]> {
    return (await this.records.dueFollowups(profile, now)).map(toFollowup);
  }

  async markDone(id: string): Promise<void> {
    if (!isUlid(id.toUpperCase())) {
      throw new MemoryError(`invalid followup id \`${id}\`: not a ULID`);
    }
    const record = await this.records.get(id);
    if (!record) throw new MemoryError(`unknown followup \`${id}\``);
    if (record.kind !== "followup") throw new MemoryError(`memory \`${id}\` is not a followup`);
    await this.records.upsert({
      ...record,
      done: true,
      updated_at: toTimestamp(this.#clock.now()),
    });
  }
}

/** `MemoryEngine` service (Rust `Arc<MemoryEngine>`). */
export const MemoryEngineKey = serviceKey<MemoryEngine>("MemoryEngine");

function afterMark(e: LogEntry, w: Watermark): boolean {
  const a = ms(e.ts);
  const b = ms(w.ts);
  return a > b || (a === b && e.id > w.id);
}

function watermarkJson(w: Watermark): JsonValue {
  return {
    context: { ...w.context },
    ts: w.ts,
    id: w.id,
  };
}

function parseWatermark(value: JsonValue | null | undefined): Watermark | null {
  if (!isJsonObject(value)) return null;
  const { context, ts, id } = value;
  if (!isJsonObject(context) || typeof ts !== "string" || typeof id !== "string") return null;
  const { platform, scope, channel, kind } = context;
  if (
    typeof platform !== "string" ||
    !(scope === null || typeof scope === "string") ||
    typeof channel !== "string" ||
    !(kind === "channel" || kind === "thread" || kind === "dm" || kind === "voice") ||
    Number.isNaN(Date.parse(ts)) ||
    !isUlid(id)
  ) {
    return null;
  }
  return { context: { platform, scope, channel, kind }, ts, id };
}

/** Content contains the keyword, or the record has all of its tokens. */
export function matchesKeyword(record: MemoryRecord, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (kw === "") return false;
  if (record.content.toLowerCase().includes(kw)) return true;
  const tokens = tokenize(kw);
  return tokens.length > 0 && tokens.every((t) => tokenOverlap([t], record.tokens) > 0);
}

function optional<T>(value: T | null): T[] {
  return value === null ? [] : [value];
}

const charCount = (s: string) => [...s].length;

/** The person a name from the summarizer refers to. */
function resolveName(raw: string, speakers: readonly Speaker[]): PersonId | null {
  const name = raw.trim().replace(/^@+/, "").toLowerCase();
  if (name === "") return null;
  const exact = speakers.find((s) => s.names.some((n) => n.toLowerCase() === name));
  if (exact) return exact.person;
  const partial = speakers.filter((s) =>
    s.names.some((n) => {
      const lower = n.toLowerCase();
      return charCount(lower) >= 2 && (name.includes(lower) || lower.includes(name));
    }),
  );
  return partial.length === 1 ? (partial[0]?.person ?? null) : null;
}

/** People whose names appear in `text`. */
function mentioned(raw: string, speakers: readonly Speaker[]): PersonId[] {
  const text = raw.toLowerCase();
  return speakers
    .filter((s) => s.names.some((n) => charCount(n) >= 2 && text.includes(n.toLowerCase())))
    .flatMap((s) => (s.person !== null ? [s.person] : []));
}

/** Turns a followup record into the shared `Followup` type. */
export function toFollowup(record: MemoryRecord): Followup {
  return {
    id: record.id,
    profile: record.profile,
    person: record.subjects[0] ?? null,
    context: record.source_context,
    about: record.content,
    due: record.due ?? record.created_at,
  };
}
