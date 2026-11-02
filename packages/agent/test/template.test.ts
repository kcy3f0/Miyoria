// The config templates' `[modules.agent]` and `[llm]` sections parse with the schemas.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "@miyoria/kernel";
import { LlmConfigSchema } from "@miyoria/llm";
import { describe, expect, it } from "vitest";
import { AgentConfigSchema } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("config templates", () => {
  for (const file of ["miyoria.example.toml", "packages/cli/templates/miyoria.example.toml"]) {
    it(`parses_${file}`, () => {
      const config = Config.fromToml(readFileSync(join(ROOT, file), "utf8"), () => undefined);
      const agent = AgentConfigSchema.parse(config.module("agent").config ?? {});
      expect(agent.voice.text_chat).toBe(true);
      expect(agent.history.backfill).toBe(20);
      expect(agent.vision.max_images).toBe(3);
      expect(LlmConfigSchema.parse(config.section("llm")).image_input).toEqual({});
    });
  }
});
