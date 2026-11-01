// @miyoria/commands: platform-agnostic command framework.
//
// Commands are declared once as a `CommandSpec` with a handler and registered in the
// `CommandRegistry`, which the `commands` module provides as the `CommandRegistryKey` service.
// Platform adapters map specs to their own syntax (Discord slash commands, chat `!cmd`, CLI,
// panel), turn calls into an `Invocation` and send back the `CommandReply`.
//
// Permission checks use the `Authorizer` service (the `auth` module's RBAC) when it is
// available. Without it, three fallback roles apply (see `Role`): nodes starting with `owner.`
// need an owner, `admin.` an owner or guild admin, everything else is open to every user.
// Commands with `admin.*` / `owner.*` nodes are written to the `AuditLog` service when there is
// one.

export {
  CommandRegistryKey,
  type CommandsConfig,
  CommandsConfigSchema,
  CommandsModule,
  formatModuleList,
  registerBuiltins,
} from "./module.js";
export { Permissions, parseAccount, ROLE_RANK, type Role, requiredRole } from "./perms.js";
export {
  type AuthorizerPreload,
  AuthorizerPreloadKey,
  CommandArgError,
  type CommandHandler,
  CommandRegistry,
  type CommandRegistryOptions,
  type HandlerResult,
  MAX_PATH_DEPTH,
  normalizeArgs,
  VersionSubscription,
} from "./registry.js";
export {
  ArgKind,
  type ArgSpec,
  type ArgValue,
  argSpec,
  CommandError,
  CommandReply,
  type CommandSpec,
  type CommandSpecOptions,
  commandName,
  commandSpec,
  Invocation,
  type InvocationData,
  type ResolvedUser,
  splitPath,
} from "./spec.js";
