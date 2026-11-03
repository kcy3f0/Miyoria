// @miyoria/self: her inner state (docs/design/autonomy.md §4, §23).
//
// Module `SelfModule` (`self`) keeps her emotions (七情: discrete, coexisting, each fading at
// its own pace, how fast set by the profile's temperament) and what she shows of them (display
// rules); her drives (六欲: social, play, attention, rest, curiosity, esteem, hunger, longing)
// and boredom, which drift on their own and drop when something satisfies them; the romance
// she feels for people, her emotions toward them and her secret crush; the policy she sets for
// herself (talkativeness per scope with an expiry and a reason, initiative); her agenda; and
// her own description of how she feels about each person. Provides `SelfStateKey` and the
// `self` and `emotion` prompt sections. Her mood stays with the `mood` module
// (`MoodSignalsKey`), which follows her emotions (`SelfState.affect`).
//
// Persisted in the `SettingsStore` of the active profile: `self:state` and one
// `self:feeling:<person id>` per person.

export {
  type EmotionsConfig,
  type HeartConfig,
  type SelfConfig,
  SelfConfigSchema,
  selfConfig,
} from "./config.js";
export { shownEmotion } from "./display.js";
export {
  BASE_HALF_LIFE_MINS,
  BASE_TOWARD_HALF_LIFE_MINS,
  type DisplayRules,
  EmotionEngine,
  fade,
  stir,
  type Temper,
  type Temperament,
  type TemperamentInput,
  temperament,
} from "./emotions.js";
export { type Circumstances, IDLE, SavedSchema, SelfEngine, SelfError } from "./engine.js";
export { FEELING_PREFIX, FeelingsBook, feelingKey } from "./feelings.js";
export { HeartBook } from "./heart.js";
export {
  eventDelta,
  NUDGE_TOPIC,
  SelfModule,
  type SelfModuleOptions,
  STATE_KEY,
} from "./module.js";
export { EmotionPrompt, feltLine, SelfPrompt, shownLine } from "./prompt.js";
export { EmotionRules, FEEL_TOPIC, type RuleDeps } from "./rules.js";
export { SelfService, type SelfServiceDeps } from "./state.js";
