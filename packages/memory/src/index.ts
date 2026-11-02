// @miyoria/memory: long-term memory (module `memory`).
//
// * Consolidation: when a context goes quiet (or many lines piled up), new log lines are
//   summarized by the `summarizer` purpose into an episode, facts, her own notes and followups,
//   written from her perspective, deduplicated against existing records and stored.
// * Retrieval: hybrid score of vector similarity, full text, recency, importance and "about
//   someone present", restricted to the scopes visible in the current context (`scope.ts`).
//   Embeddings are optional.
// * Privacy: what is learned in a DM stays in that DM.
// * Prompt contributor `memory`, tools `remember` / `recall`, commands
//   `/me memory show | forget | export`, `/admin memory wipe`, a `FollowupSource` and daily
//   forgetting.

export {
  type MemoryCommandDeps,
  MemoryCommands,
  NODE_WIPE,
  PATHS,
  WIPE_RESTARTS,
  WIPE_SCOPE_LABEL,
  type WipeScope,
  wipePlan,
} from "./commands.js";
export {
  type DedupeConfig,
  DedupeConfigSchema,
  type EmbeddingConfig,
  EmbeddingConfigSchema,
  embeddingConfig,
  type ForgettingConfig,
  ForgettingConfigSchema,
  type GuildScope,
  GuildScopeSchema,
  type MemoryConfig,
  MemoryConfigSchema,
  memoryConfig,
  type Weights,
  WeightsSchema,
} from "./config.js";
export {
  CONTRIBUTOR_KEY,
  formatLines,
  MemoryContributor,
  PROMPT_KINDS,
  SECTION_TITLE,
} from "./contributor.js";
export {
  buildEmbedder,
  cosine,
  type Embedder,
  EmbeddingError,
  NoEmbedder,
  OpenAiCompatibleEmbedder,
} from "./embed.js";
export {
  type ConsolidationReport,
  MAINTENANCE_KEY,
  type MaintenanceReport,
  MemoryEngine,
  MemoryEngineKey,
  type MemoryEngineOptions,
  MemoryError,
  matchesKeyword,
  memoryFilter,
  type NewMemory,
  type Recalled,
  type Searched,
  type Stored,
  storedId,
  toFollowup,
  WATERMARK_PREFIX,
  type Watermark,
} from "./engine.js";
export {
  type ExEpisode,
  type ExFact,
  type ExFollowup,
  type ExNote,
  type Extraction,
  ExtractionError,
  parseExtraction,
  type SubjectName,
  systemPrompt,
  transcript,
} from "./extract.js";
export {
  type Activity,
  ActivityTracker,
  MemoryModule,
  MemoryModuleError,
  type MemoryModuleOptions,
} from "./module.js";
export {
  hasScope,
  isPrivate,
  presentPeople,
  requestScopes,
  scopeEquals,
  scopeForNew,
  scopeLabel,
  visibleScopes,
} from "./scope.js";
export {
  finalScore,
  recency,
  relativeDate,
  type Signals,
  signalScore,
  signals,
  tokenOverlap,
} from "./score.js";
export { normalizeForCompare, textSimilarity, tokenize, tokenString } from "./tokenize.js";
export { MemoryToolError, RECALL, REMEMBER, RecallTool, RememberTool } from "./tools.js";
