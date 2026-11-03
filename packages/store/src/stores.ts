// Storage interfaces. Each area is its own interface so callers never depend on a backend;
// backends (SQLite by default, Postgres optional) implement all of them.
//
// Data that belongs to one character is keyed by `ProfileId`. Module state and people are
// shared by all profiles. Rust `BTreeMap` results are `Map`s with keys in ascending order.

import {
  type AccountRef,
  type ContextKey,
  type JsonValue,
  type ModuleId,
  type PersonId,
  type PlatformId,
  type ProfileId,
  serviceKey,
  type Timestamp,
  type TurnOutcomeRecord,
} from "@miyoria/types";
import type { DataCategoryId, DataExport, DataInventory, WipeCounts, WipeOptions } from "./data.js";
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

/** Append-only conversation log per profile and context. */
export interface MessageLog {
  /** Appends an entry. Entry ids must be unique. */
  append(entry: LogEntry): Promise<void>;
  /**
   * The most recent `limit` entries of a context, oldest first. Entries with equal timestamps
   * keep their append order.
   */
  recent(profile: ProfileId, context: ContextKey, limit: number): Promise<LogEntry[]>;
  /** Deletes every entry of a profile (all contexts); returns how many. */
  purge(profile: ProfileId): Promise<number>;
}

/** Persisted runtime enabled / disabled flag per module. */
export interface ModuleStateStore {
  /** `null` when the flag was never set (the config default applies). */
  get(module: ModuleId): Promise<boolean | null>;
  set(module: ModuleId, enabled: boolean): Promise<void>;
  list(): Promise<Map<ModuleId, boolean>>;
}

/** Runtime edits of persona sections, with full version history. */
export interface PersonaOverrideStore {
  /** Stores a new version of a section and returns its version number. */
  set(profile: ProfileId, key: string, body: string, editedBy: string): Promise<number>;
  /** Latest body of every overridden section of a profile. */
  current(profile: ProfileId): Promise<Map<string, string>>;
  /** Every version of one section, oldest first. */
  history(profile: ProfileId, key: string): Promise<PersonaOverride[]>;
}

/** People and their platform accounts. */
export interface PeopleStore {
  /**
   * Records that an account was seen, creating a person on first sight. Returns the person the
   * account belongs to.
   */
  upsertAccount(account: AccountRef, displayName: string): Promise<PersonId>;
  personByAccount(account: AccountRef): Promise<Person | null>;
  /** Every person with their accounts, oldest first (by `created_at`, then id). */
  all(): Promise<Person[]>;
}

export interface DecisionLog {
  append(record: DecisionRecord): Promise<void>;
  /** Newest first, optionally only for one context. */
  recent(profile: ProfileId, context: ContextKey | null, limit: number): Promise<DecisionRecord[]>;
  /**
   * Records how a turn ended (`agent.turn.outcome`), one row per turn (a repeated write of the
   * same turn replaces it). Optional so older backends and test doubles keep working; callers
   * use `?.`.
   */
  appendOutcome?(profile: ProfileId, record: TurnOutcomeRecord): Promise<void>;
  /** Turn outcomes, newest first, optionally only for one context. */
  recentOutcomes?(
    profile: ProfileId,
    context: ContextKey | null,
    limit: number,
  ): Promise<TurnOutcomeRecord[]>;
}

/**
 * Small per-profile JSON settings changed at runtime (e.g. channel modes set with `/channel mode`).
 * Keys are free-form, conventionally `area:subkey`.
 */
export interface SettingsStore {
  get(profile: ProfileId, key: string): Promise<JsonValue | null>;
  /** `null` deletes the key. */
  set(profile: ProfileId, key: string, value: JsonValue | null): Promise<void>;
  /** All keys starting with `prefix`, in key order. */
  list(profile: ProfileId, prefix: string): Promise<Map<string, JsonValue>>;
  /** Deletes every key starting with `prefix`; returns how many. */
  deletePrefix(profile: ProfileId, prefix: string): Promise<number>;
}

/** Long-term memory records (episodes, facts, her own notes, followups). */
export interface MemoryRecordStore {
  upsert(record: MemoryRecord): Promise<void>;
  get(id: string): Promise<MemoryRecord | null>;
  delete(id: string): Promise<boolean>;
  /**
   * Union of full-text hits and nearest neighbours, restricted to `query.scopes`, never
   * superseded records, at most `limit` of each kind of match. Ranking beyond that is the
   * caller's job.
   */
  search(query: MemoryQuery): Promise<MemoryHit[]>;
  /** Newest first. */
  list(profile: ProfileId, filter: MemoryFilter): Promise<MemoryRecord[]>;
  /** Records access (bumps `access_count`, sets `last_accessed`). */
  touch(ids: readonly string[], at: Timestamp): Promise<void>;
  /**
   * Open followups with `due <= now`, newest due first (the oldest ones are the ones nobody
   * brought up in time). With `maxAgeMs`, followups that became due longer ago than that are
   * not returned.
   */
  dueFollowups(
    profile: ProfileId,
    now: Timestamp,
    maxAgeMs?: number | null,
  ): Promise<MemoryRecord[]>;
  /**
   * Closes (`done`) every open followup that became due before `dueBefore`; returns how many.
   * A followup nobody picked up within a few hours is not worth bringing up any more.
   */
  expireFollowups(profile: ProfileId, dueBefore: Timestamp): Promise<number>;
  /** Deletes forgettable episodes; returns how many. */
  prune(profile: ProfileId, policy: PrunePolicy): Promise<number>;
  /** Deletes everything about a person (they asked her to forget them). */
  deleteBySubject(profile: ProfileId, person: PersonId): Promise<number>;
  /**
   * Rewrites every record about `absorb` to be about `keep`, in every profile (people are
   * shared and `absorb` no longer exists once merged): `absorb` in `subjects` becomes `keep`
   * (no duplicates, order kept) and a `person` scope of `absorb` becomes `keep`'s. Content,
   * tokens, embeddings and timestamps are unchanged, so the full-text and vector indexes stay
   * valid. One transaction. Returns how many records changed.
   */
  mergePerson(keep: PersonId, absorb: PersonId): Promise<number>;
}

export interface RelationshipStore {
  get(profile: ProfileId, person: PersonId): Promise<Relationship | null>;
  upsert(relationship: Relationship): Promise<void>;
  list(profile: ProfileId): Promise<Relationship[]>;
  delete(profile: ProfileId, person: PersonId): Promise<boolean>;
  recordDelta(profile: ProfileId, person: PersonId, delta: RelationshipDelta): Promise<void>;
  /** Oldest first. */
  deltasSince(profile: ProfileId, person: PersonId, since: Timestamp): Promise<RelationshipDelta[]>;
}

/** Linking several platform accounts to one person. */
export interface IdentityStore {
  /** Moves `account` to `person` (creating the account row if needed). */
  linkAccount(account: AccountRef, person: PersonId): Promise<void>;
  /**
   * Moves every account of `absorb` to `keep` and deletes `absorb`. Callers must merge
   * per-profile data (relationships, memories) first.
   */
  mergePeople(keep: PersonId, absorb: PersonId): Promise<void>;
  accountsOf(person: PersonId): Promise<Account[]>;
  setPersonName(person: PersonId, displayName: string): Promise<void>;
  /** Stores a one-time code issued to `account`, valid until `expiresAt`. */
  createLinkCode(code: string, account: AccountRef, expiresAt: Timestamp): Promise<void>;
  /** Returns the issuing account and deletes the code, if still valid at `now`. */
  consumeLinkCode(code: string, now: Timestamp): Promise<AccountRef | null>;
}

/** Roles, permission grants, platform role mappings. */
export interface AuthStore {
  roles(): Promise<RoleDefinition[]>;
  upsertRole(role: RoleDefinition): Promise<void>;
  deleteRole(name: string): Promise<boolean>;

  assignmentsFor(account: AccountRef): Promise<RoleAssignment[]>;
  allAssignments(): Promise<RoleAssignment[]>;
  /** Replaces an assignment with the same (account, role, scope). */
  assign(assignment: RoleAssignment): Promise<void>;
  revoke(account: AccountRef, role: string, scope: AuthScope): Promise<boolean>;

  mappings(platform: PlatformId, guild: string): Promise<RoleMapping[]>;
  setMapping(mapping: RoleMapping): Promise<void>;
  removeMapping(platform: PlatformId, guild: string, platformRole: string): Promise<boolean>;

  overrides(): Promise<NodeOverride[]>;
  /** Replaces an override with the same (scope, role, node). */
  setOverride(override: NodeOverride): Promise<void>;
  removeOverride(scope: AuthScope, role: string, node: string): Promise<boolean>;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  /** Newest first, optionally only one actor's entries. */
  recent(limit: number, actor: string | null): Promise<AuditEntry[]>;
}

/**
 * Whole-profile data operations by category (see `data.ts`): what there is, a JSON backup of
 * it, and deleting it in one transaction.
 */
export interface ProfileDataStore {
  /** Row counts and last update of every category. */
  inventory(profile: ProfileId): Promise<DataInventory>;
  /** The rows of `categories`, as they are (non-exportable categories are left out). */
  export(profile: ProfileId, categories: readonly DataCategoryId[]): Promise<DataExport>;
  /**
   * Deletes `categories` and what they require (`resolveCategories`), all or nothing. Kept
   * categories are refused.
   */
  wipe(
    profile: ProfileId,
    categories: readonly DataCategoryId[],
    options?: WipeOptions,
  ): Promise<WipeCounts>;
}

/**
 * One handle per storage area, all backed by the same backend. Areas are separate objects
 * (several of them have a `get` / `list` / `delete` with different signatures).
 */
export interface Store {
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
  readonly profileData: ProfileDataStore;
  /** Releases the backend (closes the database). */
  close(): Promise<void>;
}

// Service keys: the app provides each area (owner `"kernel"`) so modules can look them up.
export const MessageLogKey = serviceKey<MessageLog>("MessageLog");
export const ModuleStateStoreKey = serviceKey<ModuleStateStore>("ModuleStateStore");
export const PersonaOverrideStoreKey = serviceKey<PersonaOverrideStore>("PersonaOverrideStore");
export const PeopleStoreKey = serviceKey<PeopleStore>("PeopleStore");
export const DecisionLogKey = serviceKey<DecisionLog>("DecisionLog");
export const SettingsStoreKey = serviceKey<SettingsStore>("SettingsStore");
export const MemoryRecordStoreKey = serviceKey<MemoryRecordStore>("MemoryRecordStore");
export const RelationshipStoreKey = serviceKey<RelationshipStore>("RelationshipStore");
export const IdentityStoreKey = serviceKey<IdentityStore>("IdentityStore");
export const AuthStoreKey = serviceKey<AuthStore>("AuthStore");
export const AuditLogKey = serviceKey<AuditLog>("AuditLog");
export const ProfileDataStoreKey = serviceKey<ProfileDataStore>("ProfileDataStore");
export const StoreKey = serviceKey<Store>("Store");
