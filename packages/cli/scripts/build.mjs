// Build of the published `miyoria` package.
//
// Every `@miyoria/*` workspace package is bundled into `dist/` with esbuild, resolved from source
// through the `@miyoria/source` export condition (no per-package build needed). Third-party
// packages stay external and must be listed in this package's `dependencies`, so npm installs
// them (native ones like `@node-rs/jieba` included); the build fails if one is missing.
//
// Code splitting keeps the lazy `await import("@miyoria/core")` calls lazy: `miyoria --help`
// does not load the core. All chunks sit directly in `dist/`, so code that locates files
// relative to `import.meta.url` keeps working:
//   - `src/assets.ts`: `new URL("..", import.meta.url)` -> package root (`templates/`,
//     `assets/profiles/`, `package.json`)
//   - `@miyoria/store`: `../migrations/{sqlite,postgres}/` -> `<package>/migrations/`
//
// Copied next to the bundle:
//   - `assets/profiles/`  <- repo `profiles/` (without local-only third-party assets)
//   - `migrations/`       <- `packages/store/migrations/`
//   - `dist/panel/`       <- `apps/panel/dist/` (build it first: `pnpm --filter @miyoria/panel build`)
//   - `dist/overlay/`     <- `apps/overlay/dist/` (`pnpm --filter @miyoria/overlay build`)

import { chmodSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Keeps every bare import except `@miyoria/*` external. */
const externalThirdParty = {
  name: "external-third-party",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === "entry-point" || args.path.startsWith("@miyoria/")) return undefined;
      if (/^[A-Za-z]:[\\/]/.test(args.path)) return undefined; // Windows absolute path
      return { path: args.path, external: true };
    });
  },
};

rmSync(join(root, "dist"), { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: { main: "src/main.ts", index: "src/index.ts" },
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node24",
  conditions: ["@miyoria/source"],
  plugins: [externalThirdParty],
  chunkNames: "chunk-[hash]",
  sourcemap: "linked",
  sourcesContent: false,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

// Every external import must be a declared dependency (or a Node built-in).
const missing = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imp of output.imports) {
    if (!imp.external) continue;
    if (imp.path.startsWith("node:")) continue;
    const name = packageName(imp.path);
    if (!declared.has(name)) missing.add(name);
  }
}
if (missing.size > 0) {
  console.error(
    `build: bundled code imports packages missing from packages/cli dependencies: ${[...missing].sort().join(", ")}`,
  );
  process.exit(1);
}
const unused = [...declared].filter(
  (name) =>
    !Object.values(result.metafile.outputs).some((o) =>
      o.imports.some((i) => i.external && packageName(i.path) === name),
    ),
);
if (unused.length > 0)
  console.warn(`build: dependencies not imported by the bundle: ${unused.join(", ")}`);

chmodSync(join(root, "dist", "main.js"), 0o755);

// Profiles. Third-party assets (Live2D models, voice samples) are local-only (see the root
// .gitignore) and never shipped.
const profiles = join(repo, "profiles");
if (!existsSync(profiles)) {
  console.error(`build: ${profiles} not found`);
  process.exit(1);
}
const localOnly = (path) => {
  const p = path.replaceAll("\\", "/");
  return /\/avatar\/model(\/|$)/.test(p) || /\/voice\/[^/]+\.(wav|txt)$/.test(p);
};
rmSync(join(root, "assets", "profiles"), { recursive: true, force: true });
cpSync(profiles, join(root, "assets", "profiles"), {
  recursive: true,
  filter: (src) => !localOnly(src),
});

// Store migrations, read at runtime from `<bundle dir>/../migrations/`.
rmSync(join(root, "migrations"), { recursive: true, force: true });
cpSync(join(repo, "packages", "store", "migrations"), join(root, "migrations"), {
  recursive: true,
});

// Admin panel and stream overlay (optional: `miyoria core` / `miyoria stage` run without them).
for (const [app, what, pkg] of [
  ["panel", "the admin panel", "@miyoria/panel"],
  ["overlay", "the stream overlay", "@miyoria/overlay"],
]) {
  const built = join(repo, "apps", app, "dist");
  rmSync(join(root, "dist", app), { recursive: true, force: true });
  if (existsSync(join(built, "index.html"))) {
    cpSync(built, join(root, "dist", app), { recursive: true });
  } else {
    console.warn(
      `build: apps/${app}/dist not built; the package ships without ${what} (run \`pnpm --filter ${pkg} build\` first)`,
    );
  }
}

const files = Object.keys(result.metafile.outputs).filter((f) => f.endsWith(".js"));
console.log(`build: ${files.length} bundle files in dist/, assets/profiles, migrations`);
