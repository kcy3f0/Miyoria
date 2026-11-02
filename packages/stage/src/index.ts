// @miyoria/stage: her body on the streaming PC.
//
// * Module `stage.link` (`StageLinkModule`, Core side) serves the Stage Link WebSocket
//   (`docs/protocols/stage-link.md`), forwards emotions, subtitles and speaking state to the
//   Stage node and provides `StageLinkKey` (scene, stream, hotkey, gaze, status). It registers
//   `stream start | stop | scene <name> | status` and follows the voice node's Go Live with OBS
//   (`voice.golive` → OBS "Start / Stop Streaming").
//
//   ```toml
//   [modules."stage.link"]
//   bind = "127.0.0.1:7882"
//   token = "${STAGE_LINK_TOKEN}"
//   ```
//
// * `runStage` (Stage side, `miyoria stage`) connects to Core and drives VTube Studio (`vts`:
//   expressions, hotkeys, lip sync and idle motion by parameter injection), OBS (`obs`) and the
//   overlay (`overlay`). The voice node streams playback levels to its lip-sync endpoint
//   (`lipsync`).

export {
  type AvatarAction,
  AvatarProfile,
  AvatarProfileError,
  type LipSyncMode,
  parseAvatarAction,
} from "./avatar.js";
export { EmotionController, type VtsCommand } from "./emotion.js";
export {
  describeStatus,
  PATHS as STREAM_COMMAND_PATHS,
  registerStreamCommands,
  unregisterStreamCommands,
} from "./link/commands.js";
export { checkHello, type HelloOutcome, tokenMatches } from "./link/conn.js";
export { EMOTION_TOPIC, Forwarder } from "./link/forward.js";
export { type GoLiveFollow, goliveFollow, VOICE_GOLIVE_TOPIC } from "./link/golive.js";
export {
  DEFAULT_BIND,
  ERROR_TOPIC,
  STATUS_TOPIC,
  StageLink,
  type StageLinkConfig,
  StageLinkConfigSchema,
  StageLinkError,
  StageLinkKey,
} from "./link/link.js";
export { StageLinkModule } from "./link/module.js";
export {
  defaultLipSyncConfig,
  Envelope,
  Levels,
  type LipSyncConfig,
  LipSyncConfigSchema,
  type Mouth,
  MouthShaper,
  type ServeResult,
  serveLevels,
} from "./lipsync.js";
export {
  type GazeConfig,
  GazeConfigSchema,
  type GazePose,
  GazePoseSchema,
  gazePose,
  IdleMotion,
  MOTION_PARAMS,
} from "./motion.js";
export { BindError, type BoundAddress, formatAddress, parseBind } from "./net.js";
export {
  defaultObsState,
  type Obs,
  type ObsConfig,
  ObsConfigSchema,
  type ObsConnector,
  ObsController,
  ObsError,
  type ObsState,
  ObsWebSocketConnector,
} from "./obs.js";
export { OverlayHub, serveOverlay } from "./overlay.js";
export {
  CLOSE,
  type CoreMessage,
  defaultStageStatus,
  encodeMessage,
  type GazeTarget,
  type LevelFrame,
  parseCoreMessage,
  parseGazeTarget,
  parseLevelFrame,
  parseStageMessage,
  type SpeakingState,
  type StageMessage,
  type StageStatus,
  type StreamAction,
  sameStatus,
  VERSION,
} from "./protocol.js";
export {
  parseStageConfig,
  type RunStageOptions,
  runStage,
  runStageWith,
  type StageConfig,
  StageConfigSchema,
  type StageConfigSection,
  StageError,
} from "./runtime.js";
export {
  API_NAME,
  API_VERSION,
  ApiError,
  ERROR_USER_DENIED,
  type Expression,
  type Hotkey,
  type ModelInfo,
  type PluginInfo,
  pluginInfo,
  tokenPath,
  VtsClient,
  type VtsConfig,
  VtsConfigSchema,
  VtsError,
} from "./vts.js";
