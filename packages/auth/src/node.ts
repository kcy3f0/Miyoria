// Permission node patterns.

/**
 * Does `pattern` cover `node`?
 *
 * - `"*"` covers every node.
 * - `"queue.*"` covers `"queue"` and everything below it (`"queue.skip"`, `"queue.skip.self"`),
 *   but not `"queuex"`.
 * - Anything else must match exactly.
 *
 * Patterns can be checked against patterns: `"admin.*"` covers `"admin.role.*"`.
 */
export function matches(pattern: string, node: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return (
      node === prefix || (node.startsWith(prefix) && node.slice(prefix.length).startsWith("."))
    );
  }
  return pattern === node;
}

const SEGMENT = /^[a-z0-9_-]+$/;

/**
 * A node or pattern that can be stored: dot separated lowercase segments of `a-z 0-9 _ -`,
 * optionally ending in `.*`, or just `*`.
 */
export function isValidPattern(pattern: string): boolean {
  if (pattern === "*") return true;
  const body = pattern.endsWith(".*") ? pattern.slice(0, -2) : pattern;
  return (
    pattern.length <= 128 &&
    body.length > 0 &&
    body.split(".").every((segment) => SEGMENT.test(segment))
  );
}
