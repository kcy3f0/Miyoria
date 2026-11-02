// @miyoria/agent: the cognition core (module `agent`).
//
// Turns `platform.*` and `voice.*` events into replies: each conversation context keeps a
// `Session`, a coordinator debounces messages into turns, attention decides whether to respond,
// and the reply is generated through the `chat` LLM purpose (with an optional tool loop),
// parsed by the expression parser and submitted to the scheduler. In voice channels the reply
// is cut into sentences that are spoken while the model is still generating.
//
// Other modules shape her turns through optional services: prompt contributors
// (`PromptContributorsKey`) add per-turn context, `SocialSignalsKey` and `MoodSignalsKey` steer
// attention and tone, and `agent.initiative` events let her start conversations. `llm.budget`
// events make her save tokens (see `BudgetState`).

export { type Tool, type ToolContext, ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
export {
  type Assessment,
  type AttentionInput,
  ambientProbability,
  ambientScale,
  assess,
  decide,
  directReason,
  type Gate,
  isQuestion,
  mentionsTopic,
  type RandomSource,
  SeededRandom,
  type VoiceAttention,
} from "./attention.js";
export { activenessLabel, modeLabel, personaSummary } from "./commands.js";
export {
  ACTIVENESS_LEVELS,
  type Activeness,
  ActivenessSchema,
  type AgentConfig,
  AgentConfigSchema,
  type AttentionConfig,
  AttentionConfigSchema,
  activenessFor,
  CHANNEL_MODES,
  type ChannelMode,
  ChannelModeSchema,
  cooldownFactor,
  defaultAgentConfig,
  type HistoryConfig,
  HistoryConfigSchema,
  maxDebounceMs,
  modeFor,
  ParseError,
  parseActiveness,
  parseChannelMode,
  probabilityFactor,
  scaleByActiveness,
  typingRefreshMs,
  type VisionConfig,
  VisionConfigSchema,
  type VoiceConfig,
  VoiceConfigSchema,
  voiceMaxDebounceMs,
} from "./config.js";
export { Gathered, gather } from "./contributors.js";
export {
  DEFAULT_PAUSE_MS,
  Expression,
  ExpressionParser,
  MAX_PAUSE_MS,
  type Segment,
} from "./expression.js";
export {
  ACTIVENESS_PREFIX,
  AgentHandle,
  AgentHandleKey,
  MODE_PREFIX,
  voiceScope,
} from "./handle.js";
export { awaitBackfill, backfillLimit, replyParents, startBackfill } from "./history.js";
export { linkMentions, type MentionTarget } from "./mentions.js";
export { AgentModule } from "./module.js";
export { PersonaHandle, PersonaHandleKey } from "./persona.js";
export {
  ADDRESSED,
  AMBIENT,
  BOT_TAG,
  buildMessages,
  checkMessages,
  cleanReply,
  DATA_PREAMBLE,
  DEFAULT_TRANSCRIPT,
  GUARD_RULES,
  gapLine,
  INITIATIVE,
  INITIATIVE_HINT,
  INITIATIVE_SILENCE,
  INITIATIVE_TITLE,
  INTERRUPTED,
  MAX_PARENT_CHARS,
  PEOPLE_TITLE,
  PRESENT_TITLE,
  renderSections,
  replyTag,
  SELF_QUOTE_NAME,
  SITUATION,
  type Situation,
  type SituationData,
  SPOKEN_TAG,
  situationData,
  situationPrompt,
  splitMessage,
  TRANSCRIPT_RULES,
  type TranscriptOptions,
  transcriptLine,
  VOICE_ADDRESSED,
  VOICE_AMBIENT,
  VOICE_INITIATIVE,
  VOICE_PRESENT_TITLE,
  VOICE_SITUATION,
} from "./prompt.js";
export {
  type HistoryEntry,
  historyEntry,
  messageText,
  Session,
  type SessionParticipant,
} from "./session.js";
export {
  affinityAmbientFactor,
  affinityDirectFactor,
  attitudeHint,
  BUDGET_TOPIC,
  type BudgetState,
  EXHAUSTED_LINE,
  energyCooldownFactor,
  energyProbabilityFactor,
  IGNORE_DIRECT_AFFINITY,
  moodHint,
  parseBudgetState,
  tone,
} from "./signals.js";
export {
  type FencedPiece,
  FenceSplitter,
  isSpeakable,
  LinkSplitter,
  LONG_CLAUSE_CHARS,
  SentenceSplitter,
} from "./speech.js";
export { ReactTool, ToolArgumentError } from "./tools.js";
export { CheckError, parseCheck, TurnError, truncate } from "./turn.js";
export {
  allowedUrl,
  type FetchLike,
  type ImageCandidate,
  ImageLoader,
  imageParts,
  type LoadedImage,
  selectImages,
} from "./vision.js";
