// @miyoria/actions: everything she can do, behind one gate.
//
// * A `Capability` wraps one action (join voice, go live, switch scene, play, DM, ...) with a
//   risk tier, a zod argument schema and an executor. The module owning the wrapped service
//   registers it in the app's `ActuatorRegistry` (`ActuatorRegistryKey`).
// * `ActuatorRegistry.invoke` runs the gate (pause → prohibitions → consent → permission →
//   budget → risk: rate limits, self-review, owner approval), records the decision (audit log +
//   `gate.decision`) and executes. Callers say who they act for with a `Principal`
//   (`@miyoria/types`): her tools (`user` / `self`), slash commands (`command`, with override),
//   the panel (`panel`) and the game director (`director`).
// * Capabilities with a `tool` are offered to the model as tools in reactive turns.
// * Module `actions` applies `[modules.actions]` and serves `/admin autonomy ...` and
//   `/me privacy`.

export {
  builtinCapabilities,
  messageDm,
  priorityFor,
  recipient,
  speak,
  testHigh,
} from "./builtin.js";
export {
  ActionDeniedError,
  ActionDroppedError,
  type ActionOutcome,
  type ActionRequest,
  type ActionResult,
  type Capability,
  CapabilityError,
  type CapabilityTool as CapabilityToolInfo,
  type ConsentKind,
  defineCapability,
  deniedText,
  type ExecContext,
  type GateDecision,
  type GateStage,
  type Risk,
} from "./capability.js";
export {
  NODE_APPROVE,
  NODE_PRIVACY,
  NODE_TOGGLE,
  NODE_VIEW,
  PATHS as COMMAND_PATHS,
} from "./commands.js";
export {
  type ActionsConfig,
  ActionsConfigSchema,
  capabilityMatches,
  defaultActionsConfig,
  type Limit,
  type TierLimit,
} from "./config.js";
export { ActionsModule, actuatorsFor } from "./module.js";
export {
  DEFAULT_PRIVACY,
  PRIVACY_PROFILE,
  Privacy,
  type PrivacyChoices,
  privacyKey,
} from "./privacy.js";
export { effectiveLimits, type Limits, RateLimiter, tightened } from "./rate.js";
export {
  ActuatorRegistry,
  ActuatorRegistryKey,
  type ActuatorRegistryOptions,
  GATE_DECISION_TOPIC,
  type InvokeOptions,
  PAUSED_KEY,
} from "./registry.js";
export {
  type Answer,
  APPROVE_ROUTE,
  approvalCard,
  DENY_ROUTE,
  Escalations,
  parseReview,
  ReviewError,
  type ReviewInput,
  type ReviewReply,
  type ReviewVerdict,
  reviewMessages,
} from "./review.js";
export { CapabilityTool, REQUEST_RULE, REVIEW_PENDING } from "./tools.js";
