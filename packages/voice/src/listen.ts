// Listening: audio streams → consent filter → segmentation → ASR → `voice_utterance` events.

import { errorMessage, interval, type ModuleContext } from "@miyoria/kernel";
import { type AsrHint, durationMs, isOffloaded, type SpeechService } from "@miyoria/speech";
import {
  type AccountRef,
  newId,
  SpeechPauseKey,
  sameAccount,
  TurnFocusViewKey,
  toTimestamp,
  VoiceFloorKey,
} from "@miyoria/types";
import type { BargeIn, BargeWho, SpeakerRole } from "./barge.js";
import { segmenterConfig, type VoiceConfig } from "./config.js";
import type { Consent } from "./consent.js";
import type { E2eLatency } from "./e2e.js";
import { looksLikeHintEcho, matchCore, type SelfEchoGuard } from "./echo.js";
import type { AudioEvent, StreamInfo, VoiceLink } from "./link/link.js";
import { Segmenter, type Utterance } from "./segment.js";
import { cleanTranscript, echoesHint } from "./text.js";
import { LATENCY_TOPIC } from "./topics.js";
import type { Semaphore } from "./util.js";
import { createVad, type Vad } from "./vad.js";

/** Streams without frames for this long are closed. */
const STALE_STREAM_MS = 30_000;
const SWEEP_MS = 5_000;

interface Stream {
  info: StreamInfo;
  /** `null` when the speaker is not listened to (no consent, self). */
  segmenter: Segmenter<Vad> | null;
  lastFrame: number;
  /** Their voice activity is on (barge-in was told they talk). */
  talking: boolean;
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
  /** Remembers her own lines, to tell her voice coming back from somebody talking. */
  echo: SelfEchoGuard;
  /** Words that call her (config `names` plus the profile's), lower-case not required. */
  names: readonly string[];
  /** Starts the end-to-end latency measurement of each accepted utterance. */
  e2e: E2eLatency;
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
      ? new Segmenter(
          createVad(
            {
              engine: config.vad_engine,
              sampleRate: info.sampleRate,
              sileroModel: config.vad_silero_model,
              sileroThreshold: config.vad_silero_threshold,
            },
            (engine) =>
              ctx.log.warn({ engine }, "VAD engine is not available: using the energy detector"),
          ),
          { ...segmenterConfig(config), sampleRate: info.sampleRate },
        )
      : null;
    return { info, segmenter, lastFrame: ctx.clock.now(), talking: false };
  }

  /** A song holds the channel (only an utterance that calls her counts then). */
  #music(guild: string): boolean {
    if (!this.#d.config.music_gate) return false;
    return (this.#d.ctx.services.get(VoiceFloorKey)?.holder(guild) ?? null) !== null;
  }

  /** How `speaker` relates to the turn in flight in `context`. */
  #who(info: StreamInfo, guild: string): BargeWho {
    const turn = this.#d.ctx.services.get(TurnFocusViewKey)?.current(info.context) ?? null;
    let role: SpeakerRole = "unknown";
    if (turn !== null) {
      role = turn.addressed_accounts.some((a) => sameAccount(a, info.speaker)) ? "focus" : "other";
    }
    return {
      speaker: info.speaker,
      role,
      context: info.context,
      turn: turn === null ? null : { id: turn.turn, phase: turn.phase },
      music: this.#music(guild),
    };
  }

  /** The transcript calls her. */
  #named(text: string): boolean {
    const heard = matchCore(text);
    return this.#d.names.some((n) => {
      const name = matchCore(n);
      return name !== "" && heard.includes(name);
    });
  }

  #frame(stream: Stream, samples: Int16Array): void {
    stream.lastFrame = this.#d.ctx.clock.now();
    const seg = stream.segmenter;
    if (!seg) return; // Not listened to: the audio is discarded right here.
    const utterances = seg.push(samples);
    const guild = stream.info.context.scope;
    if (guild !== null) {
      const run = seg.speechRunMs();
      if (run > 0) {
        stream.talking = true;
        this.#d.barge.observe(guild, run, this.#who(stream.info, guild));
      } else if (stream.talking) {
        stream.talking = false;
        this.#d.barge.speechEnded(guild, stream.info.speaker);
      }
    }
    for (const u of utterances) this.#transcribe(stream.info, u);
  }

  #close(stream: Stream): void {
    const guild = stream.info.context.scope;
    if (guild !== null && stream.talking) {
      stream.talking = false;
      this.#d.barge.speechEnded(guild, stream.info.speaker);
    }
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
      this.#letGo(info.context.scope, info.speaker, "timeout");
      return;
    }
    const guild = info.context.scope;
    if (guild !== null) this.#d.barge.utterance(guild, info.speaker);
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

  /** The speaker's utterance came to nothing: barge-in need not wait for it. */
  #letGo(guild: string | null, speaker: AccountRef, reason: "echo" | "music" | "timeout"): void {
    if (guild !== null) this.#d.barge.dropped(guild, speaker, reason);
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
    const { ctx, speech, config, link, asrSlots, barge, echo, e2e } = this.#d;
    const release = await asrSlots.acquire(signal);
    const guild = info.context.scope ?? "";
    // Barge-in waits for this transcript; whatever happens, it must not wait forever.
    let settled = false;
    const letGo = (reason: "echo" | "music" | "timeout") => {
      settled = true;
      this.#letGo(info.context.scope, info.speaker, reason);
    };
    try {
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
        letGo("echo");
        return;
      }
      if (echoesHint(text, hint.prompt) || looksLikeHintEcho(text, hint.prompt)) {
        ctx.log.debug(
          { raw: transcript.text },
          "dropped a transcript that only repeats the ASR hint",
        );
        letGo("echo");
        return;
      }
      if (echo.isEcho(guild, text)) {
        ctx.log.debug({ raw: transcript.text }, "dropped a transcript of her own voice");
        letGo("echo");
        return;
      }
      const named = this.#named(text);
      const who = this.#who(info, guild);
      if (who.music === true && !named) {
        ctx.log.debug({ raw: transcript.text }, "dropped a transcript while a song plays");
        letGo("music");
        return;
      }
      // Stops her (or lets her go on) before the utterance travels on to the agent.
      settled = true;
      barge.verdict(guild, { ...who, text, named, echo: false });
      const id = newId();
      // The person stopped talking at `endedAt`; a length-capped utterance never did.
      e2e.heard({
        context: info.context,
        utterance: id,
        speechEndAt: utterance.endedBy === "length" ? null : endedAt,
        sentAt: t0,
        transcriptAt: now,
      });
      const displayName =
        link.participants(guild).find((p) => sameAccount(p.account, info.speaker))?.display_name ||
        info.displayName;
      ctx.log.info({ speaker: displayName, text, asr_ms: asrMs }, "voice utterance");
      ctx.publish({
        type: "voice_utterance",
        data: {
          id,
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
      if (!settled) letGo("timeout");
      release();
    }
  }
}
