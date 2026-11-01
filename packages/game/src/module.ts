import { type CommandRegistry, CommandRegistryKey } from "@miyoria/commands";
import { defineManifest, type Module, type ModuleContext } from "@miyoria/kernel";
import type { Profile } from "@miyoria/profile";
import {
  type AccountRef,
  type ContextKey,
  type PromptContributor,
  type PromptContributors,
  PromptContributorsKey,
  type PromptSection,
  serviceKey,
} from "@miyoria/types";
import { registerCommands } from "./commands.js";
import { GameConfigSchema } from "./config.js";
import { Director, type GameStatus, type Persona, View } from "./director.js";

/** Prompt contributor key. */
export const PROMPT_KEY = "game";

/** Read access to the running session (service `GameHandleKey`). */
export class GameHandle {
  readonly #view: View;

  /** @internal */
  constructor(view: View) {
    this.#view = view;
  }

  /** `null` while not playing. */
  status(): GameStatus | null {
    const s = this.#view.current;
    return s ? structuredClone(s) : null;
  }
}

/**
 * Programmatic control of the director (service `GameControlKey`), for the Admin API or tests:
 * the same operations as the commands. Each method resolves with the reply text and rejects
 * with `GameError` (user-facing message) when the request is refused.
 */
export class GameControl {
  readonly #director: Director;

  /** @internal */
  constructor(director: Director) {
    this.#director = director;
  }

  /** Starts a session in `context` (used as-is), acting for `account`. */
  async start(game: string, context: ContextKey, account: AccountRef): Promise<string> {
    return this.#director.start(game, "here", context, account);
  }

  async stop(): Promise<string> {
    return this.#director.stop();
  }

  async goal(text: string, by: string): Promise<string> {
    return this.#director.goal(text, by);
  }
}

export const GameHandleKey = serviceKey<GameHandle>("GameHandle");
export const GameControlKey = serviceKey<GameControl>("GameControl");

function prefix(text: string, chars: number): string {
  return [...text].slice(0, chars).join("");
}

class GamePrompt implements PromptContributor {
  readonly key = PROMPT_KEY;

  constructor(
    private readonly view: View,
    private readonly summaryChars: number,
  ) {}

  async contribute(): Promise<PromptSection[]> {
    const s = this.view.current;
    if (!s) return [];
    let body = `你正在直播玩 ${s.game_name},聊天時可以自然提到遊戲裡的狀況。`;
    body += s.goal ? `\n目前目標:${s.goal.text}${s.goal.note}` : "\n目前沒有特定目標。";
    if (s.backlog.length > 0) body += `\n排隊中的觀眾請求:${s.backlog.join("、")}`;
    if (s.recent.length > 0) body += `\n剛剛:${s.recent.slice(-3).join(";")}`;
    if (s.summary !== "") body += `\n遊戲狀態:\n${prefix(s.summary, this.summaryChars)}`;
    return [{ key: PROMPT_KEY, title: "你正在玩的遊戲", body, order: 45 }];
  }
}

interface Running {
  director: Director;
  commands: { registry: CommandRegistry; paths: string[] } | null;
  prompts: PromptContributors | null;
}

/**
 * Module `game`: the game director. A game adapter extension exposes the tools
 * `game_<id>_observe` / `game_<id>_act` and publishes `game.<id>.*` events; while a session
 * runs (`game start`) the director observes, asks the `game` LLM purpose for goals and actions,
 * comments live (`agent.initiative`, reason `game`), nudges the mood and consumes
 * `queue.item_activated` items of kind `game_goal`.
 *
 * Services used: `ToolRegistry` (required to play), `LlmRouter`, `RequestQueue`,
 * `CommandRegistry`, `PromptContributors` (all optional). Provides `GameHandleKey` and
 * `GameControlKey`.
 */
export class GameModule implements Module {
  static readonly ID = "game";
  readonly manifest = defineManifest(GameModule.ID, "Game director", {
    description: "Slow loop: picks game goals, acts through game adapters, comments live",
    optional: ["llm", "commands", "queue", "extensions"],
    configSchema: GameConfigSchema,
  });
  readonly #persona: Persona;
  #running: Running | null = null;

  /** `name` and `persona` flavour the decisions (the persona is cut to `persona_chars`). */
  constructor(name: string, persona: string) {
    this.#persona = { profile: name, name, text: persona };
  }

  /** Profile id used in the LLM session ids (default: the display name). */
  withProfileId(id: string): this {
    this.#persona.profile = id;
    return this;
  }

  static fromProfile(profile: Profile): GameModule {
    return new GameModule(profile.displayName, profile.personaPrompt()).withProfileId(
      String(profile.id),
    );
  }

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config(GameConfigSchema);
    const view = new View();
    const persona: Persona = {
      ...this.#persona,
      text: prefix(this.#persona.text, cfg.persona_chars),
    };
    const director = new Director(cfg, ctx, persona, view);

    const registry = ctx.services.get(CommandRegistryKey);
    const commands = registry
      ? {
          registry,
          paths: registerCommands(registry, cfg.permissions, cfg.default_game, director, view),
        }
      : null;
    const prompts = ctx.services.get(PromptContributorsKey) ?? null;
    prompts?.register(new GamePrompt(view, cfg.prompt_summary_chars));
    ctx.provide(GameHandleKey, new GameHandle(view));
    ctx.provide(GameControlKey, new GameControl(director));

    const events = ctx.subscribe([
      "game.*",
      "queue.item_activated",
      "voice.joined",
      "voice.left",
      "voice.participants",
    ]);
    ctx.spawn("director", async () => {
      try {
        for await (const env of events) director.onEvent(env);
      } finally {
        director.close();
      }
    });
    this.#running = { director, commands, prompts };
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.director.close();
    if (running.commands) {
      for (const path of running.commands.paths) running.commands.registry.unregister(path);
    }
    running.prompts?.unregister(PROMPT_KEY);
  }
}
