// Speaking: `VoiceSink` → TTS → voice node playback.

import { errorMessage, type ModuleContext, sleep } from "@miyoria/kernel";
import { type AudioChunk, isOffloaded, SpeechError, type SpeechService } from "@miyoria/speech";
import {
  type ContextKey,
  contextKeyString,
  customEvent,
  type PlaybackState,
  SPEECH_SYNTH_TOPIC,
  type SpeakOutcome,
  SpeechPauseKey,
  type TurnId,
  VOICE_BARGE_IN_TOPIC,
  VoiceFloorKey,
  type VoiceSink,
} from "@miyoria/types";
import type { BargeIn } from "./barge.js";
import type { VoiceConfig, VoiceProfile } from "./config.js";
import type { SelfEchoGuard } from "./echo.js";
import { VoiceLinkError } from "./link/conn.js";
import type { VoiceLink } from "./link/link.js";
import type { Playback } from "./link/playback.js";
import { BufferedAudio, type LinePrefetch, type PreparedLine, type Producer } from "./prefetch.js";
import { stripTags } from "./text.js";
import { LATENCY_TOPIC } from "./topics.js";
import type { SpeechTranslator } from "./translate.js";
import { aborted, deferred } from "./util.js";

export interface SpeakerDeps {
  ctx: ModuleContext;
  link: VoiceLink;
  speech: SpeechService;
  profile: VoiceProfile;
  config: VoiceConfig;
  barge: BargeIn;
  /** Set when she speaks in another language than she writes (`tts_translate`). */
  translator: SpeechTranslator | null;
  /** The LLM session of a conversation, which its translations share. */
  session(context: ContextKey): string;
  /** Remembers what she says, so her own voice coming back is not taken for somebody. */
  echo: SelfEchoGuard;
  /** Lines synthesized ahead of their turn; `null` when `tts_prefetch` is 0. */
  prefetch: LinePrefetch | null;
}

/** While a song or the GPU loan holds the floor, how often it is looked at again. */
const FLOOR_POLL_MS = 250;

/** The `VoiceSink` provided by the `voice` module. */
export class Speaker implements VoiceSink {
  readonly #d: SpeakerDeps;
  readonly speaksIn: string | null;
  /** The emotion of the last line spoken per guild: the likely one of the next line. */
  readonly #lastEmotion = new Map<string, string | null>();

  constructor(deps: SpeakerDeps) {
    this.#d = deps;
    this.speaksIn = deps.translator?.language ?? null;
  }

  #playbackEvent(
    context: ContextKey,
    turn: TurnId | null,
    state: PlaybackState,
    text: string,
    emotion: string | null,
  ) {
    this.#d.ctx.publish(
      { type: "voice_playback", data: { context, turn, state, text, emotion } },
      { turn },
    );
  }

  /**
   * Synthesizes `text`: translation, TTS, and a buffer that fills in the background. Resolves
   * once the first audio is there, so the line can start playing while the rest still arrives.
   */
  #producer(context: ContextKey, text: string, emotion: string | null): Producer {
    return async (signal) => {
      const { speech, profile, config, translator, session } = this.#d;
      const said = translator ? await translator.translate(text, signal, session(context)) : text;
      const request = {
        text: said,
        language: translator?.language ?? config.tts_language,
        emotion,
        instruct: profile.instructFor(emotion),
        voice: profile.voice,
      };
      const [provider, stream] = await speech.synthesize(request, signal);
      const it = stream[Symbol.asyncIterator]();
      let first: AudioChunk;
      try {
        for (;;) {
          const r = await it.next();
          if (r.done) throw new SpeechError("TTS returned no audio");
          if (r.value.samples.length > 0) {
            first = r.value;
            break;
          }
        }
      } catch (error) {
        Promise.resolve(it.return?.()).catch(() => undefined);
        throw error;
      }
      const stop = deferred<void>();
      const audio = new BufferedAudio(() => stop.resolve());
      signal.addEventListener("abort", () => stop.resolve(), { once: true });
      audio.push(first);
      const done = (async () => {
        try {
          for (;;) {
            const r = await Promise.race([it.next(), stop.promise.then(() => null)]);
            if (r === null) break;
            if (r.done) break;
            audio.push(r.value);
          }
          audio.end();
        } catch (error) {
          audio.fail(error);
        } finally {
          Promise.resolve(it.return?.()).catch(() => undefined);
        }
      })();
      return { line: { provider, said, sampleRate: first.sampleRate, audio }, done };
    };
  }

  #key(context: ContextKey, text: string, emotion: string | null): string {
    return `${contextKeyString(context)}\u0000${emotion ?? ""}\u0000${text}`;
  }

  async #start(
    context: ContextKey,
    guild: string,
    text: string,
    emotion: string | null,
    turn: TurnId | null,
    signal: AbortSignal | undefined,
  ): Promise<{ playback: Playback; said: string }> {
    const { ctx, link, prefetch } = this.#d;
    const t0 = ctx.clock.now();
    // The overlay says she is getting her line ready until it plays (or fails).
    ctx.publish(customEvent(SPEECH_SYNTH_TOPIC, { context: { ...context }, turn }), { turn });
    let line: PreparedLine | null = null;
    let prefetched = false;
    const taken = prefetch?.take(this.#key(context, text, emotion)) ?? null;
    if (taken !== null) {
      try {
        line = await raceAbort(taken, signal);
        prefetched = true;
      } catch (error) {
        if (signal?.aborted) throw error;
        ctx.log.debug({ err: errorMessage(error) }, "prefetched line failed, synthesizing again");
      }
    }
    if (line === null) {
      const production = await this.#producer(
        context,
        text,
        emotion,
      )(signal ?? new AbortController().signal);
      line = production.line;
    }
    const firstAudioMs = Math.max(0, ctx.clock.now() - t0);
    ctx.publish(
      {
        type: "custom",
        data: {
          topic: LATENCY_TOPIC,
          payload: {
            stage: "tts",
            context: { ...context },
            turn,
            provider: line.provider,
            chars: [...line.said].length,
            first_audio_ms: firstAudioMs,
            prefetched,
          },
        },
      },
      { turn },
    );
    try {
      const playback = await link.play(guild, line.sampleRate, line.audio);
      return { playback, said: line.said };
    } catch (error) {
      void line.audio[Symbol.asyncIterator]().return?.();
      throw error;
    }
  }

  /** Whether `emotion` is the one a prepared line should be synthesized with. */
  #prefetchEmotion(guild: string, emotion: string | null | undefined): string | null | undefined {
    if (emotion !== undefined) return emotion;
    // The reply's emotion carries on from line to line until it changes.
    return this.#lastEmotion.get(guild);
  }

  /** Drops every line prefetched for `guild` (somebody stopped her, a song took the floor). */
  cancelPrefetch(guild: string): void {
    this.#d.prefetch?.cancelGroup(guild);
  }

  /**
   * `emotion` (optional): the emotion the line will be spoken with, so it can be synthesized
   * ahead; when the caller does not know it, the previous line's is assumed.
   */
  prepare(context: ContextKey, rawText: string, spoken?: string, emotion?: string | null): void {
    const text = stripTags(rawText);
    if (text === "") return;
    const said = spoken === undefined ? "" : stripTags(spoken);
    const session = this.#d.session(context);
    if (said !== "") this.#d.translator?.provide(text, said, session);
    else this.#d.translator?.prepare(text, session);
    this.#prefetch(context, text, this.#prefetchEmotion(context.scope ?? "", emotion));
  }

  #prefetch(context: ContextKey, text: string, emotion: string | null | undefined): void {
    const { prefetch, speech, link, ctx } = this.#d;
    const guild = context.scope;
    if (prefetch === null || guild === null || emotion === undefined) return;
    if (!speech.hasTts() || !link.isConnected()) return;
    if (this.#held(guild) !== null) return;
    const key = this.#key(context, text, emotion);
    if (prefetch.has(key)) return;
    prefetch.start(key, guild, async (signal) => {
      try {
        return await this.#producer(context, text, emotion)(signal);
      } catch (error) {
        if (!signal.aborted) ctx.log.debug({ err: errorMessage(error) }, "TTS prefetch failed");
        throw error;
      }
    });
  }

  /** Why her speech cannot play now: a song holds the channel, or the GPU is lent out. */
  #held(guild: string): string | null {
    const { services } = this.#d.ctx;
    // A song holds the channel: the line would wait behind it in the node and come out late.
    const holder = services.get(VoiceFloorKey)?.holder(guild) ?? null;
    if (holder !== null) return holder;
    // The GPU is the song worker's for now: the TTS worker has no model to speak with.
    return services.get(SpeechPauseKey)?.paused() ?? null;
  }

  /**
   * Waits while the floor is held. Her lines queue up behind it (the scheduler runs them one
   * after the other) and are spoken when it is free, unless the wait gets longer than
   * `speech_hold_max_ms`: then the line is stale and dropped. Returns whether she may speak.
   */
  async #waitForFloor(
    context: ContextKey,
    guild: string,
    turn: TurnId | null,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const { ctx, config, barge } = this.#d;
    let held = this.#held(guild);
    if (held === null) return true;
    const since = ctx.clock.now();
    ctx.log.debug({ guild, holder: held }, "voice floor is held; her line waits");
    while (held !== null) {
      if (ctx.clock.now() - since >= config.speech_hold_max_ms) {
        ctx.log.debug({ guild, holder: held }, "voice floor held too long; dropping her line");
        ctx.publish(
          customEvent(VOICE_BARGE_IN_TOPIC, {
            context: { ...context },
            turn,
            account: null,
            action: "stop",
            reason: "floor",
          }),
          { turn },
        );
        return false;
      }
      await sleep(FLOOR_POLL_MS, signal);
      if (barge.isStopped(guild, turn)) return false;
      held = this.#held(guild);
    }
    return true;
  }

  async speak(
    context: ContextKey,
    rawText: string,
    emotion: string | null,
    turn: TurnId | null,
    signal?: AbortSignal,
  ): Promise<SpeakOutcome> {
    const guild = context.scope;
    if (guild === null) {
      throw new VoiceLinkError(`voice context \`${contextKeyString(context)}\` has no guild`);
    }
    const text = stripTags(rawText);
    if (text === "") return "completed";
    const { barge, echo } = this.#d;
    // Somebody stopped this turn's speech: the rest of its lines are not said.
    if (barge.isStopped(guild, turn)) return "interrupted";
    if (!(await this.#waitForFloor(context, guild, turn, signal))) return "interrupted";
    this.#lastEmotion.set(guild, emotion);
    let playback: Playback;
    let said: string;
    try {
      ({ playback, said } = await this.#start(context, guild, text, emotion, turn, signal));
    } catch (error) {
      const err = errorMessage(error);
      if (isOffloaded(err)) this.#d.ctx.log.debug({ err }, "cannot start speech: TTS is offloaded");
      else this.#d.ctx.log.warn({ err }, "cannot start speech");
      this.#playbackEvent(context, turn, "failed", text, emotion);
      throw error;
    }
    this.#playbackEvent(context, turn, "started", text, emotion);
    echo.started(guild, [text, said]);
    const token = barge.register(guild, playback, { context, turn });
    let state: PlaybackState;
    try {
      // Cancelling `speak` (e.g. the scheduler timed it out) stops the playback.
      const cancelled = signal ? aborted(signal).then(() => null) : new Promise<null>(() => {});
      const done = await Promise.race([playback.wait(), cancelled]);
      if (done === null) throw signal?.reason ?? new VoiceLinkError("speech cancelled");
      state = done;
    } finally {
      barge.unregister(guild, token);
      echo.ended(guild);
      playback.stop(0);
    }
    this.#playbackEvent(context, turn, state, text, emotion);
    switch (state) {
      case "finished":
        return "completed";
      case "interrupted":
        return "interrupted";
      default:
        throw new VoiceLinkError("playback failed");
    }
  }
}

/** `promise`, or the rejection with `signal.reason` once `signal` aborts first. */
async function raceAbort(
  promise: Promise<PreparedLine>,
  signal: AbortSignal | undefined,
): Promise<PreparedLine> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.then(abandon, () => undefined);
    throw signal.reason;
  }
  const cancelled = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } catch (error) {
    if (signal.aborted) promise.then(abandon, () => undefined);
    throw error;
  }
}

/** Lets go of a line nobody plays (stops synthesizing it). */
function abandon(line: PreparedLine): void {
  void line.audio[Symbol.asyncIterator]().return?.();
}
