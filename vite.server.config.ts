/**
 * Vite SSR/Node build configuration for the Cycle 6 Node 24 API service (`server/index.ts`).
 * Bundles `server/` + shared `src/model/` pure TypeScript modules into `dist-server/server.mjs`
 * while keeping Node built-ins (`node:*`) and runtime npm packages external.
 */
import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const nodeExternals = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "node:sqlite",
  "pdf-lib",
  "yaml",
  "zod",
]);

export default defineConfig({
  build: {
    ssr: "server/index.ts",
    outDir: "dist-server",
    emptyOutDir: true,
    target: "node24",
    rollupOptions: {
      external: (id) => nodeExternals.has(id),
      output: {
        entryFileNames: "server.mjs",
        format: "es",
      },
    },
  },
});
