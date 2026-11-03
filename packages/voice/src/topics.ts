/**
 * Topic of latency measurements (`custom` events), with `stage` = `asr` (`asr_ms`,
 * `transcribe_ms`) or `tts` (`first_audio_ms`).
 */
export const LATENCY_TOPIC = "voice.latency";

/**
 * Topic of `VoiceBargeIn` custom events: somebody talked while she spoke and her speech was
 * ducked, paused, resumed or stopped (`@miyoria/types`).
 */
export { VOICE_BARGE_IN_TOPIC } from "@miyoria/types";
