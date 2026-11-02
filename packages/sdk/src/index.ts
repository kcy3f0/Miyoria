// @miyoria/sdk: write Miyoria extensions in TypeScript.

export {
  type CommandArg,
  type CommandDefinition,
  type EventHandler,
  type ExtensionContext,
  type ExtensionDefinition,
  ExtensionRuntime,
  type LogFields,
  type Logger,
  type PromptContributor,
  type PromptSectionInput,
  type RunOptions,
  type ToolDefinition,
  commandPath,
  commandSpec,
  defineExtension,
  runExtension,
  startStdio,
  toolDecl,
} from "./extension.js";
export { FrameDecoder, FramingError, MAX_FRAME, encodeFrame } from "./framing.js";
export {
  type ActionResult,
  type GameAction,
  type GameActionSpec,
  type GameAdapter,
  type GameEvent,
  type GameInfo,
  type GameObservation,
  type RegisteredAdapter,
  actToolSchema,
  describeActions,
  formatActionResult,
  formatObservation,
  registerGameAdapter,
} from "./game.js";
export { type NotificationHandler, type PeerOptions, type RequestHandler, RpcError, RpcPeer } from "./rpc.js";
export { isValidTopic, topicMatches } from "./topics.js";
export * from "./types.js";
