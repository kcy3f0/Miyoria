import { describe, expect, it } from "vitest";
import {
  collectResponse,
  LlmRouter,
  MockProvider,
  OpenAiConfig,
  ProviderConfigSchema,
  parseModelRef,
  userMessage,
} from "../src/index.js";
import { requestBody } from "../src/openai/wire.js";

const request = () => ({ messages: [userMessage("hi")] });

describe("thinking switch", () => {
  it("router_turns_thinking_off_unless_the_purpose_enables_it", async () => {
    const provider = new MockProvider("p").reply("a").reply("b").reply("c");
    const chain = [parseModelRef("p:m")];
    const router = new LlmRouter(
      new Map([["p", provider]]),
      new Map([
        ["chat", chain],
        ["fast", chain],
      ]),
      { thinking: new Map([["chat", true]]) },
    );
    await collectResponse(await router.stream("fast", request()));
    await collectResponse(await router.stream("chat", request()));
    // An explicit request value wins over the purpose setting.
    await collectResponse(await router.stream("chat", { ...request(), thinking: false }));
    expect(provider.requests().map((r) => r.thinking)).toStrictEqual([false, true, false]);
  });

  it("deepseek_and_opencode_send_their_switch_only_when_off", () => {
    const cfg = (raw: Record<string, unknown>) =>
      OpenAiConfig.fromProviderConfig(ProviderConfigSchema.parse(raw));
    const opencode = cfg({ kind: "opencode", api_key: "k" }).thinkingOff;
    expect(opencode).toStrictEqual({ thinking: { type: "disabled" } });
    expect(cfg({ kind: "deepseek" }).thinkingOff).toStrictEqual({ thinking: { type: "disabled" } });
    // Generic endpoints send nothing unless told what to send.
    expect(cfg({ kind: "openai-compatible", base_url: "http://x" }).thinkingOff).toBeNull();
    expect(
      cfg({
        kind: "openai-compatible",
        base_url: "http://x",
        thinking_off: { chat_template_kwargs: { enable_thinking: false } },
      }).thinkingOff,
    ).toStrictEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(cfg({ kind: "deepseek", thinking_off: {} }).thinkingOff).toBeNull();

    expect(requestBody({ ...request(), thinking: false }, opencode).thinking).toStrictEqual({
      type: "disabled",
    });
    expect(requestBody({ ...request(), thinking: true }, opencode).thinking).toBeUndefined();
    expect(requestBody({ ...request(), thinking: false }, null).thinking).toBeUndefined();
  });
});
