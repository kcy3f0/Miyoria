// Privacy scopes: where a memory may be recalled, and where new memories go.
//
// Visible in a context:
// * `global` everywhere;
// * `guild` of the context's guild;
// * `channel` of exactly this context;
// * `dm { account }` only inside a DM, for the accounts in it;
// * `person` of people present (with a known `PersonId`).
//
// Anything learned in a DM is scoped to that DM, so it never surfaces elsewhere (unless
// `allow_global_from_dm` is set for person-wide facts).
//
// Her own notes are the one kind that may go `global`, and only when they are about her alone: a
// note written in a server that names or refers to someone else (「我懷疑木呱是機器人」, a card
// someone made her) is the server's, like the rest of what was said there. 2026-11-09: a global
// note about a card someone posted in the server reached another person's DM, where she thanked
// that person for it.

import type { MemoryKind, MemoryRecord, MemoryScope } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  type HandleEntry,
  type PersonId,
  type PromptRequest,
  sameAccount,
} from "@miyoria/types";
import type { MemoryConfig } from "./config.js";

/** Structural equality of two scopes (Rust `PartialEq`). */
export function scopeEquals(a: MemoryScope, b: MemoryScope): boolean {
  switch (a.type) {
    case "global":
      return b.type === "global";
    case "guild":
      return b.type === "guild" && a.platform === b.platform && a.guild === b.guild;
    case "channel":
      return b.type === "channel" && contextKeyEquals(a.context, b.context);
    case "dm":
      return b.type === "dm" && sameAccount(a.account, b.account);
    case "person":
      return b.type === "person" && a.person === b.person;
  }
}

/** `scopes` contains `scope`. */
export function hasScope(scopes: readonly MemoryScope[], scope: MemoryScope): boolean {
  return scopes.some((s) => scopeEquals(s, scope));
}

function pushUnique(scopes: MemoryScope[], scope: MemoryScope): void {
  if (!hasScope(scopes, scope)) scopes.push(scope);
}

/**
 * Whether `record` may be recalled where `scopes` are visible: its scope is among them, and, in a
 * private place, a `global` note learned in a server is not about anyone but the people there.
 * Notes written before server notes about others were scoped to the server are still `global`;
 * this keeps them out of DMs until they are moved (packages/memory/scripts/rescope-self-notes.ts).
 */
export function mayRecall(
  scopes: readonly MemoryScope[],
  record: MemoryRecord,
  handles: readonly Pick<HandleEntry, "handle" | "person">[] = [],
): boolean {
  if (!hasScope(scopes, record.scope)) return false;
  if (record.scope.type !== "global" || !privateView(scopes)) return true;
  const from = record.source_context;
  if (from === null || isPrivate(from)) return true;
  const here = new Set<PersonId>();
  for (const s of scopes) if (s.type === "person") here.add(s.person);
  if (record.subjects.some((p) => !here.has(p))) return false;
  if (record.subjects.length > 0) return true;
  const others = handles.filter((h) => h.person === null || !here.has(h.person));
  return !aboutOthers(
    record.content,
    [],
    others.map((h) => h.handle),
  );
}

/** Scopes of a private place: a DM scope, or the channel scope of a DM or guild-less context. */
function privateView(scopes: readonly MemoryScope[]): boolean {
  return scopes.some((s) => s.type === "dm" || (s.type === "channel" && isPrivate(s.context)));
}

// Words that point at someone other than her (「對方」「有人」「大家」, a bare 他 / 她 / 你). 其他
// and 吉他 hold a 他 that is nobody; 迷你 a 你.
const OTHERS =
  /對方|有人|大家|別人|别人|某人|某位|有位|那位|這位|这位|其他人|所有人|每個人|每个人|有些人|很多人|一群人|群友|網友|网友|朋友|觀眾|观众|聽眾|听众|粉絲|粉丝|(?<![其吉])他|她|(?<!迷)你|妳/;

/** `text` refers to someone other than her by a pronoun or a word for people. */
export function refersToOthers(text: string): boolean {
  return OTHERS.test(text);
}

/**
 * A note of hers is about someone else too: it is about people (`subjects`), names one of
 * `names` (`namesIn`) or refers to someone (`refersToOthers`).
 */
export function aboutOthers(
  content: string,
  subjects: readonly PersonId[],
  names: Iterable<string>,
): boolean {
  return subjects.length > 0 || refersToOthers(content) || namesIn(content, names);
}

/**
 * `text` holds one of `names`, ignoring case: two characters or more, and a Latin name as a whole
 * word (`Yu` is not in `you`).
 */
export function namesIn(text: string, names: Iterable<string>): boolean {
  const lower = text.toLowerCase();
  for (const name of names) {
    const n = name.trim().toLowerCase();
    if ([...n].length < 2) continue;
    if (/^[ -~]+$/.test(n) ? wordAt(lower, n) : lower.includes(n)) return true;
  }
  return false;
}

const WORD = /[a-z0-9_]/;

function wordAt(text: string, word: string): boolean {
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    const before = text[i - 1];
    const after = text[i + word.length];
    const edge = (c: string | undefined, end: string | undefined) =>
      c === undefined || end === undefined || !WORD.test(c) || !WORD.test(end);
    if (edge(before, word[0]) && edge(after, word[word.length - 1])) return true;
  }
  return false;
}

/** Scopes whose memories may be recalled in `context` with these accounts and people present. */
export function visibleScopes(
  context: ContextKey,
  accounts: Iterable<AccountRef>,
  persons: Iterable<PersonId>,
): MemoryScope[] {
  const scopes: MemoryScope[] = [{ type: "global" }];
  if (context.scope !== null) {
    scopes.push({ type: "guild", platform: context.platform, guild: context.scope });
  }
  scopes.push({ type: "channel", context });
  if (isPrivate(context)) {
    for (const account of accounts) pushUnique(scopes, { type: "dm", account });
  }
  for (const person of persons) pushUnique(scopes, { type: "person", person });
  return scopes;
}

/**
 * Whether a memory about someone may be shown to that person alone, on a page of their own, where
 * there is no channel to scope by. Anything said in a private place belongs to whoever was there:
 * another account's DM, and a channel outside any guild, stay hidden even when about this person.
 */
export function visibleToSelf(
  scope: MemoryScope,
  account: AccountRef,
  person: PersonId | null,
): boolean {
  switch (scope.type) {
    case "global":
    case "guild":
      return true;
    case "channel":
      return !isPrivate(scope.context);
    case "dm":
      return sameAccount(scope.account, account);
    case "person":
      return person !== null && scope.person === person;
  }
}

/** `visibleScopes` for a prompt request (participants and speakers). */
export function requestScopes(request: PromptRequest): MemoryScope[] {
  const accounts = [...request.participants.map((p) => p.account), ...request.speakers];
  return visibleScopes(request.context, accounts, presentPeople(request));
}

/** People present in a prompt request. */
export function presentPeople(request: PromptRequest): PersonId[] {
  const out: PersonId[] = [];
  for (const p of request.participants) {
    if (p.person !== null && !out.includes(p.person)) out.push(p.person);
  }
  return out;
}

/** A DM, or a context outside any guild. */
export function isPrivate(context: ContextKey): boolean {
  return context.kind === "dm" || context.scope === null;
}

/**
 * Scope of a new memory learned in `context`.
 *
 * * DM (or guild-less context): `dm { partner }`, or `channel` when the partner is unknown or
 *   there are several. With `allow_global_from_dm`, global facts about a known person become
 *   `person`.
 * * Guild: self notes about her alone → `global`; global facts about a known person → `person`;
 *   everything else, self notes about anyone else (`others`, see `aboutOthers`) included →
 *   `guild` (or `channel`, per `guild_scope`).
 */
export function scopeForNew(
  config: MemoryConfig,
  context: ContextKey,
  dmPartner: AccountRef | null,
  kind: MemoryKind,
  globalPerson: PersonId | null,
  others = false,
): MemoryScope {
  if (isPrivate(context)) {
    if (kind === "fact" && config.allow_global_from_dm && globalPerson !== null) {
      return { type: "person", person: globalPerson };
    }
    if (dmPartner !== null && context.kind === "dm") return { type: "dm", account: dmPartner };
    return { type: "channel", context };
  }
  if (kind === "self_note" && !others) return { type: "global" };
  if (kind === "fact" && globalPerson !== null) return { type: "person", person: globalPerson };
  if (config.guild_scope === "guild" && context.scope !== null) {
    return { type: "guild", platform: context.platform, guild: context.scope };
  }
  return { type: "channel", context };
}

/** Short label for exports and admin views. */
export function scopeLabel(scope: MemoryScope): string {
  switch (scope.type) {
    case "global":
      return "global";
    case "guild":
      return `guild:${scope.guild}`;
    case "channel":
      return `channel:${contextKeyString(scope.context)}`;
    case "dm":
      return "dm";
    case "person":
      return "person";
  }
}
