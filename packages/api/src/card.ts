// Member cards (她發給你的卡): a snapshot of how she sees someone at the moment they asked, with a
// random serial, kept so the QR code on it can be checked later.
//
// * `GET /api/member/card`, `POST /api/member/card` `{}`: their latest card, and a new one (routes
//   in `member.ts`; what goes on a card is `cardView` there).
// * `GET /api/public/card/{serial}`: anyone may check a code; unknown, deleted and malformed
//   serials get the same 404.
//
// A card holds what the member page showed, in words, and nothing else: it is built field by
// field from the stored snapshot, so a field added to the snapshot stays private until named here.

import { randomBytes } from "node:crypto";
import { errorMessage, getLogger } from "@miyoria/kernel";
import {
  type MemberCardRecord,
  type MemberCardStore,
  MemberCardStoreKey,
  StoreError,
} from "@miyoria/store";
import {
  type AccountRef,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";
import { ApiError } from "./errors.js";
import { clientKey, localDay, tooMany } from "./public.js";
import { param, type Route } from "./route.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";
import type { IssuedCard, MemberCard, MemberCards } from "./types.js";

const log = getLogger("api.card");

/** Most cards a person may be issued per local day. */
export const CARDS_PER_DAY = 5;
/** Cards an export lists at most. */
const MAX_EXPORTED = 1_000;

const OVER_LIMIT = "今天的卡已經發完了,明天再來";
const NO_STORE = "這個 Core 還不能發卡";
const NO_SUCH_CARD = "這張卡不存在或已經作廢";

/** Pictures of her per affinity band; `stranger` for someone she does not know (or will not say). */
export const CARD_POSES: Readonly<Record<string, readonly string[]>> = {
  stranger: ["calm", "finger"],
  很差: ["cold"],
  不太好: ["sweat", "smug"],
  普通: ["calm", "finger", "smug"],
  不錯: ["smile", "finger", "hand"],
  很好: ["blush", "squint", "hand"],
  非常好: ["heart", "blush", "squint"],
};

// ---- serials --------------------------------------------------------------------------------

/** Crockford base32: no I, L, O or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SERIAL_CHARS = 12;
const MAX_SERIAL_INPUT = 64;

function formatSerial(body: string): string {
  return `MYR-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** A fresh `MYR-XXXX-XXXX-XXXX`: 60 bits from the system's CSPRNG. */
export function newSerial(): string {
  let bits = randomBytes(8).readBigUInt64BE(0);
  let body = "";
  for (let i = 0; i < SERIAL_CHARS; i++) {
    body = ALPHABET[Number(bits & 31n)] + body;
    bits >>= 5n;
  }
  return formatSerial(body);
}

/**
 * The canonical serial of what someone typed or scanned, `null` when it cannot be one: any case,
 * dashes and spaces optional, and the letters Crockford reads as digits (I, L as 1, O as 0).
 */
export function normalizeSerial(input: string): string | null {
  if (input.length > MAX_SERIAL_INPUT) return null;
  const flat = input.toUpperCase().replace(/[\s-]/g, "");
  if (!flat.startsWith("MYR")) return null;
  const body = flat.slice(3).replace(/[IL]/g, "1").replace(/O/g, "0");
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(body)) return null;
  return formatSerial(body);
}

// ---- cards ----------------------------------------------------------------------------------

/** One of the band's poses, by `random` in [0, 1). */
export function pickPose(affinity: string | null, random: () => number): string {
  const poses = (affinity !== null ? CARD_POSES[affinity] : undefined) ?? CARD_POSES.stranger;
  const list = poses && poses.length > 0 ? poses : ["calm"];
  const i = Math.min(Math.max(Math.floor(random() * list.length), 0), list.length - 1);
  return list[i] as string;
}

const text = (v: JsonValue | undefined): string | null => (typeof v === "string" ? v : null);

/** A stored card as it may leave, or `null` when the snapshot is not one. */
function issuedCard(r: MemberCardRecord): IssuedCard | null {
  const s = r.snapshot;
  const name = text(s.name);
  const pose = text(s.pose);
  const number = s.number;
  if (name === null || pose === null || typeof number !== "number" || !Number.isInteger(number)) {
    return null;
  }
  return {
    serial: r.serial,
    issued_at: r.issued_at,
    name,
    avatar_url: text(s.avatar_url),
    number,
    call_name: text(s.call_name),
    relationship: text(s.relationship),
    affinity: text(s.affinity),
    trust: text(s.trust),
    familiarity: text(s.familiarity),
    public_feeling: text(s.public_feeling),
    pose,
  };
}

function snapshotOf(card: IssuedCard): JsonObject {
  const { serial: _serial, issued_at: _at, ...rest } = card;
  return rest;
}

/** Whose cards these are. */
export interface CardHolder {
  session: SessionRecord;
  /** The session account and every account of the person she knows them as. */
  accounts: readonly AccountRef[];
  person: PersonId | null;
}

/** Start of the current local day, as public stats count days. */
function todayStart(state: ApiState): string {
  const offset = state.publicSide.config.utc_offset_minutes;
  return toTimestamp(localDay(state.now(), offset) * 86_400_000 - offset * 60_000);
}

/** `GET /api/member/card`. */
export async function memberCards(state: ApiState, holder: CardHolder): Promise<MemberCards> {
  const store = state.optional(MemberCardStoreKey);
  if (!store) return { latest: null, today: 0, per_day: CARDS_PER_DAY };
  const profile = state.profile();
  const [latest] = await store.listFor(profile, holder.accounts, 1);
  return {
    latest: latest ? issuedCard(latest) : null,
    today: await store.countSince(profile, holder.accounts, todayStart(state)),
    per_day: CARDS_PER_DAY,
  };
}

/** Issues run one at a time, so two clicks cannot both take the last card of the day. */
const issuing = new WeakMap<ApiState, Promise<unknown>>();

function serialized<T>(state: ApiState, run: () => Promise<T>): Promise<T> {
  const before = issuing.get(state) ?? Promise.resolve();
  const next = before.then(run, run);
  issuing.set(
    state,
    next.catch(() => undefined),
  );
  return next;
}

async function issue(
  state: ApiState,
  store: MemberCardStore,
  holder: CardHolder,
  view: MemberCard,
): Promise<IssuedCard> {
  const profile = state.profile();
  const today = await store.countSince(profile, holder.accounts, todayStart(state));
  if (today >= CARDS_PER_DAY) throw new ApiError(429, OVER_LIMIT);
  const card: IssuedCard = {
    serial: newSerial(),
    issued_at: toTimestamp(state.now()),
    name: holder.session.name,
    avatar_url: holder.session.avatar_url,
    number: (await store.countFor(profile, holder.accounts)) + 1,
    call_name: view.call_name,
    relationship: view.relationship,
    affinity: view.affinity,
    trust: view.trust,
    familiarity: view.familiarity,
    public_feeling: view.public_feeling,
    pose: pickPose(view.affinity, state.random),
  };
  // 60 bits do not collide; a retry costs nothing if they ever do.
  for (let attempt = 0; ; attempt++) {
    try {
      await store.issue({
        serial: card.serial,
        profile,
        account: holder.session.account,
        person: holder.person,
        issued_at: card.issued_at,
        snapshot: snapshotOf(card),
      });
      return card;
    } catch (error) {
      if (!(error instanceof StoreError) || !/already exists/.test(error.message) || attempt >= 2) {
        throw error;
      }
      card.serial = newSerial();
    }
  }
}

/** `POST /api/member/card`: a card of `view`, what the member page shows them right now. */
export async function issueCard(
  state: ApiState,
  holder: CardHolder,
  view: MemberCard,
): Promise<IssuedCard> {
  const store = state.optional(MemberCardStoreKey);
  if (!store) throw ApiError.unavailable(NO_STORE);
  return serialized(state, () => issue(state, store, holder, view));
}

/** Their cards for the export, newest first. */
export async function cardsOf(state: ApiState, accounts: readonly AccountRef[]) {
  const store = state.optional(MemberCardStoreKey);
  if (!store) return [];
  const records = await store.listFor(state.profile(), accounts, MAX_EXPORTED);
  return records.map(issuedCard).filter((c): c is IssuedCard => c !== null);
}

/** Deletes every card of `accounts` (forgetting); they then fail the check. */
export async function deleteCards(state: ApiState, accounts: readonly AccountRef[]) {
  const store = state.optional(MemberCardStoreKey);
  return store ? store.deleteFor(state.profile(), accounts) : 0;
}

// ---- the public check -----------------------------------------------------------------------

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // A card can be deleted: nobody may keep the answer.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** `GET /api/public/card/{serial}`. */
async function checkCard(state: ApiState, c: ApiContext): Promise<Response> {
  const wait = state.publicSide.admitCardCheck(clientKey(c));
  if (wait !== null) return tooMany(wait);
  const missing = () => answer(404, { error: NO_SUCH_CARD });
  const serial = normalizeSerial(param(c, "serial"));
  const store = state.optional(MemberCardStoreKey);
  if (serial === null || !store) return missing();
  let found: MemberCardRecord | null;
  try {
    found = await store.bySerial(state.profile(), serial);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot check a card");
    return answer(503, { error: "not available right now" });
  }
  const card = found && isJsonObject(found.snapshot) ? issuedCard(found) : null;
  return card ? answer(200, card) : missing();
}

/** The public card check; none when `[modules.api.public] enabled` is off. */
export function cardCheckRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  return [
    {
      method: "GET",
      path: "/api/public/card/:serial",
      public: true,
      handler: (c) => checkCard(state, c),
    },
  ];
}
