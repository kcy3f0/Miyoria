import {
  type AccountRef,
  type ActionId,
  type Clock,
  type ContextKey,
  type IncomingMessage,
  systemClock,
  type TurnId,
  timestampMs,
  type VoiceParticipant,
} from "@miyoria/types";
import { accountId } from "./util.js";

/** A speaking signal older than this is treated as lost. */
const SPEAKING_STALE_MS = 30_000;

export interface HistoryEntry {
  author: string;
  account: AccountRef;
  text: string;
  /** Epoch ms. */
  ts: number;
  isSelf: boolean;
  /** Her message was submitted as this action and not yet seen echoed back. */
  pending: ActionId | null;
  /** Said out loud in a voice channel (a transcript, or her speech). */
  spoken: boolean;
  /** Her speech was cut off before she finished. */
  interrupted: boolean;
  /** The turn her speech belongs to. */
  turn: TurnId | null;
}

/** Someone else seen in a context (Rust `session::Participant`). */
export interface SessionParticipant {
  account: AccountRef;
  displayName: string;
  /** Epoch ms. */
  lastSeen: number;
}

/** Short-term working memory of one conversation context. */
export class Session {
  readonly context: ContextKey;
  readonly #limit: number;
  readonly #clock: Clock;
  readonly #history: HistoryEntry[] = [];
  /** Keyed by account; insertion order = most recently active last. */
  readonly #participants = new Map<string, SessionParticipant>();
  #lastSelfAt: number | null = null;
  /** Who is in the voice channel (voice contexts only). */
  #voiceMembers: VoiceParticipant[] = [];
  /** People currently speaking, with when they started (clock ms). */
  readonly #speaking = new Map<string, number>();

  constructor(context: ContextKey, limit: number, clock: Clock = systemClock) {
    this.context = context;
    this.#limit = Math.max(limit, 1);
    this.#clock = clock;
  }

  /**
   * Records a platform message. Her own messages that echo a submitted reply confirm the
   * existing entry instead of adding a duplicate.
   */
  recordMessage(msg: IncomingMessage, isSelf: boolean): void {
    this.#record(msg, isSelf, false);
  }

  /** Records a transcribed voice utterance of someone else. */
  recordUtterance(msg: IncomingMessage): void {
    this.#record(msg, false, true);
  }

  #record(msg: IncomingMessage, isSelf: boolean, spoken: boolean): void {
    const text = messageText(msg);
    const ts = timestampMs(msg.ts);
    if (isSelf) {
      this.#lastSelfAt = this.#lastSelfAt === null ? ts : Math.max(this.#lastSelfAt, ts);
      const echo = this.#history.find((e) => e.pending !== null && e.text.trim() === text.trim());
      if (echo) {
        echo.pending = null;
        echo.account = msg.author.account;
        return;
      }
    } else {
      const key = accountId(msg.author.account);
      this.#participants.delete(key);
      this.#participants.set(key, {
        account: msg.author.account,
        displayName: msg.author.display_name,
        lastSeen: ts,
      });
    }
    this.#push({
      author: msg.author.display_name,
      account: msg.author.account,
      text,
      ts,
      isSelf,
      pending: null,
      spoken,
      interrupted: false,
      turn: null,
    });
  }

  /** Records a reply she just submitted (`ts` epoch ms). */
  recordOwn(author: string, account: AccountRef, text: string, action: ActionId, ts: number): void {
    this.#lastSelfAt = ts;
    this.#push({
      author,
      account,
      text,
      ts,
      isSelf: true,
      pending: action,
      spoken: false,
      interrupted: false,
      turn: null,
    });
  }

  /**
   * Records a sentence of hers that started playing. Sentences of the same turn are joined
   * into one entry.
   */
  recordSpeech(
    author: string,
    account: AccountRef,
    text: string,
    turn: TurnId | null,
    ts: number,
  ): void {
    this.noteSelfSpoke(ts);
    const trimmed = text.trim();
    if (trimmed === "") return;
    const last = this.#history.at(-1);
    if (last?.isSelf && last.spoken && !last.interrupted && turn !== null && last.turn === turn) {
      last.text += trimmed;
      return;
    }
    this.#push({
      author,
      account,
      text: trimmed,
      ts,
      isSelf: true,
      pending: null,
      spoken: true,
      interrupted: false,
      turn,
    });
  }

  /**
   * Marks her speech of `turn` as cut off. Without a matching entry (the start was missed)
   * `text` is recorded as interrupted speech.
   */
  recordInterruption(
    author: string,
    account: AccountRef,
    text: string,
    turn: TurnId | null,
    ts: number,
  ): void {
    const found = this.#history.findLast(
      (e) => e.isSelf && e.spoken && turn !== null && e.turn === turn,
    );
    if (found) {
      found.interrupted = true;
    } else {
      this.recordSpeech(author, account, text, turn, ts);
      const last = this.#history.at(-1);
      if (last?.isSelf) last.interrupted = true;
    }
    this.noteSelfSpoke(ts);
  }

  /** She was talking at `ts` (start or end of her speech). */
  noteSelfSpoke(ts: number): void {
    this.#lastSelfAt = this.#lastSelfAt === null ? ts : Math.max(this.#lastSelfAt, ts);
  }

  /** Removes a submitted reply that was never delivered. */
  forgetAction(action: ActionId): void {
    for (let i = this.#history.length - 1; i >= 0; i--) {
      if (this.#history[i]?.pending === action) this.#history.splice(i, 1);
    }
    this.#lastSelfAt = this.#history.findLast((e) => e.isSelf)?.ts ?? null;
  }

  #push(entry: HistoryEntry): void {
    this.#history.push(entry);
    while (this.#history.length > this.#limit) this.#history.shift();
  }

  history(): readonly HistoryEntry[] {
    return this.#history;
  }

  /** The last `n` entries, oldest first. */
  recent(n: number): HistoryEntry[] {
    return this.#history.slice(Math.max(this.#history.length - n, 0));
  }

  /** Epoch ms of her last words, if any. */
  lastSelfAt(): number | null {
    return this.#lastSelfAt;
  }

  /**
   * Her share of the last `window` messages. Short histories count as if padded to `window`,
   * so one early reply does not trip the limit.
   */
  selfShare(window: number): number {
    const w = Math.max(window, 1);
    const own = this.recent(w).filter((e) => e.isSelf).length;
    return own / w;
  }

  /** Other people seen in this context, most recently active first. */
  participants(): SessionParticipant[] {
    return [...this.#participants.values()].reverse().sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Replaces the voice channel roster; people who left stop speaking. */
  setVoiceMembers(members: VoiceParticipant[]): void {
    for (const key of [...this.#speaking.keys()]) {
      if (!members.some((m) => accountId(m.account) === key)) this.#speaking.delete(key);
    }
    this.#voiceMembers = members;
  }

  voiceMembers(): readonly VoiceParticipant[] {
    return this.#voiceMembers;
  }

  setSpeaking(account: AccountRef, speaking: boolean): void {
    const key = accountId(account);
    if (speaking) {
      if (!this.#speaking.has(key)) this.#speaking.set(key, this.#clock.now());
    } else {
      this.#speaking.delete(key);
    }
  }

  /** Someone else is speaking right now (signals older than 30 s are considered lost). */
  someoneSpeaking(): boolean {
    const now = this.#clock.now();
    for (const since of this.#speaking.values()) {
      if (Math.max(now - since, 0) < SPEAKING_STALE_MS) return true;
    }
    return false;
  }
}

/** Message text as shown in history; attachments are noted inline. */
export function messageText(msg: IncomingMessage): string {
  let text = msg.text.trim();
  for (const a of msg.attachments) {
    if (text !== "") text += " ";
    text += `[附件: ${a.filename}]`;
  }
  return text;
}
