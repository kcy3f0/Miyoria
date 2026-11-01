// `@miyoria/core/light`: the parts of the core that load no module package (config helpers and
// the module id list), for the CLI's offline commands.

export { configuredModules, MODULE_IDS, NEEDS_TOKEN } from "./module-ids.js";
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
