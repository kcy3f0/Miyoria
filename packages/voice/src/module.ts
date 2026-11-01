// Module `voice`: listening and speaking in voice channels.

import { type CommandRegistry, CommandRegistryKey } from "@miyoria/commands";
import {
  defineManifest,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { SpeechServiceKey } from "@miyoria/speech";
import { SettingsStoreKey } from "@miyoria/store";
import { type JsonObject, type ProfileId, VoiceSinkKey } from "@miyoria/types";
import { BargeIn } from "./barge.js";
import { registerCommands, unregisterCommands } from "./commands.js";
import { VoiceConfigSchema, VoiceProfile } from "./config.js";
import { Consent } from "./consent.js";
import { type VoiceLink, VoiceLinkKey } from "./link/link.js";
import { VoiceLinkModule } from "./link/module.js";
import { Listener } from "./listen.js";
import { Speaker } from "./sink.js";
import { Semaphore } from "./util.js";

/**
 * Module `voice`: listens in voice channels (VAD → ASR → `voice_utterance`) and speaks
 * (`VoiceSink` → TTS → playback), with consent, barge-in and the `join` / `leave` /
 * `voice consent` commands.
 *
 * Requires `voice.link` (`VoiceLinkKey`) and `speech` (`SpeechServiceKey`); uses the
 * `SettingsStore` for consent flags and the `CommandRegistry` for commands when available.
 */
export class VoiceModule implements Module {
  static readonly ID = "voice";
  readonly manifest = defineManifest(VoiceModule.ID, "Voice", {
    description: "Listens and speaks in voice channels",
    requires: [VoiceLinkModule.ID, "speech"],
    optional: ["commands"],
    configSchema: VoiceConfigSchema,
  });
  readonly #profileId: ProfileId;
  readonly #voice: JsonObject | null;
  #link: VoiceLink | null = null;
  #registry: CommandRegistry | null = null;

  /** `voice` is the profile's `voice.toml` (`Profile.voice`). */
  constructor(profileId: ProfileId, voice: JsonObject | null) {
    this.#profileId = profileId;
    this.#voice = voice;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(VoiceConfigSchema);
    const profile = VoiceProfile.parse(this.#profileId, this.#voice);
    const link = ctx.services.require(VoiceLinkKey);
    const speech = ctx.services.require(SpeechServiceKey);
    const store = ctx.services.get(SettingsStoreKey) ?? null;
    if (store === null) {
      ctx.log.warn("no settings store: voice consent choices are kept in memory only");
    }
    const consent = new Consent(config.consent, store, ctx.clock);
    const barge = new BargeIn(config.barge_in, config.barge_in_ms, config.barge_in_fade_ms);

    if (!speech.hasTts()) ctx.log.warn("no TTS provider configured: she cannot speak");
    ctx.provide(VoiceSinkKey, new Speaker({ ctx, link, speech, profile, config, barge }));

    if (speech.hasAsr()) {
      const listener = new Listener({
        ctx,
        link,
        speech,
        consent,
        config,
        barge,
        asrSlots: new Semaphore(Math.max(1, config.asr_concurrency)),
      });
      const audio = link.subscribeAudio(ctx.signal);
      ctx.spawn("listen", (signal) => listener.run(audio, signal));
    } else {
      ctx.log.warn("no ASR provider configured: she cannot listen");
    }

    const registry = ctx.services.get(CommandRegistryKey) ?? null;
    this.#link = link;
    this.#registry = registry;
    if (registry) registerCommands(registry, link, consent);
    ctx.log.info({ voice: profile.voice, consent: config.consent }, "voice module running");
  }

  async stop(): Promise<void> {
    const registry = this.#registry;
    this.#registry = null;
    if (registry) unregisterCommands(registry);
  }

  async health(): Promise<Health> {
    const link = this.#link;
    if (link && !link.isConnected()) {
      return { status: "degraded", reason: "voice node not connected" };
    }
    return HEALTHY;
  }
}
