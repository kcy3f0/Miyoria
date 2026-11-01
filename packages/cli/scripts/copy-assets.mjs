// Build step: bundles the repo's `profiles/` into `assets/profiles/` so the published package can
// scaffold a working install (`npx miyoria init`) without a git clone.

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "..", "..", "profiles");
const target = join(root, "assets", "profiles");

if (!existsSync(source)) {
  console.error(`copy-assets: ${source} not found`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
// Third-party assets (Live2D models, voice samples) are local-only (see the root .gitignore).
const localOnly = (path) => {
  const p = path.replaceAll("\\", "/");
  return /\/avatar\/model(\/|$)/.test(p) || /\/voice\/[^/]+\.(wav|txt)$/.test(p);
};
cpSync(source, target, { recursive: true, filter: (src) => !localOnly(src) });
console.log(`copy-assets: ${source} -> ${target}`);
