// @miyoria/mind: her mind loop (docs/design/autonomy.md §5).
//
// Module `MindModule` (`mind`) thinks on its own: on salient changes in the world, on an
// adaptive heartbeat, after her turns, when the voice channel she is in goes quiet and when
// another module suggests something (initiative's idle channels, greetings, voice joins,
// followups). Each thought is one `mind` LLM call over a compact snapshot (world summary,
// her inner state, people and places with short refs, agenda, recent thoughts, memories) and
// returns her monologue plus bounded changes: feelings, drive nudges, talkativeness and
// initiative, agenda items and intents. Intents go to the agent (`IntentSinkKey`) and through
// the gate as principal `self`. Everything lands in her thought journal (`mind.thought`).
// Provides `MindKey`.

export { type MindConfig, MindConfigSchema, mindConfig } from "./config.js";
export {
  type Condense,
  DIGEST_PREFIX,
  type DigestOptions,
  digestKey,
  intentCounts,
  Journal,
  ruleDigest,
  THOUGHT_PREFIX,
  thoughtKey,
} from "./journal.js";
export {
  applyTurnEvent,
  MAX_QUIET_MINUTES,
  MIN_SELF_TALK,
  type MindDeps,
  MindLoop,
} from "./mind.js";
export { MIND_TOPICS, MindModule, type MindModuleOptions } from "./module.js";
export { type BudgetState, CallLog, heartbeatMs, inQuietHours, type Pace } from "./pace.js";
export {
  type AgendaRef,
  ASK,
  type CapabilityInfo,
  IDLE_NUDGE_THOUGHTS,
  type MindInput,
  mindData,
  mindMessages,
  OUTPUT_FORMAT,
  type PersonRef,
  type PlaceRef,
} from "./prompt.js";
export {
  type AffinityHint,
  type AgendaAdd,
  type DocDraft,
  type FeelingChange,
  type IntentDraft,
  MAX_DRIVE_NUDGE,
  MAX_THOUGHT,
  type MindReply,
  MindReplyError,
  parseMindReply,
  type TalkChange,
} from "./reply.js";
export {
  capabilityInfo,
  focusOf,
  type Gathered,
  gather,
  NOT_FOR_HER,
  singing,
} from "./snapshot.js";
