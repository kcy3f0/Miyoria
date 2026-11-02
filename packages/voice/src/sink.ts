// Speaking: `VoiceSink` → TTS → voice node playback.

import { errorMessage, type ModuleContext } from "@miyoria/kernel";
import {
  type AudioChunk,
  type AudioStream,
  isOffloaded,
  SpeechError,
  type SpeechService,
} from "@miyoria/speech";
import {
  type ContextKey,
  contextKeyString,
  type PlaybackState,
  type SpeakOutcome,
  SpeechPauseKey,
  type TurnId,
  VoiceFloorKey,
  type VoiceSink,
} from "@miyoria/types";
import type { BargeIn } from "./barge.js";
import type { VoiceConfig, VoiceProfile } from "./config.js";
import { VoiceLinkError } from "./link/conn.js";
import type { VoiceLink } from "./link/link.js";
import type { Playback } from "./link/playback.js";
import { stripTags } from "./text.js";
import { LATENCY_TOPIC } from "./topics.js";
import type { SpeechTranslator } from "./translate.js";
import { aborted } from "./util.js";

export interface SpeakerDeps {
  ctx: ModuleContext;
  link: VoiceLink;
  speech: SpeechService;
  profile: VoiceProfile;
  config: VoiceConfig;
  barge: BargeIn;
  /** Set when she speaks in another language than she writes (`tts_translate`). */
  translator: SpeechTranslator | null;
}

/** `first` followed by the rest of `it`; `return()` releases `it`. */
function prepend(first: AudioChunk, it: AsyncIterator<AudioChunk>): AudioStream {
  let sentFirst = false;
  const stream: AsyncIterableIterator<AudioChunk> = {
    next() {
      if (!sentFirst) {
        sentFirst = true;
        return Promise.resolve({ value: first, done: false });
      }
      return it.next();
    },
    async return() {
      await it.return?.();
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return stream;
    },
  };
  return stream;
}

/** The `VoiceSink` provided by the `voice` module. */
export class Speaker implements VoiceSink {
  readonly #d: SpeakerDeps;
  readonly speaksIn: string | null;

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

  async #start(
    context: ContextKey,
    guild: string,
    text: string,
    emotion: string | null,
    turn: TurnId | null,
    signal: AbortSignal | undefined,
  ): Promise<Playback> {
    const { ctx, speech, profile, config, link, translator } = this.#d;
    const t0 = ctx.clock.now();
    const said = translator ? await translator.translate(text, signal) : text;
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
            provider,
            chars: [...said].length,
            first_audio_ms: firstAudioMs,
          },
        },
      },
      { turn },
    );
    return link.play(guild, first.sampleRate, prepend(first, it));
  }

  prepare(_context: ContextKey, rawText: string, spoken?: string): void {
    const text = stripTags(rawText);
    if (text === "") return;
    const said = spoken === undefined ? "" : stripTags(spoken);
    if (said !== "") this.#d.translator?.provide(text, said);
    else this.#d.translator?.prepare(text);
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
    // A song holds the channel: the line would wait behind it in the node and come out late.
    const holder = this.#d.ctx.services.get(VoiceFloorKey)?.holder(guild) ?? null;
    if (holder !== null) {
      this.#d.ctx.log.debug({ guild, holder }, "voice channel is held; dropping her line");
      return "interrupted";
    }
    // The GPU is the song worker's for now: the TTS worker has no model to speak with.
    const paused = this.#d.ctx.services.get(SpeechPauseKey)?.paused() ?? null;
    if (paused !== null) {
      this.#d.ctx.log.debug({ guild, reason: paused }, "speech is paused; dropping her line");
      return "interrupted";
    }
    let playback: Playback;
    try {
      playback = await this.#start(context, guild, text, emotion, turn, signal);
    } catch (error) {
      const err = errorMessage(error);
      if (isOffloaded(err)) this.#d.ctx.log.debug({ err }, "cannot start speech: TTS is offloaded");
      else this.#d.ctx.log.warn({ err }, "cannot start speech");
      this.#playbackEvent(context, turn, "failed", text, emotion);
      throw error;
    }
    this.#playbackEvent(context, turn, "started", text, emotion);
    const barge = this.#d.barge;
    const token = barge.register(guild, playback);
    let state: PlaybackState;
    try {
      // Cancelling `speak` (e.g. the scheduler timed it out) stops the playback.
      const cancelled = signal ? aborted(signal).then(() => null) : new Promise<null>(() => {});
      const done = await Promise.race([playback.wait(), cancelled]);
      if (done === null) throw signal?.reason ?? new VoiceLinkError("speech cancelled");
      state = done;
    } finally {
      barge.unregister(guild, token);
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
