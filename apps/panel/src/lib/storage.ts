// localStorage can be missing or throw (private windows, blocked site data,
// sandboxed iframes). Every access goes through here and degrades to memory.

const memory = new Map<string, string>();

export function readStorage(key: string): string | null {
  try {
    const v = window.localStorage.getItem(key);
    if (v !== null) return v;
  } catch {
    /* fall through to memory */
  }
  return memory.get(key) ?? null;
}

export function writeStorage(key: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* memory copy keeps the session working */
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readStorage(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  writeStorage(key, JSON.stringify(value));
}
