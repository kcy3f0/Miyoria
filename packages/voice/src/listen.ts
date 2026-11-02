// Listening: audio streams → consent filter → segmentation → ASR → `voice_utterance` events.

import { errorMessage, interval, type ModuleContext } from "@miyoria/kernel";
import { type AsrHint, durationMs, isOffloaded, type SpeechService } from "@miyoria/speech";
import { newId, SpeechPauseKey, sameAccount, toTimestamp } from "@miyoria/types";
import type { BargeIn } from "./barge.js";
import { segmenterConfig, type VoiceConfig } from "./config.js";
import type { Consent } from "./consent.js";
import type { AudioEvent, StreamInfo, VoiceLink } from "./link/link.js";
import { Segmenter, type Utterance } from "./segment.js";
import { cleanTranscript, echoesHint } from "./text.js";
import { LATENCY_TOPIC } from "./topics.js";
import type { Semaphore } from "./util.js";
import { EnergyVad } from "./vad.js";

/** Streams without frames for this long are closed. */
const STALE_STREAM_MS = 30_000;
const SWEEP_MS = 5_000;

interface Stream {
  info: StreamInfo;
  /** `null` when the speaker is not listened to (no consent, self). */
  segmenter: Segmenter<EnergyVad> | null;
  lastFrame: number;
}

/** Everything the listening loop and its ASR tasks need. */
export interface ListenerDeps {
  ctx: ModuleContext;
  link: VoiceLink;
  speech: SpeechService;
  consent: Consent;
  config: VoiceConfig;
  barge: BargeIn;
  asrSlots: Semaphore;
}

export class Listener {
  readonly #d: ListenerDeps;
  readonly #streams = new Map<number, Stream>();

  constructor(deps: ListenerDeps) {
    this.#d = deps;
  }

  /** Consumes `audio` until it ends or `signal` aborts. */
  async run(audio: AsyncIterable<AudioEvent>, signal: AbortSignal): Promise<void> {
    const sweep = this.#sweep(signal);
    try {
      for await (const event of audio) {
        if (signal.aborted) break;
        switch (event.type) {
          case "stream_open": {
            const stream = await this.#open(event.info);
            const old = this.#streams.get(event.info.stream);
            this.#streams.set(event.info.stream, stream);
            if (old) this.#close(old);
            break;
          }
          case "frame": {
            const s = this.#streams.get(event.stream);
            if (s) this.#frame(s, event.samples);
            break;
          }
          case "stream_close": {
            const s = this.#streams.get(event.stream);
            this.#streams.delete(event.stream);
            if (s) this.#close(s);
            break;
          }
        }
      }
    } finally {
      await sweep;
    }
  }

  async #sweep(signal: AbortSignal): Promise<void> {
    for await (const _ of interval(SWEEP_MS, signal)) {
      const now = this.#d.ctx.clock.now();
      for (const [id, s] of this.#streams) {
        if (now - s.lastFrame > STALE_STREAM_MS) {
          this.#d.ctx.log.debug({ stream: id }, "closing stale audio stream");
          this.#streams.delete(id);
          this.#close(s);
        }
      }
    }
  }

  async #open(info: StreamInfo): Promise<Stream> {
    const { link, consent, config, ctx } = this.#d;
    let listen: boolean;
    if (link.isSelf(info.speaker)) {
      listen = false;
    } else if (!(await consent.allowed(info.speaker))) {
      ctx.log.debug({ speaker: info.speaker.id }, "no voice consent, dropping stream");
      listen = false;
    } else if (info.sampleRate < 8_000) {
      ctx.log.warn({ sample_rate: info.sampleRate }, "unsupported capture sample rate");
      listen = false;
    } else {
      listen = true;
    }
    const segmenter = listen
      ? new Segmenter(new EnergyVad({ sampleRate: info.sampleRate }), {
          ...segmenterConfig(config),
          sampleRate: info.sampleRate,
        })
      : null;
    return { info, segmenter, lastFrame: ctx.clock.now() };
  }

  #frame(stream: Stream, samples: Int16Array): void {
    stream.lastFrame = this.#d.ctx.clock.now();
    const seg = stream.segmenter;
    if (!seg) return; // Not listened to: the audio is discarded right here.
    const utterances = seg.push(samples);
    const guild = stream.info.context.scope;
    if (guild !== null) this.#d.barge.observe(guild, seg.speechRunMs());
    for (const u of utterances) this.#transcribe(stream.info, u);
  }

  #close(stream: Stream): void {
    const u = stream.segmenter?.finish() ?? null;
    if (u) this.#transcribe(stream.info, u);
  }

  /** Runs ASR in the background (bounded by `asr_concurrency`). */
  #transcribe(info: StreamInfo, utterance: Utterance): void {
    // The ASR worker gave its model to the song worker: drop what was said, do not queue it up.
    const paused = this.#d.ctx.services.get(SpeechPauseKey)?.paused() ?? null;
    if (paused !== null) {
      this.#d.ctx.log.debug(
        { speaker: info.speaker.id, speech_ms: utterance.speechMs, reason: paused },
        "speech is paused; dropping an utterance",
      );
      return;
    }
    const detected = this.#d.ctx.clock.now();
    const endedAt = detected - utterance.trailingSilenceMs;
    const startedAt = endedAt - utterance.speechMs;
    this.#d.ctx.spawn("asr", async (signal) => {
      try {
        await this.#asr(info, utterance, startedAt, endedAt, signal);
      } catch (error) {
        if (!signal.aborted) {
          this.#d.ctx.log.warn({ err: errorMessage(error) }, "ASR task failed");
        }
      }
    });
  }

  #hint(guild: string): AsrHint {
    const { config, link } = this.#d;
    let prompt =
      config.asr_prompt !== null && config.asr_prompt.trim() !== "" ? config.asr_prompt : null;
    if (config.asr_prompt_participants) {
      const names = link
        .participants(guild)
        .map((p) => p.display_name)
        .filter((n) => n !== "");
      if (names.length > 0) {
        const joined = names.join("、");
        prompt = prompt === null ? joined : `${prompt} ${joined}`;
      }
    }
    return { language: config.asr_language, prompt };
  }

  async #asr(
    info: StreamInfo,
    utterance: Utterance,
    startedAt: number,
    endedAt: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { ctx, speech, config, link, asrSlots } = this.#d;
    const release = await asrSlots.acquire(signal);
    try {
      const guild = info.context.scope ?? "";
      const hint = this.#hint(guild);
      const audio = { sampleRate: info.sampleRate, samples: utterance.samples };
      const audioMs = durationMs(audio);
      const t0 = ctx.clock.now();
      let provider: string;
      let transcript: Awaited<ReturnType<SpeechService["transcribe"]>>[1];
      try {
        [provider, transcript] = await speech.transcribe(audio, hint, signal);
      } catch (error) {
        if (signal.aborted) return;
        const err = errorMessage(error);
        if (isOffloaded(err)) ctx.log.debug({ err, speaker: info.speaker.id }, "ASR is offloaded");
        else ctx.log.warn({ err, speaker: info.speaker.id }, "ASR failed");
        return;
      }
      const now = ctx.clock.now();
      const transcribeMs = Math.max(0, now - t0);
      const asrMs = Math.max(0, now - endedAt);
      const text = cleanTranscript(transcript.text, config.to_traditional, config.hallucinations);
      if (text === null) {
        ctx.log.debug({ raw: transcript.text }, "dropped empty or hallucinated transcript");
        return;
      }
      if (echoesHint(text, hint.prompt)) {
        ctx.log.debug(
          { raw: transcript.text },
          "dropped a transcript that only repeats the ASR hint",
        );
        return;
      }
      const displayName =
        link.participants(guild).find((p) => sameAccount(p.account, info.speaker))?.display_name ||
        info.displayName;
      ctx.log.info({ speaker: displayName, text, asr_ms: asrMs }, "voice utterance");
      ctx.publish({
        type: "voice_utterance",
        data: {
          id: newId(),
          context: info.context,
          speaker: { account: info.speaker, display_name: displayName, is_bot: false },
          text,
          language: transcript.language,
          emotion: transcript.emotion,
          audio_events: transcript.audio_events,
          started_at: toTimestamp(startedAt),
          ended_at: toTimestamp(endedAt),
          asr_ms: asrMs,
        },
      });
      ctx.publish({
        type: "custom",
        data: {
          topic: LATENCY_TOPIC,
          payload: {
            stage: "asr",
            context: { ...info.context },
            speaker: { ...info.speaker },
            provider,
            audio_ms: audioMs,
            transcribe_ms: transcribeMs,
            asr_ms: asrMs,
          },
        },
      });
    } finally {
      release();
    }
  }
}
