// @miyoria/sandbox: module `sandbox`, a Docker code sandbox for code she writes (`code.run`),
// her persistent tools workspace, and tools she proposes (`tool.propose`). See README.md for
// the threat model.

export {
  buildRunArgs,
  CODE_DIR,
  CONTAINER_ENV,
  type ContainerSpec,
  dockerCliEnv,
  ENTRY_FILE,
  entryCommand,
  InvalidSpecError,
  inspectImageArgs,
  killArgs,
  LABEL,
  LABEL_INSTANCE,
  LABEL_RUN,
  listArgs,
  mountArg,
  NAME_PREFIX,
  pullArgs,
  removeArgs,
  TOOLS_DIR,
  versionArgs,
  WORK_DIR,
} from "./args.js";
export {
  CODE_RUN,
  type CodeRunArgs,
  CodeRunArgsSchema,
  summarizeRun,
  TOOL_PROPOSE,
} from "./capabilities.js";
export {
  defaultSandboxConfig,
  IMAGE_REF,
  type SandboxCaps,
  SandboxCapsSchema,
  type SandboxConfig,
  SandboxConfigSchema,
  type SandboxImages,
  SandboxImagesSchema,
  type SandboxLimits,
  SandboxLimitsSchema,
} from "./config.js";
export {
  codeRunCapability,
  formatRun,
  NODE_CODE_RUN,
  NODE_PROPOSED_PREFIX,
  NODE_TOOL_PROPOSE,
  PROPOSED_CAPABILITY_PREFIX,
  PROPOSED_TOOL_PREFIX,
  proposalProblem,
  proposedToolCapability,
  SandboxGate,
  type SandboxGateOptions,
  toolProposeCapability,
} from "./gate.js";
export { SandboxModule, type SandboxModuleOptions } from "./module.js";
export {
  checkName,
  MAX_PATH_DEPTH,
  NAME,
  normalizeRelativePath,
  safeJoin,
} from "./paths.js";
export {
  type ApprovedToolSpec,
  compileArgsSchema,
  MAX_ARGS_BYTES,
  MAX_SCHEMA_BYTES,
  type ProposedTool,
  type ProposedToolStatus,
  ProposedTools,
  ProposedToolsKey,
  type ProposedToolsOptions,
  TOOL_KEY_PREFIX,
  type ToolProposal,
  ToolProposalSchema,
} from "./proposed.js";
export {
  type DockerRunner,
  type ExecOptions,
  type ExecResult,
  ProcessDockerRunner,
} from "./runner.js";
export {
  CONTROL_TIMEOUT_MS,
  DockerSandbox,
  type DockerSandboxOptions,
  type ImageCheck,
  instanceId,
  KILL_GRACE_MS,
  resolveUser,
  type SandboxPublisher,
} from "./sandbox.js";
export { Semaphore } from "./semaphore.js";
export {
  type FileIn,
  type FileOut,
  type KilledReason,
  LANGUAGES,
  type Language,
  type NetworkPolicy,
  type RunRequest,
  type RunResult,
  type Sandbox,
  SandboxError,
  type SandboxErrorKind,
  type SandboxHealth,
  SandboxKey,
  type ScriptInfo,
  type ToolsWorkspaceApi,
} from "./types.js";
export {
  collectOutputs,
  createRunDirs,
  pruneRuns,
  type RunDirs,
  ToolsWorkspace,
  writeInputs,
} from "./workspace.js";
