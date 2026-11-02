// Her intents (from the mind loop) as turns she starts herself.
//
// * `chat.start` / `chat.dm`: she only wants to talk. The gate decides (consent, approach and
//   DM opt-outs, strangers, rate limits); its executor hands the intent to the context's
//   coordinator, which opens her turn (principal `self`, with tools) once the context is free.
// * Any other capability (join voice, go live, switch scene, ...): the action runs through the
//   gate first (principal `self`); if it succeeds and she has something to say, her turn opens
//   where she now is: the voice channel she joined (once she is in it) or the intent's context.

import type { ActuatorRegistry } from "@miyoria/actions";
import { errorMessage } from "@miyoria/kernel";
import {
  CHAT_DM,
  CHAT_START,
  type ContextKey,
  type Intent,
  type IntentOutcome,
  type IntentSink,
  isJsonObject,
  type JsonValue,
  newId,
  Principals,
  type TalkCeiling,
  type TurnId,
} from "@miyoria/types";
import { modeLabel } from "./levels.js";
import type { Agent, IntentTurn } from "./runtime.js";

export class AgentIntents implements IntentSink {
  /** Intent turns waiting for their `chat.*` capability to run, by turn id. */
  readonly #waiting = new Map<TurnId, IntentTurn>();

  constructor(
    private readonly agent: Agent,
    private readonly registry: () => ActuatorRegistry,
  ) {}

  /** The intent turn a `chat.*` executor runs for `turn`, if it came through `submit`. */
  take(turn: TurnId | null): IntentTurn | null {
    if (turn === null) return null;
    const input = this.#waiting.get(turn) ?? null;
    this.#waiting.delete(turn);
    return input;
  }

  /** The level of a text channel and whether it lets her start talking there now. */
  ceiling(context: ContextKey): TalkCeiling | null {
    if (context.kind === "voice" || context.kind === "dm") return null;
    const mode = this.agent.handle.channelMode(context);
    return { mode, label: modeLabel(mode), blocked: this.agent.startBlocked(context) };
  }

  async submit(intent: Intent, signal?: AbortSignal): Promise<IntentOutcome> {
    const now = this.agent.ctx.clock.now();
    if (now >= Date.parse(intent.expires_at)) {
      return { status: "dropped", detail: "expired", turn: null };
    }
    const registry = this.registry();
    const turn = newId();
    const capability = registry.get(intent.capability);
    const input: IntentTurn = {
      intent,
      turn,
      done: null,
      summary: capability?.summary ?? null,
    };
    const request = {
      principal: Principals.self(intent.context, null),
      capability: intent.capability,
      args: intent.args,
      why: intent.why === "" ? null : intent.why,
      turn,
      about: intent.about,
    };
    const talkOnly = intent.capability === CHAT_START || intent.capability === CHAT_DM;
    if (talkOnly) this.#waiting.set(turn, input);
    let outcome: Awaited<ReturnType<ActuatorRegistry["invoke"]>>;
    try {
      outcome = await registry.invoke(
        request,
        talkOnly ? { signal } : { signal, priority: "initiative" },
      );
    } catch (error) {
      return { status: "failed", detail: errorMessage(error), turn };
    } finally {
      this.#waiting.delete(turn);
    }
    switch (outcome.status) {
      case "denied":
        return { status: "denied", detail: outcome.decision.reason, turn };
      case "failed":
        return { status: "failed", detail: outcome.error, turn };
      case "done":
        break;
    }
    const result = outcome.result;
    if (talkOnly) return { status: "started", detail: result.text, turn };
    const opening = intent.opening?.trim() ?? "";
    if (opening === "") return { status: "done", detail: result.text, turn };
    const talk: IntentTurn = { ...input, done: result.text };
    const joined = intent.capability === "voice.join" ? joinedContext(intent, result.data) : null;
    if (joined !== null) {
      this.agent.deliverOnArrival(joined, talk);
      return { status: "started", detail: result.text, turn };
    }
    const where = intent.context;
    if (where === null) return { status: "done", detail: result.text, turn };
    const why = this.agent.deliverIntent(where, talk);
    return why === null
      ? { status: "started", detail: result.text, turn }
      : { status: "done", detail: `${result.text} (not talking: ${why})`, turn };
  }
}

/** The voice context `voice.join` put her in (its result carries the channel id). */
function joinedContext(intent: Intent, data: JsonValue): ContextKey | null {
  const channel = isJsonObject(data) ? data.channel : null;
  if (typeof channel !== "string" || channel === "") return null;
  const guild =
    typeof intent.args.guild === "string" && intent.args.guild !== ""
      ? intent.args.guild
      : (intent.context?.scope ?? null);
  if (guild === null) return null;
  return {
    platform: intent.context?.platform ?? "discord",
    scope: guild,
    channel,
    kind: "voice",
  };
}
