// Shared Vitest settings for Node packages. Every package's `vitest.config.ts` uses `nodeProject()`.
//
// `@miyoria/source` is the export condition that maps a workspace package to its `src/index.ts`,
// so tests run against source without building dependencies first. Vite replaces its default
// conditions when `conditions` is set, so the defaults are listed again after ours.
import { defineProject, mergeConfig, type ViteUserConfig } from "vitest/config";

export const SOURCE_CONDITION = "@miyoria/source";

const serverConditions = [SOURCE_CONDITION, "module", "node", "development|production"];

export function nodeProject(overrides: ViteUserConfig = {}): ViteUserConfig {
  return mergeConfig(
    defineProject({
      resolve: { conditions: serverConditions },
      ssr: { resolve: { conditions: serverConditions, externalConditions: [SOURCE_CONDITION] } },
      test: {
        include: ["test/**/*.test.ts", "src/**/*.test.ts"],
        environment: "node",
        restoreMocks: true,
        unstubEnvs: true,
      },
    }),
    overrides,
  );
}
