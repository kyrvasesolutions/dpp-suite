import { defineConfig } from "vitest/config";
import { buildDefines } from "./config/build.ts";

// Kept apart from vite.config.ts so unit tests don't load the PWA plugin.
export default defineConfig({
  // A fixed commit, so nothing in a test depends on where it runs.
  define: buildDefines("test"),
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/simulation/**/*.test.ts"],
    environment: "jsdom",
    // Records any non-loopback network attempt in node-environment files and fails the file (D8-05).
    setupFiles: ["tests/support/noEgress.ts"],
  },
});
