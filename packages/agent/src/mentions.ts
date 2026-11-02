// `@name` in her text replies, turned into the platform's mention markup for people in the
// conversation (`mention_users`). Runs after `filterOutgoing`, so `@everyone` / `@here` and
// role mentions are gone already; only user mentions come out of here.

export interface MentionTarget {
  /** Display name as she sees it in the transcript. */
  name: string;
  /** What `@name` becomes, e.g. `<@1234>` on Discord. */
  markup: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces `@name` (longest names first, not followed by a letter or digit) with the target's
 * markup. Names are matched exactly; anything else stays as written.
 */
export function linkMentions(text: string, targets: readonly MentionTarget[]): string {
  const usable = targets
    .filter((t) => t.name.trim() !== "" && t.markup !== "")
    .sort((a, b) => [...b.name].length - [...a.name].length);
  if (usable.length === 0 || !text.includes("@")) return text;
  const byName = new Map(usable.map((t) => [t.name, t.markup]));
  const pattern = new RegExp(
    `@(${usable.map((t) => escapeRegExp(t.name)).join("|")})(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  return text.replace(pattern, (whole, name: string) => byName.get(name) ?? whole);
}
