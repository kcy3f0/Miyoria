import type { TurnId } from "./ids.js";
import type { AccountRef, Author, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** Someone in a voice channel she is in. */
export interface VoiceParticipant {
  account: AccountRef;
  display_name: string;
  /** One of her own accounts. */
  is_self: boolean;
  muted: boolean;
  deafened: boolean;
}

/** One finished, transcribed utterance of one speaker. */
export interface VoiceUtterance {
  id: string;
  /** Kind `voice`; `scope` = guild, `channel` = voice channel. */
  context: ContextKey;
  speaker: Author;
  text: string;
  language: string | null;
  /** Emotion tag from the ASR model, if it reports one (e.g. SenseVoice). */
  emotion: string | null;
  /** Non-speech events detected in the audio (laughter, applause, ...). */
  audio_events: string[];
  started_at: Timestamp;
  ended_at: Timestamp;
  /** Time from end of speech to transcript, in ms. */
  asr_ms: number;
}

/** Her own speech playback. `interrupted`: stopped early, e.g. someone talked over her. */
export type PlaybackState = "started" | "finished" | "interrupted" | "failed";

export type SpeakOutcome = "completed" | "interrupted";

/**
 * Provided by the voice module. The scheduler executes `speak` actions through it; the call
 * resolves once playback finished or was interrupted.
 */
export interface VoiceSink {
  /**
   * The language she is heard in when it differs from the one she writes (`tts_translate`);
   * `null` or absent when she speaks what she writes. A reply can then carry the spoken words
   * itself (`prepare`'s `spoken`), which saves the translation.
   */
  readonly speaksIn?: string | null;
  /**
   * Hint that `text` will be spoken in `context` soon (it was just queued), so slow preparation
   * such as translating it can start before its turn. `spoken`: the words to say for it in
   * `speaksIn`, when the reply already has them. Optional; never required before `speak`.
   */
  prepare?(context: ContextKey, text: string, spoken?: string): void;
  speak(
    context: ContextKey,
    text: string,
    emotion: string | null,
    turn: TurnId | null,
    signal?: AbortSignal,
  ): Promise<SpeakOutcome>;
}

export const VoiceSinkKey = serviceKey<VoiceSink>("VoiceSink");
