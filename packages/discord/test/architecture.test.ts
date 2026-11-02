// Repository-wide rules for Discord output: Components V2 only, no embeds, and command replies
// only through the renderer.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCANNED = ["packages", "apps", "extensions"];
const SKIP = new Set(["node_modules", "dist", ".git", "target", "build", "coverage"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const files = SCANNED.flatMap((d) => sourceFiles(join(ROOT, d)));
const rel = (path: string) => relative(ROOT, path).replaceAll("\\", "/");
const THIS_FILE = rel(fileURLToPath(import.meta.url));

function matching(pattern: RegExp, only: (path: string) => boolean = () => true): string[] {
  return files
    .filter((f) => rel(f) !== THIS_FILE && only(rel(f)))
    .filter((f) => pattern.test(readFileSync(f, "utf8")))
    .map(rel);
}

describe("architecture", () => {
  it("scans_the_workspace", () => {
    expect(files.some((f) => rel(f) === "packages/discord/src/render.ts")).toBe(true);
  });

  it("does_not_use_legacy_discord_embeds", () => {
    expect(matching(/\bEmbedBuilder\b|\bMessageEmbed\b|\bembeds\s*:/)).toEqual([]);
  });

  it("answers_interactions_only_through_the_renderer", () => {
    // Plain `content` replies would bypass Components V2 and the visibility rule.
    const interactionFiles = (p: string) =>
      p === "packages/discord/src/interaction.ts" || p === "packages/discord/src/handler.ts";
    expect(matching(/\bcontent\s*:/, interactionFiles)).toEqual([]);
  });
});
