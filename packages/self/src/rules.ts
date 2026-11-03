// Cheap rule triggers of her emotions: events whose meaning is explicit (praise, insults, a
// death in a game, a song finished or cut off, someone she missed coming back, someone she
// likes talking warmly with others while ignoring her). The rest is read by the batched `fast`
// LLM pass of the social module (`social.appraisal`) and by her own mind loop.
//
// Every rule appraises against what she cares about: how much she cares about the person
// (affinity, romance), whether they are her crush, what she wants right now (drives).

import {
  type AccountRef,
  type ContextKey,
  contextKeyString,
  EMOTION_NAMES,
  type EmotionName,
  type Event,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  PERSON_EMOTION_NAMES,
  type PersonEmotionName,
  type PersonId,
  parseSongCue,
  SALIENT_TOPIC,
  SOCIAL_APPRAISAL_TOPIC,
  SOCIAL_EVENT_TOPIC,
  SONG_TOPIC,
} from "@miyoria/types";
import type { SelfConfig } from "./config.js";
import type { SelfService } from "./state.js";

/** Bus topic of emotion nudges from games and extensions (see `feelEffects`). */
export const FEEL_TOPIC = "self.feel";
/** Bus topic of the LLM budget (`@miyoria/llm` `BUDGET_TOPIC`). */
const BUDGET_TOPIC = "llm.budget";
const MINUTE_MS = 60_000;

type Emo = Partial<Record<EmotionName, number>>;

/** What a social event kind stirs: her emotions, toward the person, romance, drives. */
interface Reaction {
  feel: Emo;
  toward?: Partial<Record<PersonEmotionName, number>>;
  /** Romance per event (positive: only with people she likes, scaled by how much). */
  romance?: number;
  esteem?: number;
  hunger?: number;
  cause: string;
}

const REACTIONS: Readonly<Record<string, Reaction>> = {
  greeting: { feel: { joy: 0.05 }, romance: 0.005, cause: "跟我打招呼" },
  thanks: {
    feel: { joy: 0.15, shy: 0.1, pride: 0.1 },
    romance: 0.01,
    esteem: -0.05,
    cause: "跟我道謝",
  },
  praise: {
    feel: { joy: 0.2, shy: 0.3, pride: 0.25 },
    romance: 0.03,
    esteem: -0.15,
    cause: "誇我",
  },
  gift: {
    feel: { joy: 0.3, gratitude: 0.3 },
    toward: { gratitude: 0.5 },
    romance: 0.04,
    hunger: -0.3,
    cause: "送我東西",
  },
  friendly: { feel: { joy: 0.1 }, romance: 0.015, cause: "對我很好" },
  apology: { feel: { anger: -0.15 }, toward: { resentment: -0.3 }, cause: "跟我道歉" },
  warm: { feel: { joy: 0.15 }, romance: 0.03, cause: "對我很溫柔" },
  cold: {
    feel: { sorrow: 0.15 },
    toward: { resentment: 0.1 },
    romance: -0.02,
    cause: "對我很冷淡",
  },
  rude: {
    feel: { anger: 0.3 },
    toward: { resentment: 0.25 },
    romance: -0.03,
    cause: "對我很沒禮貌",
  },
  insult: {
    feel: { anger: 0.5, sorrow: 0.15 },
    toward: { resentment: 0.45 },
    romance: -0.08,
    esteem: 0.1,
    cause: "罵我",
  },
  harassment: {
    feel: { anger: 0.6, fear: 0.3, disgust: 0.4 },
    toward: { resentment: 0.6 },
    romance: -0.25,
    cause: "威脅、騷擾我",
  },
  flirt_too_far: {
    feel: { disgust: 0.5, anger: 0.3 },
    toward: { resentment: 0.3 },
    romance: -0.1,
    cause: "對我講噁心的話",
  },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const num = (v: JsonValue | undefined, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: JsonValue | undefined) => (typeof v === "string" ? v : null);

function short(name: string | null): string {
  if (name === null) return "有人";
  const flat = name.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > 24 ? `${chars.slice(0, 24).join("")}…` : flat || "有人";
}

function isEmotionName(s: string): s is EmotionName {
  return (EMOTION_NAMES as readonly string[]).includes(s);
}

function isPersonEmotionName(s: string): s is PersonEmotionName {
  return (PERSON_EMOTION_NAMES as readonly string[]).includes(s);
}

export interface RuleDeps {
  self: SelfService;
  config: SelfConfig;
  /** Person of an account (the social module's cache), if known. */
  personOf: (account: AccountRef) => PersonId | null;
  /** One of her own accounts. */
  isSelf: (accountId: string) => boolean;
  /** Her voice channel, if she is in one. */
  herVoice: () => ContextKey | null;
}

/** Turns events into her emotions. One instance per module run (it keeps short memories). */
export class EmotionRules {
  /** When her last song ended (`finished`: sung to the end). */
  #song: { at: number; finished: boolean } | null = null;
  #singing = false;
  /** Lines someone she cares about said to other people, per person (epoch ms). */
  readonly #toOthers = new Map<PersonId, number[]>();
  /** When someone last talked to her. */
  readonly #toHer = new Map<PersonId, number>();
  /** When she last got jealous of someone (one stir per window). */
  readonly #jealous = new Map<PersonId, number>();
  #budget = "ok";

  constructor(private readonly d: RuleDeps) {}

  /** Applies whatever `event` means to her; returns whether anything was felt. */
  handle(event: Event, now: number): boolean {
    switch (event.type) {
      case "platform_message_created": {
        const m = event.data;
        if (m.author.is_bot || this.d.isSelf(m.author.account.id)) return false;
        const person = this.d.personOf(m.author.account);
        if (person === null) return false;
        const direct = m.mentions_self || m.reply_to_self || m.id.context.kind === "dm";
        const replied = m.referenced?.author ?? null;
        const toOther =
          !direct &&
          replied !== null &&
          !this.d.isSelf(replied.id) &&
          !(replied.platform === m.author.account.platform && replied.id === m.author.account.id);
        this.#line(person, m.author.display_name, direct, toOther, false, now);
        return true;
      }
      case "voice_utterance": {
        const u = event.data;
        if (u.speaker.is_bot || this.d.isSelf(u.speaker.account.id)) return false;
        const person = this.d.personOf(u.speaker.account);
        if (person === null) return false;
        const voice = this.d.herVoice();
        const together = voice !== null && contextKeyString(voice) === contextKeyString(u.context);
        this.#line(person, u.speaker.display_name, together, false, true, now);
        return true;
      }
      case "custom":
        return this.#custom(event.data.topic, event.data.payload, now);
      default:
        return false;
    }
  }

  #custom(topic: string, payload: JsonValue, now: number): boolean {
    if (topic === SOCIAL_EVENT_TOPIC) return this.#social(payload, now);
    if (topic === SOCIAL_APPRAISAL_TOPIC) return this.#appraisal(payload, now);
    if (topic === FEEL_TOPIC) return this.#feelEvent(payload);
    if (topic === SALIENT_TOPIC) return this.#salient(payload);
    if (topic === SONG_TOPIC) return this.#songCue(payload, now);
    if (topic === BUDGET_TOPIC) return this.#budgetState(payload);
    if (topic.startsWith("game.")) return this.#game(topic, payload);
    return false;
  }

  // ---- people -------------------------------------------------------------------------

  /**
   * Someone said something: to her (or, `voice`, in her voice channel), or to someone else
   * (`toOther`, a reply to another person).
   */
  #line(
    person: PersonId,
    name: string,
    toHer: boolean,
    toOther: boolean,
    voice: boolean,
    now: number,
  ): void {
    const self = this.d.self;
    const crush = self.crushPerson() === person;
    this.#back(person, name, toHer);
    if (toHer) {
      this.#toHer.set(person, now);
      this.#toOthers.delete(person);
      if (crush && voice) {
        // Being in voice with her crush is satisfied over time (the tick); a line helps a bit.
        self.adjust({ longing: -0.02 }, "event");
      } else if (crush) {
        self.adjust({ longing: -this.d.config.satisfy.crush_message_longing }, "event");
        self.feel("shy", 0.12, `${short(name)}跟我說話`, person);
      }
      return;
    }
    if (!toOther) return;
    const care = self.care(person);
    if (care <= 0) return;
    const e = this.d.config.emotions;
    const window = e.jealousy_window_mins * MINUTE_MS;
    const lines = (this.#toOthers.get(person) ?? []).filter((t) => now - t < window);
    lines.push(now);
    this.#toOthers.set(person, lines);
    const talkedToHer = now - (this.#toHer.get(person) ?? Number.NEGATIVE_INFINITY) < window;
    const last = this.#jealous.get(person) ?? Number.NEGATIVE_INFINITY;
    if (lines.length < Math.max(e.jealousy_lines, 1) || talkedToHer || now - last < window) return;
    this.#jealous.set(person, now);
    const amount = 0.2 * care + (crush ? 0.2 : 0);
    self.feelToward(person, "jealousy", amount, `${short(name)}一直跟別人聊,都不理我`);
    if (crush) self.adjust({ longing: 0.1 }, "event");
  }

  /** Someone she missed is back: the relief shows as joy (and some shyness for her crush). */
  #back(person: PersonId, name: string | null, together: boolean): void {
    const self = this.d.self;
    const missed = self.seen(person, name, together);
    if (missed < this.d.config.emotions.notice) return;
    self.feel("joy", missed * 0.6, `${short(name)}回來了`, person);
    self.feel("surprise", 0.15, `${short(name)}回來了`, person);
    if (self.crushPerson() === person)
      self.feel("shy", missed * 0.5, `${short(name)}回來了`, person);
  }

  #salient(payload: JsonValue): boolean {
    if (!isJsonObject(payload)) return false;
    const kind = str(payload.kind);
    const person = str(payload.person);
    if (person === null || (kind !== "came_online" && kind !== "joined_voice")) return false;
    // Online is not with her yet; joining her voice channel is.
    const voice = this.d.herVoice();
    const ctx = payload.context;
    const together =
      kind === "joined_voice" &&
      voice !== null &&
      isJsonObject(ctx) &&
      ctx.channel === voice.channel &&
      ctx.scope === voice.scope;
    this.#back(person, str(payload.display_name), together);
    return true;
  }

  /** `social.event`: something someone did toward her (uncapped, unlike the numbers). */
  #social(payload: JsonValue, now: number): boolean {
    if (!isJsonObject(payload)) return false;
    const person = str(payload.person);
    const kind = str(payload.kind);
    // Her own hints (mind) are already her feelings.
    if (person === null || kind === null || payload.source === "mind") return false;
    const r = REACTIONS[kind];
    if (!r) return false;
    const self = this.d.self;
    const name = str(payload.name);
    const scale = clamp(Math.abs(num(payload.scale, 1)), 0, 1) || 1;
    const who = short(name);
    const crush = self.crushPerson() === person;
    for (const [emotion, amount] of Object.entries(r.feel) as [EmotionName, number][]) {
      self.feel(emotion, amount * scale, `${who}${r.cause}`, person);
    }
    for (const [emotion, amount] of Object.entries(r.toward ?? {}) as [
      PersonEmotionName,
      number,
    ][]) {
      self.feelToward(person, emotion, amount * scale, `${who}${r.cause}`);
    }
    if (kind === "praise" || kind === "thanks") {
      const song = this.#song;
      const sinceSong = song ? now - song.at : Number.POSITIVE_INFINITY;
      if (this.#singing || sinceSong <= this.d.config.emotions.song_praise_mins * MINUTE_MS) {
        self.feel("pride", 0.35, `${who}誇我的歌`, person);
        self.adjust({ esteem: -0.15 }, "event");
      }
      // Praise from her crush makes her flustered.
      if (crush) self.feel("shy", 0.2, `${who}${r.cause}`, person);
    }
    const romance = (r.romance ?? 0) * scale;
    if (romance > 0) {
      const liking = self.liking(person);
      if (liking > 0) self.romance(person, romance * liking);
    } else if (romance < 0) {
      self.romance(person, romance);
    }
    const drives: { esteem?: number; hunger?: number } = {};
    if (r.esteem !== undefined) drives.esteem = r.esteem * scale;
    if (r.hunger !== undefined) drives.hunger = r.hunger * scale;
    if (Object.keys(drives).length > 0) self.adjust(drives, "event");
    return true;
  }

  /** `social.appraisal`: the `fast` model's reading of a conversation. */
  #appraisal(payload: JsonValue, now: number): boolean {
    if (!isJsonObject(payload)) return false;
    const self = this.d.self;
    const max = this.d.config.emotions.max_event_nudge;
    let any = false;
    if (isJsonObject(payload.her)) {
      for (const [name, v] of Object.entries(payload.her)) {
        if (!isEmotionName(name) || typeof v !== "number" || !(v > 0)) continue;
        // The reading is a hint: half of it, bounded.
        self.feel(name, clamp(v * 0.5, 0, max), "剛剛的對話");
        any = true;
      }
    }
    const people = Array.isArray(payload.people) ? payload.people : [];
    for (const raw of people) {
      if (!isJsonObject(raw)) continue;
      const person = str(raw.person);
      if (person === null) continue;
      any = true;
      const who = short(str(raw.name));
      const crush = self.crushPerson() === person;
      const romance = clamp(num(raw.romance), -1, 1);
      if (romance > 0) {
        const liking = self.liking(person);
        if (liking > 0) {
          self.romance(person, 0.05 * romance * liking);
          // Being flirted with by someone she likes: flustered.
          self.feel("shy", 0.3 * romance * liking, `${who}對我好溫柔`, person);
        }
      } else if (romance < 0) {
        self.romance(person, 0.03 * romance);
      }
      const others = clamp(num(raw.others), 0, 1);
      const toward = clamp(num(raw.toward_her), -1, 1);
      const care = self.care(person);
      if (others >= 0.4 && toward <= 0.1 && care > 0) {
        const last = this.#jealous.get(person) ?? Number.NEGATIVE_INFINITY;
        if (now - last >= this.d.config.emotions.jealousy_window_mins * MINUTE_MS) {
          this.#jealous.set(person, now);
          const amount = others * (0.25 * care + (crush ? 0.25 : 0));
          self.feelToward(person, "jealousy", amount, `${who}對別人那麼好,卻不理我`);
          if (crush) self.adjust({ longing: 0.1 }, "event");
        }
      }
      if (raw.promise === "kept") {
        self.feelToward(person, "gratitude", 0.3, `${who}說到做到`);
        self.feel("joy", 0.15, `${who}說到做到`, person);
      } else if (raw.promise === "broken") {
        self.feelToward(person, "resentment", 0.3, `${who}食言了`);
        self.feel("sorrow", crush ? 0.35 : 0.2, `${who}食言了`, person);
      }
    }
    return any;
  }

  /**
   * `self.feel`: `{"emotion": "pride", "amount": 0.3, "cause": "…", "person": "…"}`, or
   * `{"emotions": {"joy": 0.2, ...}, "cause": "…"}`, or toward someone with `"toward"`
   * (`missing` / `jealousy` / `gratitude` / `resentment`) and `"person"`.
   */
  #feelEvent(payload: JsonValue): boolean {
    if (!isJsonObject(payload)) return false;
    const max = this.d.config.emotions.max_event_nudge;
    const self = this.d.self;
    const cause = str(payload.cause) ?? str(payload.reason) ?? "";
    const person = str(payload.person);
    const amount = clamp(num(payload.amount), -max, max);
    const toward = str(payload.toward);
    if (toward !== null && person !== null && isPersonEmotionName(toward)) {
      self.feelToward(person, toward, amount, cause);
      return amount !== 0;
    }
    const all: JsonObject = isJsonObject(payload.emotions) ? { ...payload.emotions } : {};
    const one = str(payload.emotion);
    if (one !== null) all[one] = amount;
    let any = false;
    for (const [name, v] of Object.entries(all)) {
      if (!isEmotionName(name) || typeof v !== "number") continue;
      self.feel(name, clamp(v, -max, max), cause, person);
      any = true;
    }
    return any;
  }

  // ---- what she does ------------------------------------------------------------------

  #songCue(payload: JsonValue, now: number): boolean {
    const cue = parseSongCue(payload);
    if (!cue) return false;
    const self = this.d.self;
    if (cue.state === "started") {
      this.#singing = true;
      return false;
    }
    if (cue.state !== "ended") return false;
    this.#singing = false;
    if (cue.outcome === "finished") {
      this.#song = { at: now, finished: true };
      self.feel("pride", 0.3, "唱完一整首歌");
      self.feel("joy", 0.2, "唱完一整首歌");
      self.adjust({ esteem: -0.25, attention: -0.1 }, "event");
      return true;
    }
    if (cue.outcome === "interrupted") {
      // Cut off (skipped or stopped): she does not know it was not about her singing.
      this.#song = { at: now, finished: false };
      self.feel("sorrow", 0.3, "歌被切掉了");
      self.feel("frustration", 0.35, "歌被切掉了");
      self.adjust({ esteem: 0.1 }, "event");
      return true;
    }
    return false;
  }

  #game(topic: string, payload: JsonValue): boolean {
    const obj = isJsonObject(payload) ? payload : null;
    const kind = str(obj?.type) ?? topic.slice(topic.lastIndexOf(".") + 1);
    const self = this.d.self;
    if (kind === "death") {
      self.feel("frustration", 0.5, "遊戲裡死掉了");
      self.feel("anger", 0.3, "遊戲裡死掉了");
      self.adjust({ esteem: 0.1 }, "event");
      return true;
    }
    if (kind === "advancement") {
      self.feel("pride", 0.4, "遊戲裡達成成就");
      self.feel("joy", 0.3, "遊戲裡達成成就");
      self.adjust({ esteem: -0.2 }, "event");
      return true;
    }
    return false;
  }

  /** Her 白飯 rationed (the LLM budget degraded or exhausted): hungry and sulky. */
  #budgetState(payload: JsonValue): boolean {
    const state = isJsonObject(payload) ? str(payload.state) : null;
    if (state === null || state === this.#budget) return false;
    const was = this.#budget;
    this.#budget = state;
    if (state === "ok" || (was === "exhausted" && state === "degraded")) return false;
    this.d.self.adjust({ hunger: 0.25 }, "event");
    this.d.self.feel("frustration", 0.2, "白飯被限量了");
    return true;
  }
}
