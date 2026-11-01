// SQLite backend on the built-in `node:sqlite` (`DatabaseSync`). A file database or `:memory:`
// (which replaces the Rust in-memory backend for tests and quick runs).
//
// Every call is synchronous inside an async method, so one call never interleaves with another
// in this process: read-modify-write sequences run inside one `BEGIN IMMEDIATE` transaction
// without awaiting. Other processes on the same file are handled by WAL and the busy timeout.
//
// Timestamps are INTEGER microseconds since the epoch, JSON values are text, embeddings are
// little-endian float32 BLOBs (cosine computed in JS), full text uses FTS5 over `tokens`.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { getLogger } from "@miyoria/kernel";
import {
  type AccountRef,
  type Clock,
  type ContextKey,
  type ContextKind,
  type DecisionTrace,
  type JsonValue,
  type ModuleId,
  newId,
  type PersonId,
  type PlatformId,
  type ProfileId,
  systemClock,
  type Timestamp,
} from "@miyoria/types";
import {
  authScopeKey,
  canonicalMemoryScope,
  cleanEmbedding,
  contextLookupKey,
  cosine,
  decodeEmbedding,
  embeddingFromF32,
  encodeEmbedding,
  fromMicros,
  MAX_DECISIONS,
  memoryKind,
  memoryScopeKey,
  optionalMicros,
  optionalTimestamp,
  parseJson,
  queryTokens,
  StoreError,
  sqlLimit,
  toMicros,
  u32,
} from "./common.js";
import type {
  Account,
  AuditEntry,
  AuthScope,
  DecisionRecord,
  LogEntry,
  MemoryFilter,
  MemoryHit,
  MemoryQuery,
  MemoryRecord,
  MemoryScope,
  NodeOverride,
  Person,
  PersonaOverride,
  PrunePolicy,
  Relationship,
  RelationshipDelta,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
} from "./records.js";
import type {
  AuditLog,
  AuthStore,
  DecisionLog,
  IdentityStore,
  MemoryRecordStore,
  MessageLog,
  ModuleStateStore,
  PeopleStore,
  PersonaOverrideStore,
  RelationshipStore,
  SettingsStore,
  Store,
} from "./stores.js";

const log = getLogger("store.sqlite");

/** Ordered `NNNN_name.sql` files, applied once each and recorded in `schema_version`. */
const MIGRATIONS_DIR = new URL("../migrations/sqlite/", import.meta.url);

export interface SqliteStoreOptions {
  /** Source of "now" for rows stamped by the store (`edited_at`, `first_seen`, ...). */
  clock?: Clock;
  /** How long a write waits for another process's lock. Default 5000 ms. */
  busyTimeoutMs?: number;
  /**
   * Decisions kept per profile (older ones are dropped); `null` keeps all. Default: 10 000 for
   * `:memory:` (like the Rust in-memory backend), unbounded for files (like PostgreSQL).
   */
  maxDecisionsPerProfile?: number | null;
}

type Row = Record<string, SQLOutputValue>;
type Params = Record<string, SQLInputValue>;

// ---- row accessors ----------------------------------------------------------------------

function str(row: Row, column: string): string {
  const v = row[column];
  if (typeof v !== "string") throw new StoreError(`column \`${column}\` is not text`);
  return v;
}

function optStr(row: Row, column: string): string | null {
  const v = row[column];
  return v === null || v === undefined ? null : str(row, column);
}

function num(row: Row, column: string): number {
  const v = row[column];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new StoreError(`column \`${column}\` is not a number`);
}

function optNum(row: Row, column: string): number | null {
  const v = row[column];
  return v === null || v === undefined ? null : num(row, column);
}

function bool(row: Row, column: string): boolean {
  return num(row, column) !== 0;
}

function json<T>(row: Row, column: string, what: string): T {
  return parseJson<T>(str(row, column), what);
}

function ts(row: Row, column: string): Timestamp {
  return fromMicros(num(row, column));
}

function optTs(row: Row, column: string): Timestamp | null {
  return optionalTimestamp(optNum(row, column));
}

function isConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { errcode?: unknown }).errcode;
  return typeof code === "number" && (code & 0xff) === 19; // SQLITE_CONSTRAINT
}

/** `null` limits are "no limit", SQLite's `LIMIT -1`. */
function limitParam(limit: number): number {
  return sqlLimit(limit) ?? -1;
}

// ---- backend core -----------------------------------------------------------------------

class Db {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  readonly clock: Clock;
  #open = true;

  constructor(db: DatabaseSync, clock: Clock) {
    this.#db = db;
    this.clock = clock;
  }

  nowMicros(): number {
    return Math.floor(this.clock.now()) * 1000;
  }

  #stmt(sql: string): StatementSync {
    if (!this.#open) throw new StoreError("the store is closed");
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  all(sql: string, params: Params = {}): Row[] {
    return this.#stmt(sql).all(params);
  }

  get(sql: string, params: Params = {}): Row | undefined {
    return this.#stmt(sql).get(params);
  }

  run(sql: string, params: Params = {}): number {
    return Number(this.#stmt(sql).run(params).changes);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  /** Runs `fn` in one write transaction. `fn` must not await. */
  tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#statements.clear();
    this.#db.close();
  }
}

function migrate(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (" +
      "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const known = new Set(files.map((f) => Number.parseInt(f, 10)));
  const applied = new Set(
    db.all("SELECT version FROM schema_version").map((r) => num(r, "version")),
  );
  for (const version of applied) {
    if (!known.has(version)) {
      throw new StoreError(`migration ${version} was previously applied but is missing`);
    }
  }
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (applied.has(version)) continue;
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), "utf8");
    try {
      db.tx(() => {
        db.exec(sql);
        db.run("INSERT INTO schema_version (version, name, applied_at) VALUES ($v, $name, $at)", {
          v: version,
          name: file.replace(/\.sql$/, ""),
          at: db.nowMicros(),
        });
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("database migration failed", { cause });
    }
    log.info({ version, file }, "applied database migration");
  }
  log.debug("database migrations are up to date");
}

// ---- conversation log ---------------------------------------------------------------------

function logEntryFromRow(row: Row): LogEntry {
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    context: {
      platform: str(row, "platform"),
      scope: optStr(row, "scope"),
      channel: str(row, "channel"),
      kind: str(row, "kind") as ContextKind,
    },
    author: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    author_name: str(row, "author_name"),
    text: str(row, "text"),
    is_self: bool(row, "is_self"),
    ts: ts(row, "ts"),
    turn: optStr(row, "turn_id"),
  };
}

class SqliteMessageLog implements MessageLog {
  constructor(private readonly db: Db) {}

  async append(entry: LogEntry): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO message_log (id, profile_id, context_key, platform, scope, channel, kind, " +
          "author_platform, author_id, author_name, text, is_self, ts, turn_id) VALUES ($id, " +
          "$profile, $key, $platform, $scope, $channel, $kind, $author_platform, $author_id, " +
          "$author_name, $text, $is_self, $ts, $turn)",
        {
          id: entry.id,
          profile: entry.profile,
          key: contextLookupKey(entry.context),
          platform: entry.context.platform,
          scope: entry.context.scope,
          channel: entry.context.channel,
          kind: entry.context.kind,
          author_platform: entry.author.platform,
          author_id: entry.author.id,
          author_name: entry.author_name,
          text: entry.text,
          is_self: entry.is_self ? 1 : 0,
          ts: toMicros(entry.ts),
          turn: entry.turn,
        },
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (isConstraintError(cause)) {
        throw new StoreError(`log entry \`${entry.id}\` already exists`, { cause });
      }
      throw new StoreError("cannot append log entry", { cause });
    }
  }

  async recent(profile: ProfileId, context: ContextKey, limit: number): Promise<LogEntry[]> {
    const rows = this.db.all(
      "SELECT * FROM (SELECT * FROM message_log WHERE profile_id = $profile AND " +
        "context_key = $key ORDER BY ts DESC, seq DESC LIMIT $limit) ORDER BY ts ASC, seq ASC",
      { profile, key: contextLookupKey(context), limit: limitParam(limit) },
    );
    return rows.map(logEntryFromRow);
  }
}

// ---- module state -------------------------------------------------------------------------

class SqliteModuleState implements ModuleStateStore {
  constructor(private readonly db: Db) {}

  async get(module: ModuleId): Promise<boolean | null> {
    const row = this.db.get("SELECT enabled FROM module_state WHERE module_id = $module", {
      module,
    });
    return row ? bool(row, "enabled") : null;
  }

  async set(module: ModuleId, enabled: boolean): Promise<void> {
    this.db.run(
      "INSERT INTO module_state (module_id, enabled, updated_at) VALUES ($module, $enabled, " +
        "$at) ON CONFLICT (module_id) DO UPDATE SET enabled = excluded.enabled, " +
        "updated_at = excluded.updated_at",
      { module, enabled: enabled ? 1 : 0, at: this.db.nowMicros() },
    );
  }

  async list(): Promise<Map<ModuleId, boolean>> {
    const rows = this.db.all("SELECT module_id, enabled FROM module_state ORDER BY module_id");
    return new Map(rows.map((r) => [str(r, "module_id"), bool(r, "enabled")]));
  }
}

// ---- persona overrides --------------------------------------------------------------------

class SqlitePersonaOverrides implements PersonaOverrideStore {
  constructor(private readonly db: Db) {}

  async set(profile: ProfileId, key: string, body: string, editedBy: string): Promise<number> {
    // One statement: the next version is computed under SQLite's write lock.
    const row = this.db.get(
      "INSERT INTO persona_overrides (profile_id, section_key, version, body, edited_by, " +
        "edited_at) SELECT $profile, $key, COALESCE(MAX(version), 0) + 1, $body, $by, $at " +
        "FROM persona_overrides WHERE profile_id = $profile AND section_key = $key " +
        "RETURNING version",
      { profile, key, body, by: editedBy, at: this.db.nowMicros() },
    );
    if (!row) throw new StoreError("cannot store persona override");
    return num(row, "version");
  }

  async current(profile: ProfileId): Promise<Map<string, string>> {
    const rows = this.db.all(
      "SELECT section_key, body FROM persona_overrides o WHERE profile_id = $profile AND " +
        "version = (SELECT MAX(version) FROM persona_overrides WHERE profile_id = " +
        "o.profile_id AND section_key = o.section_key) ORDER BY section_key",
      { profile },
    );
    return new Map(rows.map((r) => [str(r, "section_key"), str(r, "body")]));
  }

  async history(profile: ProfileId, key: string): Promise<PersonaOverride[]> {
    const rows = this.db.all(
      "SELECT version, body, edited_by, edited_at FROM persona_overrides " +
        "WHERE profile_id = $profile AND section_key = $key ORDER BY version ASC",
      { profile, key },
    );
    return rows.map((r) => ({
      profile,
      key,
      version: num(r, "version"),
      body: str(r, "body"),
      edited_by: str(r, "edited_by"),
      edited_at: ts(r, "edited_at"),
    }));
  }
}

// ---- people and identity ------------------------------------------------------------------

function accountFromRow(row: Row): Account {
  return {
    account: { platform: str(row, "platform"), id: str(row, "account_id") },
    display_name: str(row, "display_name"),
    first_seen: ts(row, "first_seen"),
    last_seen: ts(row, "last_seen"),
  };
}

const ACCOUNTS_OF =
  "SELECT platform, account_id, display_name, first_seen, last_seen FROM accounts " +
  "WHERE person_id = $person ORDER BY first_seen, platform, account_id";

class SqlitePeople implements PeopleStore {
  constructor(private readonly db: Db) {}

  async upsertAccount(account: AccountRef, displayName: string): Promise<PersonId> {
    const now = this.db.nowMicros();
    return this.db.tx(() => {
      const existing = this.db.get(
        "UPDATE accounts SET display_name = $name, last_seen = $now " +
          "WHERE platform = $platform AND account_id = $id RETURNING person_id",
        { platform: account.platform, id: account.id, name: displayName, now },
      );
      if (existing) return str(existing, "person_id");
      const person = newId();
      this.db.run(
        "INSERT INTO people (id, display_name, created_at) VALUES ($person, $name, $now)",
        { person, name: displayName, now },
      );
      this.db.run(
        "INSERT INTO accounts (platform, account_id, person_id, display_name, first_seen, " +
          "last_seen) VALUES ($platform, $id, $person, $name, $now, $now)",
        { platform: account.platform, id: account.id, person, name: displayName, now },
      );
      return person;
    });
  }

  async personByAccount(account: AccountRef): Promise<Person | null> {
    const row = this.db.get(
      "SELECT p.id, p.display_name, p.created_at FROM accounts a " +
        "JOIN people p ON p.id = a.person_id WHERE a.platform = $platform AND a.account_id = $id",
      { platform: account.platform, id: account.id },
    );
    if (!row) return null;
    const id = str(row, "id");
    return {
      id,
      display_name: str(row, "display_name"),
      created_at: ts(row, "created_at"),
      accounts: this.db.all(ACCOUNTS_OF, { person: id }).map(accountFromRow),
    };
  }

  async all(): Promise<Person[]> {
    const accounts = new Map<PersonId, Account[]>();
    const rows = this.db.all(
      "SELECT person_id, platform, account_id, display_name, first_seen, last_seen FROM accounts " +
        "ORDER BY first_seen, platform, account_id",
    );
    for (const row of rows) {
      const person = str(row, "person_id");
      const list = accounts.get(person) ?? [];
      list.push(accountFromRow(row));
      accounts.set(person, list);
    }
    return this.db
      .all("SELECT id, display_name, created_at FROM people ORDER BY created_at, id")
      .map((row) => ({
        id: str(row, "id"),
        display_name: str(row, "display_name"),
        created_at: ts(row, "created_at"),
        accounts: accounts.get(str(row, "id")) ?? [],
      }));
  }
}

class SqliteIdentity implements IdentityStore {
  constructor(private readonly db: Db) {}

  #exists(person: PersonId): boolean {
    return this.db.get("SELECT 1 AS x FROM people WHERE id = $person", { person }) !== undefined;
  }

  async linkAccount(account: AccountRef, person: PersonId): Promise<void> {
    const now = this.db.nowMicros();
    this.db.tx(() => {
      if (!this.#exists(person)) throw new StoreError(`unknown person \`${person}\``);
      // A new account row has no name yet; its id stands in until the account is seen.
      this.db.run(
        "INSERT INTO accounts (platform, account_id, person_id, display_name, first_seen, " +
          "last_seen) VALUES ($platform, $id, $person, $id, $now, $now) " +
          "ON CONFLICT (platform, account_id) DO UPDATE SET person_id = excluded.person_id",
        { platform: account.platform, id: account.id, person, now },
      );
    });
  }

  async mergePeople(keep: PersonId, absorb: PersonId): Promise<void> {
    this.db.tx(() => {
      for (const person of [keep, absorb]) {
        if (!this.#exists(person)) throw new StoreError(`unknown person \`${person}\``);
      }
      if (keep === absorb) return;
      this.db.run("UPDATE accounts SET person_id = $keep WHERE person_id = $absorb", {
        keep,
        absorb,
      });
      this.db.run("DELETE FROM people WHERE id = $absorb", { absorb });
    });
  }

  async accountsOf(person: PersonId): Promise<Account[]> {
    return this.db.all(ACCOUNTS_OF, { person }).map(accountFromRow);
  }

  async setPersonName(person: PersonId, displayName: string): Promise<void> {
    const changed = this.db.run("UPDATE people SET display_name = $name WHERE id = $person", {
      person,
      name: displayName,
    });
    if (changed === 0) throw new StoreError(`unknown person \`${person}\``);
  }

  async createLinkCode(code: string, account: AccountRef, expiresAt: Timestamp): Promise<void> {
    this.db.run(
      "INSERT INTO link_codes (code, platform, account_id, expires_at) VALUES ($code, " +
        "$platform, $id, $expires) ON CONFLICT (code) DO UPDATE SET platform = " +
        "excluded.platform, account_id = excluded.account_id, expires_at = excluded.expires_at",
      { code, platform: account.platform, id: account.id, expires: toMicros(expiresAt) },
    );
  }

  async consumeLinkCode(code: string, now: Timestamp): Promise<AccountRef | null> {
    const row = this.db.get(
      "DELETE FROM link_codes WHERE code = $code RETURNING platform, account_id, expires_at",
      { code },
    );
    if (!row || num(row, "expires_at") <= toMicros(now)) return null;
    return { platform: str(row, "platform"), id: str(row, "account_id") };
  }
}

// ---- decisions ----------------------------------------------------------------------------

class SqliteDecisionLog implements DecisionLog {
  /** Rows per profile, tracked only when capped (the database has no other writer then). */
  readonly #counts = new Map<ProfileId, number>();

  constructor(
    private readonly db: Db,
    private readonly cap: number | null,
  ) {}

  async append(record: DecisionRecord): Promise<void> {
    const params = {
      id: record.id,
      profile: record.profile,
      key: contextLookupKey(record.trace.context),
      ts: toMicros(record.ts),
      trace: JSON.stringify(record.trace),
    };
    try {
      this.db.tx(() => {
        this.db.run(
          "INSERT INTO decision_log (id, profile_id, context_key, ts, trace) " +
            "VALUES ($id, $profile, $key, $ts, $trace)",
          params,
        );
        if (this.cap !== null) this.#trim(record.profile, this.cap);
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (isConstraintError(cause)) {
        throw new StoreError(`decision \`${record.id}\` already exists`, { cause });
      }
      throw new StoreError("cannot append decision", { cause });
    }
  }

  #trim(profile: ProfileId, cap: number): void {
    let count = this.#counts.get(profile);
    if (count === undefined) {
      const row = this.db.get("SELECT count(*) AS n FROM decision_log WHERE profile_id = $p", {
        p: profile,
      });
      count = row ? num(row, "n") : 0;
    } else {
      count += 1;
    }
    if (count > cap) {
      this.db.run(
        "DELETE FROM decision_log WHERE id IN (SELECT id FROM decision_log WHERE " +
          "profile_id = $p ORDER BY ts ASC, id ASC LIMIT $n)",
        { p: profile, n: count - cap },
      );
      count = cap;
    }
    this.#counts.set(profile, count);
  }

  async recent(
    profile: ProfileId,
    context: ContextKey | null,
    limit: number,
  ): Promise<DecisionRecord[]> {
    const rows =
      context === null
        ? this.db.all(
            "SELECT id, ts, trace FROM decision_log WHERE profile_id = $profile " +
              "ORDER BY ts DESC, id DESC LIMIT $limit",
            { profile, limit: limitParam(limit) },
          )
        : this.db.all(
            "SELECT id, ts, trace FROM decision_log WHERE profile_id = $profile AND " +
              "context_key = $key ORDER BY ts DESC, id DESC LIMIT $limit",
            { profile, key: contextLookupKey(context), limit: limitParam(limit) },
          );
    return rows.map((r) => ({
      id: str(r, "id"),
      profile,
      ts: ts(r, "ts"),
      trace: json<DecisionTrace>(r, "trace", "decision trace"),
    }));
  }
}

// ---- settings -----------------------------------------------------------------------------

class SqliteSettings implements SettingsStore {
  constructor(private readonly db: Db) {}

  async get(profile: ProfileId, key: string): Promise<JsonValue | null> {
    const row = this.db.get(
      "SELECT value FROM profile_settings WHERE profile_id = $profile AND key = $key",
      { profile, key },
    );
    return row ? json<JsonValue>(row, "value", "setting") : null;
  }

  async set(profile: ProfileId, key: string, value: JsonValue | null): Promise<void> {
    if (value === null) {
      this.db.run("DELETE FROM profile_settings WHERE profile_id = $profile AND key = $key", {
        profile,
        key,
      });
      return;
    }
    this.db.run(
      "INSERT INTO profile_settings (profile_id, key, value, updated_at) VALUES ($profile, " +
        "$key, $value, $at) ON CONFLICT (profile_id, key) DO UPDATE SET value = " +
        "excluded.value, updated_at = excluded.updated_at",
      { profile, key, value: JSON.stringify(value), at: this.db.nowMicros() },
    );
  }

  async list(profile: ProfileId, prefix: string): Promise<Map<string, JsonValue>> {
    // `substr` instead of `LIKE`, so `%` and `_` in the prefix are literal (and case matters).
    const rows = this.db.all(
      "SELECT key, value FROM profile_settings WHERE profile_id = $profile AND " +
        "substr(key, 1, length($prefix)) = $prefix ORDER BY key",
      { profile, prefix },
    );
    return new Map(rows.map((r) => [str(r, "key"), json<JsonValue>(r, "value", "setting")]));
  }
}

// ---- memory records -----------------------------------------------------------------------

function memoryFromRow(row: Row): MemoryRecord {
  const embedding = row.embedding;
  const sourceContext = optStr(row, "source_context");
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    kind: memoryKind(str(row, "kind")),
    scope: json<MemoryScope>(row, "scope", "memory scope"),
    subjects: json<PersonId[]>(row, "subjects", "memory subjects"),
    content: str(row, "content"),
    tokens: str(row, "tokens"),
    embedding:
      embedding instanceof Uint8Array ? embeddingFromF32(decodeEmbedding(embedding)) : null,
    importance: num(row, "importance"),
    confidence: num(row, "confidence"),
    created_at: ts(row, "created_at"),
    updated_at: ts(row, "updated_at"),
    last_accessed: optTs(row, "last_accessed"),
    access_count: u32(num(row, "access_count")),
    source_context:
      sourceContext === null ? null : parseJson<ContextKey>(sourceContext, "memory source context"),
    due: optTs(row, "due"),
    done: bool(row, "done"),
    superseded_by: optStr(row, "superseded_by"),
  };
}

/** Newest first, ties broken by id (descending). */
function newestFirst(a: Row, b: Row): number {
  const at = num(a, "created_at");
  const bt = num(b, "created_at");
  if (at !== bt) return bt - at;
  const ai = str(a, "id");
  const bi = str(b, "id");
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

/** An FTS5 query string matching any of the tokens (each one a quoted phrase). */
function ftsMatch(tokens: readonly string[]): string {
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

const SEARCH_FILTER =
  "m.profile_id = $profile AND m.scope_key IN (SELECT value FROM json_each($scopes)) " +
  "AND ($kinds IS NULL OR m.kind IN (SELECT value FROM json_each($kinds))) " +
  "AND m.superseded_by IS NULL";

class SqliteMemories implements MemoryRecordStore {
  constructor(private readonly db: Db) {}

  async upsert(record: MemoryRecord): Promise<void> {
    const embedding = cleanEmbedding(record.embedding);
    const scope = canonicalMemoryScope(record.scope);
    try {
      this.db.run(
        "INSERT INTO memory_records (id, profile_id, kind, scope, scope_key, subjects, " +
          "content, tokens, embedding, importance, confidence, created_at, updated_at, " +
          "last_accessed, access_count, source_context, due, done, superseded_by) VALUES ($id, " +
          "$profile, $kind, $scope, $scope_key, $subjects, $content, $tokens, $embedding, " +
          "$importance, $confidence, $created_at, $updated_at, $last_accessed, $access_count, " +
          "$source_context, $due, $done, $superseded_by) ON CONFLICT (id) DO UPDATE SET " +
          "profile_id = excluded.profile_id, kind = excluded.kind, scope = excluded.scope, " +
          "scope_key = excluded.scope_key, subjects = excluded.subjects, content = " +
          "excluded.content, tokens = excluded.tokens, embedding = excluded.embedding, " +
          "importance = excluded.importance, confidence = excluded.confidence, created_at = " +
          "excluded.created_at, updated_at = excluded.updated_at, last_accessed = " +
          "excluded.last_accessed, access_count = excluded.access_count, source_context = " +
          "excluded.source_context, due = excluded.due, done = excluded.done, superseded_by = " +
          "excluded.superseded_by",
        {
          id: record.id,
          profile: record.profile,
          kind: memoryKind(record.kind),
          scope: JSON.stringify(scope),
          scope_key: JSON.stringify(scope),
          subjects: JSON.stringify(record.subjects),
          content: record.content,
          tokens: record.tokens,
          embedding: embedding === null ? null : encodeEmbedding(embedding),
          importance: record.importance,
          confidence: record.confidence,
          created_at: toMicros(record.created_at),
          updated_at: toMicros(record.updated_at),
          last_accessed: optionalMicros(record.last_accessed),
          access_count: u32(record.access_count),
          source_context:
            record.source_context === null ? null : contextLookupKey(record.source_context),
          due: optionalMicros(record.due),
          done: record.done ? 1 : 0,
          superseded_by: record.superseded_by,
        },
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store memory record", { cause });
    }
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const row = this.db.get("SELECT * FROM memory_records WHERE id = $id", { id });
    return row ? memoryFromRow(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    return this.db.run("DELETE FROM memory_records WHERE id = $id", { id }) > 0;
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const embedding = cleanEmbedding(query.embedding);
    const limit = sqlLimit(query.limit);
    if (limit === 0) return [];
    const filter = {
      profile: query.profile,
      scopes: JSON.stringify(query.scopes.map(memoryScopeKey)),
      kinds: query.kinds === null ? null : JSON.stringify(query.kinds),
    };
    const hits: MemoryHit[] = [];

    // Full text: OR of the tokens; relevance is FTS5's BM25 (negated, so higher is better).
    const tokens = queryTokens(query.tokens);
    if (tokens.length > 0) {
      let rows: Row[];
      try {
        rows = this.db.all(
          "SELECT m.*, -bm25(memory_fts) AS score FROM memory_fts " +
            "JOIN memory_records m ON m.seq = memory_fts.rowid " +
            `WHERE memory_fts MATCH $match AND ${SEARCH_FILTER} ` +
            "ORDER BY score DESC, m.created_at DESC, m.id DESC LIMIT $limit",
          { ...filter, match: ftsMatch(tokens), limit: limit ?? -1 },
        );
      } catch (cause) {
        if (cause instanceof StoreError) throw cause;
        throw new StoreError("memory text search failed", { cause });
      }
      for (const row of rows) {
        hits.push({
          record: memoryFromRow(row),
          text_score: num(row, "score"),
          vector_score: null,
        });
      }
    }

    // Nearest neighbours: exact cosine over the rows with the query's dimension.
    if (embedding !== null) {
      const query32 = Float32Array.from(embedding);
      const rows = this.db.all(
        `SELECT * FROM memory_records m WHERE ${SEARCH_FILTER} ` +
          "AND m.embedding IS NOT NULL AND length(m.embedding) = $bytes",
        { ...filter, bytes: embedding.length * 4 },
      );
      const scored = rows
        .map((row) => ({
          row,
          score: cosine(decodeEmbedding(row.embedding as Uint8Array), query32),
        }))
        .sort((a, b) => b.score - a.score || newestFirst(a.row, b.row))
        .slice(0, limit ?? undefined);
      for (const { row, score } of scored) {
        const id = str(row, "id");
        const hit = hits.find((h) => h.record.id === id);
        if (hit) hit.vector_score = score;
        else hits.push({ record: memoryFromRow(row), text_score: 0, vector_score: score });
      }
    }
    return hits;
  }

  async list(profile: ProfileId, filter: MemoryFilter): Promise<MemoryRecord[]> {
    const rows = this.db.all(
      "SELECT * FROM memory_records WHERE profile_id = $profile " +
        "AND ($subject IS NULL OR EXISTS (SELECT 1 FROM json_each(subjects) WHERE value = " +
        "$subject)) AND ($scope IS NULL OR scope_key = $scope) " +
        "AND ($kind IS NULL OR kind = $kind) AND ($before IS NULL OR created_at < $before) " +
        "AND ($all = 1 OR superseded_by IS NULL) " +
        "ORDER BY created_at DESC, id DESC LIMIT $limit",
      {
        profile,
        subject: filter.subject,
        scope: filter.scope === null ? null : memoryScopeKey(filter.scope),
        kind: filter.kind,
        before: optionalMicros(filter.before),
        all: filter.include_superseded ? 1 : 0,
        limit: limitParam(filter.limit),
      },
    );
    return rows.map(memoryFromRow);
  }

  async touch(ids: readonly string[], at: Timestamp): Promise<void> {
    if (ids.length === 0) return;
    this.db.run(
      "UPDATE memory_records SET access_count = min(access_count + 1, 4294967295), " +
        "last_accessed = $at WHERE id IN (SELECT value FROM json_each($ids))",
      { ids: JSON.stringify([...new Set(ids)]), at: toMicros(at) },
    );
  }

  async dueFollowups(profile: ProfileId, now: Timestamp): Promise<MemoryRecord[]> {
    const rows = this.db.all(
      "SELECT * FROM memory_records WHERE profile_id = $profile AND kind = 'followup' AND " +
        "NOT done AND due IS NOT NULL AND superseded_by IS NULL AND due <= $now " +
        "ORDER BY due ASC, id ASC",
      { profile, now: toMicros(now) },
    );
    return rows.map(memoryFromRow);
  }

  async prune(profile: ProfileId, policy: PrunePolicy): Promise<number> {
    return this.db.run(
      "DELETE FROM memory_records WHERE profile_id = $profile AND kind = 'episode' AND " +
        "created_at < $before AND importance <= $max AND (last_accessed IS NULL OR " +
        "last_accessed < $since)",
      {
        profile,
        before: toMicros(policy.created_before),
        max: policy.max_importance,
        since: toMicros(policy.not_accessed_since),
      },
    );
  }

  async deleteBySubject(profile: ProfileId, person: PersonId): Promise<number> {
    return this.db.run(
      "DELETE FROM memory_records WHERE profile_id = $profile AND (EXISTS (SELECT 1 FROM " +
        "json_each(subjects) WHERE value = $person) OR scope_key = $scope)",
      { profile, person, scope: memoryScopeKey({ type: "person", person }) },
    );
  }

  async mergePerson(keep: PersonId, absorb: PersonId): Promise<number> {
    if (keep === absorb) return 0;
    const absorbScope = memoryScopeKey({ type: "person", person: absorb });
    const keepScope = memoryScopeKey({ type: "person", person: keep });
    // `tokens` is untouched, so the FTS triggers do not fire and `seq` (the FTS rowid) stays.
    return this.db.tx(() => {
      const rows = this.db.all(
        "SELECT id, subjects, scope_key FROM memory_records WHERE EXISTS (SELECT 1 FROM " +
          "json_each(subjects) WHERE value = $absorb) OR scope_key = $scope",
        { absorb, scope: absorbScope },
      );
      for (const row of rows) {
        const subjects = json<PersonId[]>(row, "subjects", "memory subjects");
        const moved = [...new Set(subjects.map((s) => (s === absorb ? keep : s)))];
        const rescoped = str(row, "scope_key") === absorbScope;
        this.db.run(
          "UPDATE memory_records SET subjects = $subjects, " +
            "scope = CASE WHEN $rescope THEN $scope ELSE scope END, " +
            "scope_key = CASE WHEN $rescope THEN $scope ELSE scope_key END WHERE id = $id",
          {
            id: str(row, "id"),
            subjects: JSON.stringify(moved),
            rescope: rescoped ? 1 : 0,
            scope: keepScope,
          },
        );
      }
      return rows.length;
    });
  }
}

// ---- relationships ------------------------------------------------------------------------

function relationshipFromRow(row: Row): Relationship {
  return {
    profile: str(row, "profile_id"),
    person: str(row, "person_id"),
    affinity: num(row, "affinity"),
    trust: num(row, "trust"),
    familiarity: num(row, "familiarity"),
    tags: json<string[]>(row, "tags", "relationship tags"),
    notes: str(row, "notes"),
    call_name: optStr(row, "call_name"),
    interactions: u32(num(row, "interactions")),
    last_interaction: optTs(row, "last_interaction"),
    updated_at: ts(row, "updated_at"),
  };
}

class SqliteRelationships implements RelationshipStore {
  constructor(private readonly db: Db) {}

  async get(profile: ProfileId, person: PersonId): Promise<Relationship | null> {
    const row = this.db.get(
      "SELECT * FROM relationships WHERE profile_id = $profile AND person_id = $person",
      { profile, person },
    );
    return row ? relationshipFromRow(row) : null;
  }

  async upsert(r: Relationship): Promise<void> {
    this.db.run(
      "INSERT INTO relationships (profile_id, person_id, affinity, trust, familiarity, tags, " +
        "notes, call_name, interactions, last_interaction, updated_at) VALUES ($profile, " +
        "$person, $affinity, $trust, $familiarity, $tags, $notes, $call_name, $interactions, " +
        "$last_interaction, $updated_at) ON CONFLICT (profile_id, person_id) DO UPDATE SET " +
        "affinity = excluded.affinity, trust = excluded.trust, familiarity = " +
        "excluded.familiarity, tags = excluded.tags, notes = excluded.notes, call_name = " +
        "excluded.call_name, interactions = excluded.interactions, last_interaction = " +
        "excluded.last_interaction, updated_at = excluded.updated_at",
      {
        profile: r.profile,
        person: r.person,
        affinity: r.affinity,
        trust: r.trust,
        familiarity: r.familiarity,
        tags: JSON.stringify(r.tags),
        notes: r.notes,
        call_name: r.call_name,
        interactions: u32(r.interactions),
        last_interaction: optionalMicros(r.last_interaction),
        updated_at: toMicros(r.updated_at),
      },
    );
  }

  async list(profile: ProfileId): Promise<Relationship[]> {
    return this.db
      .all("SELECT * FROM relationships WHERE profile_id = $profile ORDER BY person_id", {
        profile,
      })
      .map(relationshipFromRow);
  }

  async delete(profile: ProfileId, person: PersonId): Promise<boolean> {
    return this.db.tx(() => {
      this.db.run(
        "DELETE FROM relationship_deltas WHERE profile_id = $profile AND person_id = $person",
        { profile, person },
      );
      const removed = this.db.run(
        "DELETE FROM relationships WHERE profile_id = $profile AND person_id = $person",
        { profile, person },
      );
      return removed > 0;
    });
  }

  async recordDelta(profile: ProfileId, person: PersonId, delta: RelationshipDelta): Promise<void> {
    this.db.run(
      "INSERT INTO relationship_deltas (profile_id, person_id, at, affinity, trust, " +
        "familiarity, reason) VALUES ($profile, $person, $at, $affinity, $trust, $familiarity, " +
        "$reason)",
      {
        profile,
        person,
        at: toMicros(delta.at),
        affinity: delta.affinity,
        trust: delta.trust,
        familiarity: delta.familiarity,
        reason: delta.reason,
      },
    );
  }

  async deltasSince(
    profile: ProfileId,
    person: PersonId,
    since: Timestamp,
  ): Promise<RelationshipDelta[]> {
    const rows = this.db.all(
      "SELECT at, affinity, trust, familiarity, reason FROM relationship_deltas WHERE " +
        "profile_id = $profile AND person_id = $person AND at >= $since ORDER BY at, seq",
      { profile, person, since: toMicros(since) },
    );
    return rows.map((r) => ({
      at: ts(r, "at"),
      affinity: num(r, "affinity"),
      trust: num(r, "trust"),
      familiarity: num(r, "familiarity"),
      reason: str(r, "reason"),
    }));
  }
}

// ---- auth and audit -----------------------------------------------------------------------

function assignmentFromRow(row: Row): RoleAssignment {
  return {
    account: { platform: str(row, "platform"), id: str(row, "account_id") },
    role: str(row, "role"),
    scope: json<AuthScope>(row, "scope", "auth scope"),
    granted_by: str(row, "granted_by"),
    at: ts(row, "at"),
  };
}

const ASSIGNMENT_ORDER = "at, platform, account_id, role, scope";

class SqliteAuth implements AuthStore {
  constructor(private readonly db: Db) {}

  async roles(): Promise<RoleDefinition[]> {
    return this.db.all("SELECT * FROM roles ORDER BY rank DESC, name").map((r) => ({
      name: str(r, "name"),
      rank: num(r, "rank"),
      grants: json<string[]>(r, "grants", "role grants"),
      denies: json<string[]>(r, "denies", "role denies"),
      builtin: bool(r, "builtin"),
    }));
  }

  async upsertRole(role: RoleDefinition): Promise<void> {
    this.db.run(
      "INSERT INTO roles (name, rank, grants, denies, builtin) VALUES ($name, $rank, $grants, " +
        "$denies, $builtin) ON CONFLICT (name) DO UPDATE SET rank = excluded.rank, grants = " +
        "excluded.grants, denies = excluded.denies, builtin = excluded.builtin",
      {
        name: role.name,
        rank: role.rank,
        grants: JSON.stringify(role.grants),
        denies: JSON.stringify(role.denies),
        builtin: role.builtin ? 1 : 0,
      },
    );
  }

  async deleteRole(name: string): Promise<boolean> {
    return this.db.tx(() => {
      const row = this.db.get("SELECT builtin FROM roles WHERE name = $name", { name });
      if (!row) return false;
      if (bool(row, "builtin")) throw new StoreError(`role \`${name}\` is built in`);
      for (const table of ["role_assignments", "role_mappings", "node_overrides"]) {
        this.db.run(`DELETE FROM ${table} WHERE role = $name`, { name });
      }
      this.db.run("DELETE FROM roles WHERE name = $name", { name });
      return true;
    });
  }

  async assignmentsFor(account: AccountRef): Promise<RoleAssignment[]> {
    return this.db
      .all(
        "SELECT * FROM role_assignments WHERE platform = $platform AND account_id = $id " +
          `ORDER BY ${ASSIGNMENT_ORDER}`,
        { platform: account.platform, id: account.id },
      )
      .map(assignmentFromRow);
  }

  async allAssignments(): Promise<RoleAssignment[]> {
    return this.db
      .all(`SELECT * FROM role_assignments ORDER BY ${ASSIGNMENT_ORDER}`)
      .map(assignmentFromRow);
  }

  async assign(a: RoleAssignment): Promise<void> {
    this.db.run(
      "INSERT INTO role_assignments (platform, account_id, role, scope, granted_by, at) " +
        "VALUES ($platform, $id, $role, $scope, $by, $at) ON CONFLICT (platform, account_id, " +
        "role, scope) DO UPDATE SET granted_by = excluded.granted_by, at = excluded.at",
      {
        platform: a.account.platform,
        id: a.account.id,
        role: a.role,
        scope: authScopeKey(a.scope),
        by: a.granted_by,
        at: toMicros(a.at),
      },
    );
  }

  async revoke(account: AccountRef, role: string, scope: AuthScope): Promise<boolean> {
    const removed = this.db.run(
      "DELETE FROM role_assignments WHERE platform = $platform AND account_id = $id AND " +
        "role = $role AND scope = $scope",
      { platform: account.platform, id: account.id, role, scope: authScopeKey(scope) },
    );
    return removed > 0;
  }

  async mappings(platform: PlatformId, guild: string): Promise<RoleMapping[]> {
    return this.db
      .all(
        "SELECT platform_role, role FROM role_mappings WHERE platform = $platform AND " +
          "guild = $guild ORDER BY platform_role",
        { platform, guild },
      )
      .map((r) => ({
        platform,
        guild,
        platform_role: str(r, "platform_role"),
        role: str(r, "role"),
      }));
  }

  async setMapping(m: RoleMapping): Promise<void> {
    this.db.run(
      "INSERT INTO role_mappings (platform, guild, platform_role, role) VALUES ($platform, " +
        "$guild, $platform_role, $role) ON CONFLICT (platform, guild, platform_role) " +
        "DO UPDATE SET role = excluded.role",
      { platform: m.platform, guild: m.guild, platform_role: m.platform_role, role: m.role },
    );
  }

  async removeMapping(platform: PlatformId, guild: string, platformRole: string): Promise<boolean> {
    const removed = this.db.run(
      "DELETE FROM role_mappings WHERE platform = $platform AND guild = $guild AND " +
        "platform_role = $platform_role",
      { platform, guild, platform_role: platformRole },
    );
    return removed > 0;
  }

  async overrides(): Promise<NodeOverride[]> {
    return this.db.all("SELECT * FROM node_overrides ORDER BY scope, role, node").map((r) => ({
      scope: json<AuthScope>(r, "scope", "auth scope"),
      role: str(r, "role"),
      node: str(r, "node"),
      allow: bool(r, "allow"),
    }));
  }

  async setOverride(o: NodeOverride): Promise<void> {
    this.db.run(
      "INSERT INTO node_overrides (scope, role, node, allow) VALUES ($scope, $role, $node, " +
        "$allow) ON CONFLICT (scope, role, node) DO UPDATE SET allow = excluded.allow",
      { scope: authScopeKey(o.scope), role: o.role, node: o.node, allow: o.allow ? 1 : 0 },
    );
  }

  async removeOverride(scope: AuthScope, role: string, node: string): Promise<boolean> {
    const removed = this.db.run(
      "DELETE FROM node_overrides WHERE scope = $scope AND role = $role AND node = $node",
      { scope: authScopeKey(scope), role, node },
    );
    return removed > 0;
  }
}

class SqliteAudit implements AuditLog {
  constructor(private readonly db: Db) {}

  async append(entry: AuditEntry): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO audit_log (id, at, actor, action, target, detail, ok) VALUES ($id, $at, " +
          "$actor, $action, $target, $detail, $ok)",
        {
          id: entry.id,
          at: toMicros(entry.at),
          actor: entry.actor,
          action: entry.action,
          target: entry.target,
          detail: JSON.stringify(entry.detail),
          ok: entry.ok ? 1 : 0,
        },
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (isConstraintError(cause)) {
        throw new StoreError(`audit entry \`${entry.id}\` already exists`, { cause });
      }
      throw new StoreError("cannot append audit entry", { cause });
    }
  }

  async recent(limit: number, actor: string | null): Promise<AuditEntry[]> {
    const rows = this.db.all(
      "SELECT * FROM audit_log WHERE ($actor IS NULL OR actor = $actor) " +
        "ORDER BY at DESC, id DESC LIMIT $limit",
      { actor, limit: limitParam(limit) },
    );
    return rows.map((r) => ({
      id: str(r, "id"),
      at: ts(r, "at"),
      actor: str(r, "actor"),
      action: str(r, "action"),
      target: str(r, "target"),
      detail: json<JsonValue>(r, "detail", "audit detail"),
      ok: bool(r, "ok"),
    }));
  }
}

// ---- the store ----------------------------------------------------------------------------

/** Every storage area on one SQLite database. */
export class SqliteStore implements Store {
  readonly messages: MessageLog;
  readonly moduleState: ModuleStateStore;
  readonly personaOverrides: PersonaOverrideStore;
  readonly people: PeopleStore;
  readonly decisions: DecisionLog;
  readonly settings: SettingsStore;
  readonly memories: MemoryRecordStore;
  readonly relationships: RelationshipStore;
  readonly identity: IdentityStore;
  readonly auth: AuthStore;
  readonly audit: AuditLog;
  readonly #db: Db;

  private constructor(db: Db, maxDecisions: number | null) {
    this.#db = db;
    this.messages = new SqliteMessageLog(db);
    this.moduleState = new SqliteModuleState(db);
    this.personaOverrides = new SqlitePersonaOverrides(db);
    this.people = new SqlitePeople(db);
    this.decisions = new SqliteDecisionLog(db, maxDecisions);
    this.settings = new SqliteSettings(db);
    this.memories = new SqliteMemories(db);
    this.relationships = new SqliteRelationships(db);
    this.identity = new SqliteIdentity(db);
    this.auth = new SqliteAuth(db);
    this.audit = new SqliteAudit(db);
  }

  /**
   * Opens (creating it and its directory if needed) a database file, or `":memory:"` for a
   * fresh in-memory database, and runs pending migrations.
   */
  static async open(path: string, options: SqliteStoreOptions = {}): Promise<SqliteStore> {
    const memory = path === ":memory:";
    if (!memory) mkdirSync(dirname(path), { recursive: true });
    let raw: DatabaseSync;
    try {
      raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot open the SQLite database", { cause });
    }
    const db = new Db(raw, options.clock ?? systemClock);
    try {
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
      if (!memory) {
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
      }
      db.exec("PRAGMA foreign_keys = ON");
      migrate(db);
    } catch (error) {
      db.close();
      throw error;
    }
    const maxDecisions =
      options.maxDecisionsPerProfile !== undefined
        ? options.maxDecisionsPerProfile
        : memory
          ? MAX_DECISIONS
          : null;
    return new SqliteStore(db, maxDecisions);
  }

  /** Versions recorded in `schema_version`, ascending. */
  async schemaVersions(): Promise<number[]> {
    return this.#db
      .all("SELECT version FROM schema_version ORDER BY version")
      .map((r) => num(r, "version"));
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
