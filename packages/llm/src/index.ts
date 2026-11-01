// @miyoria/llm: the LLM layer.
//
// * `ChatProvider` is implemented per API family; `OpenAiProvider` (kinds `openai-compatible`,
//   `openai`, `deepseek`, `opencode`) ships here.
// * `LlmRouter` maps a purpose (`chat`, `fast`, `summarizer`, `game`, `vision`, ...) to a
//   fallback chain of `provider:model` references, tracks usage, cost and the budget.
// * `LlmModule` (id `llm`) builds providers from `[llm]` through `ProviderFactory`s and
//   provides the router as `LlmRouterKey`.

export {
  BUDGET_TOPIC,
  type BudgetConfig,
  BudgetConfigSchema,
  type BudgetEventPayload,
  type BudgetState,
  budgetConfig,
  type CostReport,
  CostTracker,
  callCost,
  type EventSink,
  type ModelUsage,
  type OnExhausted,
  type PeriodReport,
  type Pricing,
  PricingSchema,
  periodKeys,
  pricing,
  USAGE_KEY_PREFIX,
  USAGE_PROFILE,
} from "./cost.js";
export { MockProvider } from "./mock.js";
export {
  type LlmConfig,
  LlmConfigSchema,
  LlmModule,
  type LlmModuleOptions,
  LlmRouterKey,
  type ProviderConfig,
  ProviderConfigSchema,
  type ProviderFactory,
  USAGE_FLUSH_INTERVAL_MS,
} from "./module.js";
export * from "./openai/index.js";
export { LlmRouter, type LlmRouterOptions, type UsageRecord } from "./router.js";
export { contextHash, contextSession, sessionId } from "./session.js";
export {
  assistantMessage,
  BudgetExhaustedError,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatRole,
  type ChatStream,
  collectResponse,
  completeChat,
  LlmError,
  type ModelRef,
  ModelRefSchema,
  modelRefString,
  ProviderHttpError,
  parseModelRef,
  type StreamEvent,
  systemMessage,
  type ToolCall,
  type ToolSpec,
  toolResultMessage,
  tryParseModelRef,
  type Usage,
  userMessage,
} from "./types.js";
export { MIYORIA_VERSION } from "./version.js";
