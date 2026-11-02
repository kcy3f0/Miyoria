// @miyoria/self: her inner state (docs/design/autonomy.md §4).
//
// Module `SelfModule` (`self`) keeps her drives (social, play, attention, rest, curiosity) and
// boredom, which drift on their own and drop when something satisfies them; the policy she sets
// for herself (talkativeness per scope with an expiry and a reason, initiative); her agenda; and
// her own description of how she feels about each person. Provides `SelfStateKey` and the
// `self` prompt section. Her mood stays with the `mood` module (`MoodSignalsKey`).
//
// Persisted in the `SettingsStore` of the active profile: `self:state` and one
// `self:feeling:<person id>` per person.

export { type SelfConfig, SelfConfigSchema, selfConfig } from "./config.js";
export { type Circumstances, IDLE, SavedSchema, SelfEngine, SelfError } from "./engine.js";
export { FEELING_PREFIX, FeelingsBook, feelingKey } from "./feelings.js";
export {
  eventDelta,
  NUDGE_TOPIC,
  SelfModule,
  type SelfModuleOptions,
  STATE_KEY,
} from "./module.js";
export { SelfPrompt } from "./prompt.js";
export { SelfService, type SelfServiceDeps } from "./state.js";
