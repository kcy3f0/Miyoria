// In-memory fake stores and shared helpers (the Rust `tests.rs` fakes).

import { parseAccount } from "@miyoria/commands";
import { type ChatProvider, LlmRouter, type MockProvider, parseModelRef } from "@miyoria/llm";
import type {
  Account,
  IdentityStore,
  MemoryRecordStore,
  PeopleStore,
  Person,
  Relationship,
  RelationshipDelta,
  RelationshipStore,
} from "@miyoria/store";
import {
  type AccountRef,
  accountRefString,
  type ContextKey,
  type Event,
  type JsonValue,
  newId,
  type PersonId,
  type ProfileId,
  toTimestamp,
} from "@miyoria/types";
import { type Observed, Social, type SocialConfig, socialConfig, TOPIC } from "../src/index.js";

/** People, relationships and identity in one in-memory fake. */
export class FakeStore implements PeopleStore, RelationshipStore, IdentityStore {
  readonly people = new Map<PersonId, Person>();
  readonly accounts = new Map<string, PersonId>();
  readonly rels = new Map<string, Relationship>();
  readonly deltaRows: Array<[ProfileId, PersonId, RelationshipDelta]> = [];
  readonly codes = new Map<string, [AccountRef, string]>();

  deltas(person: PersonId): RelationshipDelta[] {
    return this.deltaRows.filter(([, p]) => p === person).map(([, , d]) => structuredClone(d));
  }

  stored(person: PersonId): Relationship | null {
    const r = this.rels.get(`${profile()}|${person}`);
    return r ? structuredClone(r) : null;
  }

  personOf(account: AccountRef): PersonId | null {
    return this.accounts.get(accountRefString(account)) ?? null;
  }

  // PeopleStore
  async upsertAccount(account: AccountRef, name: string): Promise<PersonId> {
    const existing = this.accounts.get(accountRefString(account));
    if (existing !== undefined) return existing;
    const id = newId();
    const now = toTimestamp(Date.now());
    this.people.set(id, {
      id,
      display_name: name,
      created_at: now,
      accounts: [{ account, display_name: name, first_seen: now, last_seen: now }],
    });
    this.accounts.set(accountRefString(account), id);
    return id;
  }

  async personByAccount(account: AccountRef): Promise<Person | null> {
    const p = this.accounts.get(accountRefString(account));
    const person = p === undefined ? undefined : this.people.get(p);
    return person ? structuredClone(person) : null;
  }

  async all(): Promise<Person[]> {
    return [...this.people.values()].map((p) => structuredClone(p));
  }

  // RelationshipStore
  async get(profile: ProfileId, person: PersonId): Promise<Relationship | null> {
    const r = this.rels.get(`${profile}|${person}`);
    return r ? structuredClone(r) : null;
  }

  async upsert(r: Relationship): Promise<void> {
    this.rels.set(`${r.profile}|${r.person}`, structuredClone(r));
  }

  async list(profile: ProfileId): Promise<Relationship[]> {
    return [...this.rels.values()]
      .filter((r) => r.profile === profile)
      .map((r) => structuredClone(r));
  }

  async delete(profile: ProfileId, person: PersonId): Promise<boolean> {
    return this.rels.delete(`${profile}|${person}`);
  }

  async recordDelta(profile: ProfileId, person: PersonId, delta: RelationshipDelta): Promise<void> {
    this.deltaRows.push([profile, person, structuredClone(delta)]);
  }

  async deltasSince(
    profile: ProfileId,
    person: PersonId,
    since: string,
  ): Promise<RelationshipDelta[]> {
    const from = Date.parse(since);
    return this.deltaRows
      .filter(([pr, p, d]) => pr === profile && p === person && Date.parse(d.at) >= from)
      .map(([, , d]) => structuredClone(d));
  }

  // IdentityStore
  async linkAccount(account: AccountRef, person: PersonId): Promise<void> {
    const key = accountRefString(account);
    const old = this.accounts.get(key);
    this.accounts.set(key, person);
    let moved: Account | undefined;
    if (old !== undefined) {
      const p = this.people.get(old);
      if (p) {
        const i = p.accounts.findIndex((a) => accountRefString(a.account) === key);
        if (i >= 0) moved = p.accounts.splice(i, 1)[0];
      }
    }
    if (moved) this.people.get(person)?.accounts.push(moved);
  }

  async mergePeople(keep: PersonId, absorb: PersonId): Promise<void> {
    const gone = this.people.get(absorb);
    this.people.delete(absorb);
    for (const [k, p] of this.accounts) if (p === absorb) this.accounts.set(k, keep);
    if (gone) this.people.get(keep)?.accounts.push(...gone.accounts);
  }

  async accountsOf(person: PersonId): Promise<Account[]> {
    return structuredClone(this.people.get(person)?.accounts ?? []);
  }

  async setPersonName(person: PersonId, name: string): Promise<void> {
    const p = this.people.get(person);
    if (p) p.display_name = name;
  }

  async createLinkCode(code: string, account: AccountRef, expiresAt: string): Promise<void> {
    this.codes.set(code, [account, expiresAt]);
  }

  async consumeLinkCode(code: string, now: string): Promise<AccountRef | null> {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (!entry || Date.parse(entry[1]) <= Date.parse(now)) return null;
    return entry[0];
  }
}

export function profile(): ProfileId {
  return "deepseek-chan";
}

export function acc(s: string): AccountRef {
  return parseAccount(s);
}

export function dm(): ContextKey {
  return { platform: "discord", scope: null, channel: "dm1", kind: "dm" };
}

export function channel(): ContextKey {
  return { platform: "discord", scope: "g", channel: "c", kind: "channel" };
}

/** Local (UTC+8) time on day `d` of November 2026, hour `h` (epoch ms). */
export function t(d: number, h: number): number {
  return Date.UTC(2026, 10, d, h - 8, 0, 0);
}

export const MINUTE = 60_000;

export function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-3;
}

export class Harness {
  readonly events: Event[] = [];
  readonly social: Social;

  constructor(
    config: SocialConfig = socialConfig(),
    readonly store: FakeStore = new FakeStore(),
    memories: MemoryRecordStore | null = null,
  ) {
    this.social = new Social(
      profile(),
      "DeepSeek-chan",
      ["DS醬", "小鯨魚"],
      config,
      { people: store, relationships: store, identity: store, memories },
      (e) => {
        this.events.push(e);
      },
    );
  }

  say(who: string, name: string, text: string, ctx: ContextKey, at: number): Promise<boolean> {
    const line: Observed = {
      directed: ctx.kind === "dm",
      context: ctx,
      account: acc(who),
      display_name: name,
      text,
      ts: at,
    };
    return this.social.observe(line);
  }

  rel(who: string): Relationship {
    const p = this.social.personOf(acc(who));
    if (p === null) throw new Error("known account");
    const r = this.social.relationship(p);
    if (r === null) throw new Error("relationship");
    return r;
  }

  person(who: string): PersonId {
    const p = this.social.personOf(acc(who));
    if (p === null) throw new Error("known account");
    return p;
  }

  topics(): JsonValue[] {
    return this.events.flatMap((e) =>
      e.type === "custom" && e.data.topic === TOPIC ? [e.data.payload] : [],
    );
  }
}

export function router(mock: MockProvider): LlmRouter {
  const providers = new Map<string, ChatProvider>([["mock", mock]]);
  const purposes = new Map([["fast", [parseModelRef("mock:fast-model")]]]);
  return new LlmRouter(providers, purposes);
}
