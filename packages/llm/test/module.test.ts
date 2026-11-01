import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import { describe, expect, it } from "vitest";
import {
  type ChatProvider,
  LlmConfigSchema,
  LlmModule,
  LlmRouterKey,
  MockProvider,
  type ProviderFactory,
  parseModelRef,
  USAGE_PROFILE,
  userMessage,
} from "../src/index.js";

const mockFactory = (provider: ChatProvider): ProviderFactory => ({
  kinds: ["mock"],
  build: () => provider,
});

describe("LlmModule", () => {
  it("provides the router, announces the budget and persists usage on stop", async () => {
    const config = LlmConfigSchema.parse({
      providers: { m: { kind: "mock", some_setting: 1 } },
      purposes: { chat: ["m:model-a"] },
      pricing: { "m:model-a": { output_per_mtok: 1_000_000 } },
      budget: { daily_usd: 100 },
    });
    expect(config.providers.m).toEqual({
      kind: "mock",
      base_url: null,
      api_key: null,
      extra: { some_setting: 1 },
    });
    const mock = new MockProvider("m").reply("嗨");
    const llm = new LlmModule(config, [mockFactory(mock)], {
      purposeOverrides: new Map([["fast", [parseModelRef("m:model-fast")]]]),
    });
    const sup = new Supervisor();
    const store = new MemorySettingsStore();
    sup.services.provide("kernel", SettingsStoreKey, store);
    const budgetEvents = sup.bus.subscribe("llm.budget");
    await sup.register(llm, null, true);
    await sup.startAll();

    const router = sup.services.require(LlmRouterKey);
    expect((await router.complete("chat", { messages: [userMessage("hi")] })).text).toBe("嗨");
    await router.complete("fast", { messages: [] });
    expect(mock.requests().map((r) => r.model)).toEqual(["model-a", "model-fast"]);

    const announced = budgetEvents.tryRecv();
    expect(announced?.source).toBe("llm");
    expect(announced?.event).toMatchObject({
      type: "custom",
      data: { topic: "llm.budget", payload: { state: "ok", daily_usd: 100 } },
    });

    await sup.disable("llm");
    expect(sup.services.get(LlmRouterKey)).toBeUndefined();
    const saved = await store.list(USAGE_PROFILE, "llm_usage:");
    expect(saved.size).toBe(2);
  });

  it("fails to start with an unknown provider kind", async () => {
    const config = LlmConfigSchema.parse({ providers: { x: { kind: "nope" } } });
    const sup = new Supervisor();
    await sup.register(new LlmModule(config, []), null, true);
    await sup.startAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(sup.list()[0]).toMatchObject({
      state: "failed",
      reason: "start failed: provider `x`: unknown kind `nope`",
    });
    await sup.stopAll();
  });
});
