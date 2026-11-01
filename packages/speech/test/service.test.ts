// `SpeechService` fallback chains and their request counters.

import { MetricsRegistry } from "@miyoria/kernel";
import { describe, expect, it } from "vitest";
import {
  type AsrProvider,
  type AudioStream,
  NO_HINT,
  SpeechService,
  type TtsProvider,
  ttsRequest,
} from "../src/index.js";

const audio = { sampleRate: 16_000, samples: new Int16Array(160) };

function asr(name: string, fail: boolean): AsrProvider {
  return {
    name,
    transcribe: async () => {
      if (fail) throw new Error(`${name} down`);
      return { text: "你好", language: "zh", emotion: null, audio_events: [] };
    },
  };
}

function tts(name: string, fail: boolean): TtsProvider {
  return {
    name,
    synthesize: async (): Promise<AudioStream> => {
      if (fail) throw new Error(`${name} down`);
      return (async function* () {})();
    },
  };
}

describe("SpeechService", () => {
  it("counts every attempt by provider and outcome", async () => {
    const registry = new MetricsRegistry();
    const service = new SpeechService(
      [asr("a", true), asr("b", false)],
      [tts("x", true), tts("y", false)],
      { metrics: registry },
    );
    expect((await service.transcribe(audio, NO_HINT))[0]).toBe("b");
    expect((await service.synthesize(ttsRequest("嗨")))[0]).toBe("y");

    const controller = new AbortController();
    controller.abort();
    const cancelled = new SpeechService([asr("a", true)], [], { metrics: registry });
    await expect(cancelled.transcribe(audio, NO_HINT, controller.signal)).rejects.toThrow("a down");

    const asrCount = registry.counter("miyoria_asr_requests_total", {
      help: "",
      labels: ["provider", "outcome"],
    });
    const ttsCount = registry.counter("miyoria_tts_requests_total", {
      help: "",
      labels: ["provider", "outcome"],
    });
    expect(asrCount.get({ provider: "a", outcome: "error" })).toBe(1);
    expect(asrCount.get({ provider: "a", outcome: "aborted" })).toBe(1);
    expect(asrCount.get({ provider: "b", outcome: "ok" })).toBe(1);
    expect(ttsCount.get({ provider: "x", outcome: "error" })).toBe(1);
    expect(ttsCount.get({ provider: "y", outcome: "ok" })).toBe(1);
  });
});
