/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Core listens on 127.0.0.1:7878 by default (`[modules.api] bind`).
const core = process.env.MIYORIA_CORE_URL ?? "http://127.0.0.1:7878";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Served by the Core under its own origin; keep asset URLs relative.
  base: "./",
  server: {
    port: 5178,
    proxy: {
      // Same-origin for the browser, so the Discord session cookie works in dev
      // too (register http://localhost:5178/api/auth/oauth/callback and open the panel at http://localhost:5178).
      "/api": { target: core, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
    // No manualChunks: splitting React from the libraries that import it produced circular chunks
    // (React's exports were read before its chunk had run, so the page stayed blank).
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    restoreMocks: true,
  },
});
