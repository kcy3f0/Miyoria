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
  speak(
    context: ContextKey,
    text: string,
    emotion: string | null,
    turn: TurnId | null,
    signal?: AbortSignal,
  ): Promise<SpeakOutcome>;
}

export const VoiceSinkKey = serviceKey<VoiceSink>("VoiceSink");
