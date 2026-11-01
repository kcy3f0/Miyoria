/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Core listens on 127.0.0.1:7878 by default (`[modules.api] bind`).
const core = process.env.MIYORIA_CORE_URL ?? "http://127.0.0.1:7878";

export default defineConfig({
  plugins: [react()],
  // Served by the Core under its own origin later; keep asset URLs relative.
  base: "./",
  server: {
    port: 5178,
    proxy: {
      "/api": { target: core, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    restoreMocks: true,
  },
});
