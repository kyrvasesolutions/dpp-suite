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
    ssr: true,
    outDir: "dist-server",
    emptyOutDir: true,
    target: "node24",
    rollupOptions: {
      external: (id) => nodeExternals.has(id),
      // The server and the ingress worker it spawns (D8-10) are two entries of one build: dist-server/server.mjs and ingressWorker.mjs.
      input: { server: "server/index.ts", ingressWorker: "server/jobs/ingressWorker.ts" },
      output: {
        entryFileNames: "[name].mjs",
        chunkFileNames: "chunk-[hash].mjs",
        format: "es",
      },
    },
  },
});
