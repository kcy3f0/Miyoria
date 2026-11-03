// The one place that imports the module packages. Names mirror the legacy Rust constructors
// (camelCased); if a package exported something else, fix it here and nowhere else.
//
// Boot order (legacy `boot.rs`): llm, speech, voice.link, voice, scheduler, agent, commands,
// auth, actions, social, mood, world, self, memory, initiative, mind, knowledge, conversation,
// reflect, queue, game, game.chat, sing, mcp,
// stage.link, sandbox (opt-in), recorder, Discord bot, Admin API, terminal chat, then the
// extension host and one `ext.<id>` per extension.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ActionsModule } from "@miyoria/actions";
import { AgentModule, PersonaHandleKey } from "@miyoria/agent";
import { ApiModule, avatarEmotions } from "@miyoria/api";
import { AuthConfigSchema, AuthModule } from "@miyoria/auth";
import { CommandsModule } from "@miyoria/commands";
import { DiscordBotModule } from "@miyoria/discord";
import * as extHost from "@miyoria/ext-host";
import { GameChatModule, GameHandleKey, GameModule } from "@miyoria/game";
import { InitiativeModule } from "@miyoria/initiative";
import type { Config, Module } from "@miyoria/kernel";
import { ConversationModule, KnowledgeModule, ReflectModule } from "@miyoria/learning";
import {
  type LlmConfig,
  LlmConfigSchema,
  LlmModule,
  type ModelRef,
  OpenAiFactory,
  parseModelRef,
} from "@miyoria/llm";
import { McpModule } from "@miyoria/mcp";
import { EmbeddingConfigSchema, MemoryModule } from "@miyoria/memory";
import { MindModule } from "@miyoria/mind";
import type { Profile } from "@miyoria/profile";
import { QueueModule } from "@miyoria/queue";
import { SandboxModule } from "@miyoria/sandbox";
import { SchedulerModule } from "@miyoria/scheduler";
import { SelfModule } from "@miyoria/self";
import { SingModule } from "@miyoria/sing";
import { MoodModule, SocialModule } from "@miyoria/social";
import { SpeechConfigSchema, SpeechModule } from "@miyoria/speech";
import { AvatarProfile, parseStageConfig, runStage, StageLinkModule } from "@miyoria/stage";
import { openStore as openStoreBackend, type Store } from "@miyoria/store";
import { isJsonObject } from "@miyoria/types";
import { VoiceLinkModule, VoiceModule } from "@miyoria/voice";
import { WorldModule } from "@miyoria/world";
import {
  buildCoreWith,
  type Core,
  type CoreOptions,
  type ExtensionDiscovery,
  type ModuleCatalog,
  type ModuleDeps,
} from "./boot.js";
import type { ExtensionsCli } from "./ext-cli.js";
import { loadProfile, sqlitePath } from "./settings.js";

/**
 * Opens the store for `url`: `sqlite:<path>` (default, the parent directory is created),
 * `memory://`, or `postgres://...`.
 */
export async function openStore(url: string): Promise<Store> {
  const path = sqlitePath(url);
  if (path !== null && path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  return openStoreBackend(url);
}

/** The `llm` module with the profile's `[llm.purposes]` applied over the global ones. */
export function llmModule(config: Config, profile: Profile): LlmModule {
  const llm: LlmConfig = config.get("llm", LlmConfigSchema);
  const overrides = new Map<string, ModelRef[]>();
  for (const [purpose, chain] of Object.entries(profile.manifest.llm.purposes)) {
    try {
      overrides.set(purpose, chain.map(parseModelRef));
    } catch (error) {
      throw new Error(
        `profile \`${profile.id}\` purpose \`${purpose}\`: ${(error as Error).message}`,
        {
          cause: error,
        },
      );
    }
  }
  return new LlmModule(llm, [new OpenAiFactory()], { purposeOverrides: overrides });
}

/**
 * `[modules.auth] owners`. Owners belong in `[modules.commands] owners`; the auth section is
 * still read so both the RBAC and the fallback permissions see the same owners.
 */
export function authOwners(config: Config): string[] {
  const parsed = AuthConfigSchema.safeParse(config.module(AuthModule.ID).config ?? {});
  return parsed.success ? parsed.data.owners : [];
}

async function coreModules({ config, profile, profileId, baseDir }: ModuleDeps): Promise<Module[]> {
  return [
    llmModule(config, profile),
    SpeechModule.withDefaultFactories(config.get("speech", SpeechConfigSchema)),
    new VoiceLinkModule(),
    new VoiceModule(profileId, profile.voice),
    new SchedulerModule(),
    new AgentModule(profile),
    new CommandsModule({ owners: authOwners(config) }),
    new AuthModule(),
    new ActionsModule(profile.displayName),
    SocialModule.fromProfile(profile),
    new MoodModule(profileId, profile.manifest.mood),
    new WorldModule({
      interests: profile.manifest.interests,
      game: (services) => services.get(GameHandleKey)?.status()?.game_name ?? null,
    }),
    new SelfModule(profileId, { temperament: profile.manifest.temperament }),
    new MemoryModule(profileId, config.get("memory.embedding", EmbeddingConfigSchema)),
    new InitiativeModule(profileId),
    new MindModule(profileId, {
      name: profile.displayName,
      persona: (services) =>
        services.get(PersonaHandleKey)?.personaPrompt() ?? profile.personaPrompt(),
    }),
    new KnowledgeModule(profileId),
    new ConversationModule(profileId),
    new ReflectModule(profileId, {
      name: profile.displayName,
      names: profile.names(),
      persona: (services) =>
        services.get(PersonaHandleKey)?.personaPrompt() ?? profile.personaPrompt(),
    }),
    new QueueModule(),
    GameModule.fromProfile(profile),
    new GameChatModule(),
    new SingModule(null, { baseDir }),
    McpModule.fromAppConfig(config),
    new StageLinkModule(),
    new SandboxModule(profileId, { baseDir }),
  ];
}

async function discoverExtensions(config: Config, baseDir: string): Promise<ExtensionDiscovery> {
  const found = extHost.discover(config, baseDir);
  return { skipped: found.skipped, modules: found.modules };
}

export const defaultCatalog: ModuleCatalog = {
  openStore,
  coreModules,
  discord: () => new DiscordBotModule(),
  api: (deps) => new ApiModule({ emotions: avatarEmotions(deps.profile.avatar) }),
  discoverExtensions,
};

/** Builds a core node from `config` with every module package. */
export function buildCore(config: Config, options: CoreOptions = {}): Promise<Core> {
  return buildCoreWith(defaultCatalog, config, options);
}

/** `miyoria stage`: runs the stage node (VTube Studio, OBS, overlay) until `signal` aborts. */
export async function runStageNode(
  config: Config,
  options: {
    baseDir?: string;
    signal?: AbortSignal;
    /** Overlay build to serve when `[stage] overlay_dir` is not set (e.g. the npm bundle's). */
    overlayDir?: string;
  } = {},
): Promise<void> {
  const baseDir = options.baseDir ?? process.cwd();
  const profile = await loadProfile(config, baseDir);
  const avatar =
    profile.avatar !== null
      ? AvatarProfile.load(join(profile.dir, "avatar.toml"))
      : new AvatarProfile();
  const section = config.section("stage") ?? {};
  const explicit = isJsonObject(section) && typeof section.overlay_dir === "string";
  const stage = parseStageConfig(
    explicit || options.overlayDir === undefined
      ? section
      : { ...(isJsonObject(section) ? section : {}), overlay_dir: options.overlayDir },
    avatar,
  );
  await runStage(stage, options.signal ? { signal: options.signal } : {});
}

/** Offline extension tools for `miyoria ext ...` (legacy `miyoria_ext_host::cli`). */
export const extensionsCli: ExtensionsCli = {
  newExtension: async (parent, name, options) => extHost.newExtension(parent, name, options),
  list: async (config, base) => extHost.list(config, base),
  install: async (config, base, source) => extHost.install(config, base, source),
  validate: async (dir) => extHost.validate(dir),
};
