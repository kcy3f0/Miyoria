import { defineConfig } from "vitest/config";

// `base: "./"` keeps the asset URLs relative, so the build works wherever it is mounted
// (the Stage serves it at /overlay/, `vite preview` at /, OBS can also open dist/index.html as a file).
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: false },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
