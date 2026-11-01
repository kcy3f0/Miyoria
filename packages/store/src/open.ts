// `openStore(url)`: picks a backend from a store URL.

import type { Clock } from "@miyoria/types";
import { StoreError } from "./common.js";
import { PostgresStore, type PostgresStoreOptions } from "./postgres.js";
import { SqliteStore, type SqliteStoreOptions } from "./sqlite.js";
import type { Store } from "./stores.js";

/** What the CLI uses when no store URL is configured. */
export const DEFAULT_STORE_URL = "sqlite:data/miyoria.db";

export interface OpenStoreOptions {
  clock?: Clock;
  sqlite?: Omit<SqliteStoreOptions, "clock">;
  postgres?: Omit<PostgresStoreOptions, "clock">;
}

export type StoreLocation =
  | { backend: "sqlite"; path: string }
  | { backend: "postgres"; url: string };

/**
 * Parses a store URL:
 * - `sqlite:<path>` / `sqlite://<path>`: a SQLite file (relative paths resolve against the
 *   working directory; `sqlite:///abs/path` is absolute);
 * - `sqlite::memory:`, `memory://`, `memory:`: a fresh in-memory SQLite database;
 * - `postgres://...` / `postgresql://...`: PostgreSQL.
 */
export function parseStoreUrl(url: string): StoreLocation {
  const trimmed = url.trim();
  if (trimmed.startsWith("memory:") || trimmed === "sqlite::memory:") {
    return { backend: "sqlite", path: ":memory:" };
  }
  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) {
    return { backend: "postgres", url: trimmed };
  }
  if (trimmed.startsWith("sqlite:")) {
    let path = trimmed.slice("sqlite:".length);
    if (path.startsWith("//")) path = path.slice(2);
    // `sqlite:///C:/x.db` names a Windows drive path.
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
    const query = path.indexOf("?");
    if (query >= 0) path = path.slice(0, query);
    if (path === "") throw new StoreError("store URL `sqlite:` has no path");
    return { backend: "sqlite", path: path === ":memory:" ? ":memory:" : decodeURI(path) };
  }
  // Never echo the URL itself: it may carry a password.
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(trimmed)?.[0] ?? "(none)";
  throw new StoreError(`unsupported store URL scheme \`${scheme}\``);
}

/** Opens the store a URL names and runs pending migrations. */
export async function openStore(url: string, options: OpenStoreOptions = {}): Promise<Store> {
  const location = parseStoreUrl(url);
  const clock = options.clock;
  if (location.backend === "postgres") {
    return PostgresStore.connect(location.url, { ...options.postgres, ...(clock && { clock }) });
  }
  return SqliteStore.open(location.path, { ...options.sqlite, ...(clock && { clock }) });
}
