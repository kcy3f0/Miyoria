// @miyoria/kernel: every feature is a `Module`. The `Supervisor` starts modules in dependency
// order, restarts them when they fail and lets them be enabled or disabled at runtime. Modules
// only talk to each other through the `EventBus` and the `ServiceRegistry`, both reached via
// the `ModuleContext` they get in `start`.

export {
  errorMessage,
  interval,
  isAbortError,
  SerialQueue,
  sleep,
  withTimeout,
} from "./async.js";
export {
  DEFAULT_BUS_CAPACITY,
  EventBus,
  type SubscribeOptions,
  Subscription,
  TopicFilter,
  type TopicFilterLike,
} from "./bus.js";
export {
  Config,
  ConfigError,
  type ConfigErrorCode,
  type EnvLookup,
  expandEnv,
  interpolateEnv,
  loadDotenv,
  type ModuleSection,
  parseSection,
  parseTomlJson,
  processEnv,
} from "./config.js";
export { ModuleContext, type PublishOptions, type Task } from "./context.js";
export {
  configureLogging,
  getLogger,
  type LogBindings,
  type LogFn,
  type Logger,
  type LoggingOptions,
  type LogLevel,
  rootLogger,
} from "./log.js";
export {
  defineManifest,
  HEALTHY,
  type Health,
  type ManifestOptions,
  type Module,
  type ModuleManifest,
  type ModuleManifestJson,
  manifestJson,
} from "./module.js";
export { type ServiceLookup, ServiceRegistry, ServiceUnavailableError } from "./services.js";
export {
  MAX_BACKOFF_MS,
  MAX_RESTARTS_IN_WINDOW,
  type ModuleStatus,
  RESTART_WINDOW_MS,
  restartBackoffMs,
  STOP_TIMEOUT_MS,
  Supervisor,
  SupervisorError,
  SupervisorKey,
  type SupervisorOptions,
} from "./supervisor.js";
