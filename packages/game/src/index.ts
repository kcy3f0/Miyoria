// @miyoria/game: the game director (module `game`).
//
// A game adapter extension exposes the tools `game_<id>_observe` / `game_<id>_act` and
// publishes `game.<id>.*` events. While a session runs (`game start`) the director observes the
// game every `decide_secs` (sooner on trigger events), asks the LLM purpose `game` (JSON mode)
// for `{goal, goal_status, action, commentary, mood_nudge}` and runs the action through the act
// tool; consumes `queue.item_activated` items of kind `game_goal` as locked goals; requests live
// commentary with `agent.initiative` (reason `game`); nudges the mood on deaths and
// achievements; and contributes a `game` prompt section.

export { formatStatus, registerCommands } from "./commands.js";
export {
  defaultGameConfig,
  type GameConfig,
  GameConfigSchema,
  type GamePermissions,
  GamePermissionsSchema,
} from "./config.js";
export {
  ActionCall,
  type Decision,
  type GoalFacts,
  type GoalSource,
  goalLocked,
  goalNote,
  judge,
  type MoodNudge,
  type PromptParts,
  parseDecision,
  prompts,
  type ReportedStatus,
  splitObservation,
  type Verdict,
  verdictDebug,
} from "./decision.js";
export {
  DECISION_TOPIC,
  Director,
  GameError,
  type GameStatus,
  type GoalView,
  INITIATIVE_REASON,
  type Persona,
  type Placement,
  View,
} from "./director.js";
export {
  GameControl,
  GameControlKey,
  GameHandle,
  GameHandleKey,
  GameModule,
  PROMPT_KEY,
} from "./module.js";
