// Permission node patterns. Matching is defined once in `@miyoria/commands` (the fallback
// permissions use the same function).

export { matches } from "@miyoria/commands";

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
