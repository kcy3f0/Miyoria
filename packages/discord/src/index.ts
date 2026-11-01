// @miyoria/discord: Discord bot account adapter (module `platform.discord.bot`).
//
// This is the official bot account: it reads and writes text messages, reacts, shows typing and
// serves slash commands from the `CommandRegistry`. It never joins voice; that is the separate
// self-account voice node. See `module.ts` for the Developer Portal setup.
//
// Pure logic lives in testable functions: `splitMessage` (split.ts), the discord.js <-> Miyoria
// mapping (mapping.ts), the slash command tree (slash.ts) and the interaction flow
// (interaction.ts).

export { type DiscordConfig, DiscordConfigSchema, validateDiscordConfig } from "./config.js";
export {
  type CommandDispatcher,
  type CommandInteractionLike,
  DEFER_AFTER_MS,
  HANDLER_FAILED_TEXT,
  handleCommandInteraction,
  invocationFromInteraction,
  type ReplyOptions,
  respond,
} from "./interaction.js";
export {
  type ArgValueLike,
  account,
  commandPath,
  contextKey,
  displayName,
  incomingMessage,
  isAdminPermissions,
  isGuildAdmin,
  kindOf,
  type MemberLike,
  type MessageLike,
  type OptionLike,
  PLATFORM,
  parseUserIds,
  platform,
  type ResolvedLike,
  resolvedUsers,
  snowflake,
} from "./mapping.js";
export {
  createClient,
  DiscordBotModule,
  intents,
  SHUTDOWN_GRACE_MS,
} from "./module.js";
export { DiscordSendError, DiscordSink, type RestLike, type RestRequest } from "./sink.js";
export {
  buildTree,
  type SlashCommandJson,
  type SlashKind,
  type SlashNode,
  type SlashOptionJson,
  toCreateCommands,
  truncate,
} from "./slash.js";
export { MAX_MESSAGE_LEN, splitMessage } from "./split.js";
export {
  currentCommands,
  runSyncLoop,
  SYNC_DEBOUNCE_MS,
  type SyncLoopOptions,
  type SyncRest,
  syncCommands,
} from "./sync.js";
