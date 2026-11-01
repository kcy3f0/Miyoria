// @miyoria/core: wires config, store, profile and every module into a running core node
// (legacy `apps/miyoria/src/boot.rs` + `cli_platform.rs`).

export {
  buildCoreWith,
  Core,
  type CoreOptions,
  type DiscoveredExtension,
  type ExtensionDiscovery,
  type ModuleCatalog,
  type ModuleDeps,
  ProfileIdKey,
  runUntilSignal,
  shutdownSignal,
} from "./boot.js";
export { CLI_PLATFORM, CliPlatform, type CliPlatformOptions } from "./cli-platform.js";
export type {
  ExtensionListing,
  ExtensionManifestInfo,
  ExtensionsCli,
  ExtensionValidation,
  InstalledExtension,
  NewExtensionOptions,
} from "./ext-cli.js";
export { configuredModules, MODULE_IDS, NEEDS_TOKEN } from "./module-ids.js";
export {
  buildCore,
  defaultCatalog,
  extensionsCli,
  llmModule,
  openStore,
  runStageNode,
} from "./modules.js";
export { RecorderModule } from "./recorder.js";
export {
  type CoreLogLevel,
  DEFAULT_DATABASE_URL,
  DEFAULT_PROFILE,
  DEFAULT_PROFILES_DIR,
  databaseUrl,
  loadProfile,
  logFilter,
  logLevel,
  ProfileLoadError,
  profileId,
  profilesDir,
  resolveDatabaseUrl,
  sqlitePath,
} from "./settings.js";
