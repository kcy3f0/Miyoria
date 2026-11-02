// @miyoria/store: persistence interfaces, record types and the backends implementing all of
// them: SQLite via `node:sqlite` (default; `:memory:` for tests) and PostgreSQL + pgvector.
// `openStore(url)` picks one from a store URL.

export {
  fromMicros,
  MAX_DECISIONS,
  normalizeTimestamp,
  StoreError,
  toMicros,
} from "./common.js";
export { MemorySettingsStore } from "./memory-settings.js";
export {
  DEFAULT_STORE_URL,
  type OpenStoreOptions,
  openStore,
  parseStoreUrl,
  type StoreLocation,
} from "./open.js";
export { PostgresStore, type PostgresStoreOptions } from "./postgres.js";
export {
  type Account,
  type AuditEntry,
  type AuthScope,
  type DecisionRecord,
  type LogEntry,
  logEntryFromIncoming,
  type MemoryFilter,
  type MemoryHit,
  type MemoryKind,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryScope,
  type NodeOverride,
  type Person,
  type PersonaOverride,
  type PrunePolicy,
  type Relationship,
  type RelationshipDelta,
  type RoleAssignment,
  type RoleDefinition,
  type RoleMapping,
} from "./records.js";
export { SqliteStore, type SqliteStoreOptions } from "./sqlite.js";
export {
  type AuditLog,
  AuditLogKey,
  type AuthStore,
  AuthStoreKey,
  type DecisionLog,
  DecisionLogKey,
  type IdentityStore,
  IdentityStoreKey,
  type MemoryRecordStore,
  MemoryRecordStoreKey,
  type MessageLog,
  MessageLogKey,
  type ModuleStateStore,
  ModuleStateStoreKey,
  type PeopleStore,
  PeopleStoreKey,
  type PersonaOverrideStore,
  PersonaOverrideStoreKey,
  type ProfileDataStore,
  ProfileDataStoreKey,
  type ProfileExport,
  type RelationshipStore,
  RelationshipStoreKey,
  type SettingsStore,
  SettingsStoreKey,
  type Store,
  StoreKey,
  type WipeCounts,
  type WipePlan,
} from "./stores.js";
