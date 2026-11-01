// @miyoria/initiative: module `initiative`, the decision engine behind her unprompted messages.

export {
  defaultInitiativeConfig,
  type InitiativeConfig,
  InitiativeConfigSchema,
  isContextDisabled,
} from "./config.js";
export {
  type Blocked,
  type Emission,
  Engine,
  emissionEvent,
  type InitiativeReason,
  type Signals,
  type Snapshot,
  SnapshotSchema,
} from "./engine.js";
export {
  InitiativeModule,
  type InitiativeModuleOptions,
  STATE_KEY,
  STATE_PROFILE,
} from "./module.js";
